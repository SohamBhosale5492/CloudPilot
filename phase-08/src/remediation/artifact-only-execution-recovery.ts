import { mutationRequestHash } from "../github/internal-mutation-boundary.js";
import {
  isAuthorizedArtifactGitHubCapability, isLeaseGuardForCapability, type GitHubExecutionCapabilityService
} from "../github/github-execution-capability.js";
import type { RemediationLease } from "../jobs/remediation-repo.js";
import {
  isPersistedUnresolvedExecutionIntent, RemediationExecutionPersistenceError,
  type RemediationExecutionPersistenceService, type UnresolvedExecutionIntent
} from "./remediation-execution-persistence.js";
import { isTrustedClaimExecutionContext, type TrustedClaimExecutionContext } from "./trusted-claim-execution-context.js";
import { ArtifactOnlyGitHubWriter } from "./artifact-only-github-writer.js";
import { ArtifactOnlyGitHubDraftPrPublisher, deriveRemediationBranchName } from "./artifact-only-github-draft-pr-publisher.js";

export type ExecutionRecoveryOutcome =
  | { readonly kind: "verified"; readonly executionId: string; readonly stage: string; readonly operationKey: string }
  | { readonly kind: "manual_review"; readonly executionId: string; readonly stage: string; readonly reason: string }
  | { readonly kind: "skipped"; readonly executionId: string; readonly stage: string; readonly reason: string };

interface ContextProvider { prepare(lease: RemediationLease): Promise<TrustedClaimExecutionContext | null> }

/**
 * Restart-safe, read-only reconciliation of durable mutation intents. This service never calls a
 * GitHub write method. Tree and commit intents remain manual-review-only because GitHub does not
 * provide a sufficiently scoped lookup for an unreferenced result whose immutable SHA was lost.
 */
export class ArtifactOnlyExecutionRecoveryService {
  constructor(
    private readonly persistence: RemediationExecutionPersistenceService,
    private readonly contexts: ContextProvider,
    private readonly capabilities: GitHubExecutionCapabilityService,
    private readonly writer: ArtifactOnlyGitHubWriter,
    private readonly publisher: ArtifactOnlyGitHubDraftPrPublisher
  ) {}

  async recover(actorIdentityUserId: string, limit = 100): Promise<readonly ExecutionRecoveryOutcome[]> {
    const candidates = await this.persistence.discoverUnresolvedIntents(limit);
    const outcomes: ExecutionRecoveryOutcome[] = [];
    for (const candidate of candidates) outcomes.push(await this.recoverOne(candidate, actorIdentityUserId));
    return Object.freeze(outcomes);
  }

  private async recoverOne(candidate: UnresolvedExecutionIntent, actorIdentityUserId: string): Promise<ExecutionRecoveryOutcome> {
    const stage = candidate.identity.stage;
    if (!isPersistedUnresolvedExecutionIntent(candidate)) return skipped(candidate, "untrusted_candidate");
    if (!isValidExecutionRecoveryIntent(candidate)) return this.manualize(candidate, actorIdentityUserId, "ambiguous_remote_operation");

    // The API cannot identify an unreferenced tree/commit created before its response was lost.
    // A hash-only or parent-only match is not proof of the exact mutation result.
    if (executionRecoveryPolicy(stage) === "manual_review_only") {
      return this.manualize(candidate, actorIdentityUserId, stage === "tree" ? "ambiguous_tree_write" : "ambiguous_commit_write");
    }

    let context: TrustedClaimExecutionContext | null;
    try { context = await this.contexts.prepare(candidate.lease); }
    catch { context = null; }
    if (!context) return this.manualize(candidate, actorIdentityUserId, "claim_not_authorized");
    let capability;
    try { capability = await this.capabilities.issue(candidate.lease); }
    catch { capability = null; }
    if (!isAuthorizedArtifactGitHubCapability(capability)) {
      return this.manualize(candidate, actorIdentityUserId, "claim_not_authorized");
    }
    const guard = this.capabilities.leaseGuardFor(capability);
    if (!isLeaseGuardForCapability(guard, capability)) {
      return this.manualize(candidate, actorIdentityUserId, "lease_guard_unavailable");
    }
    let session;
    try { session = await this.persistence.resumeForRecovery(candidate); }
    catch { session = null; }
    if (!session) return this.manualize(candidate, actorIdentityUserId, "lease_lost");

    if (stage === "pull_request_close") return this.recoverClosedPr(candidate, actorIdentityUserId, capability);

    let receipt: object | null = null;
    try {
      if (stage === "blob") receipt = await this.writer.recoverBlobMutation({ context, capability, leaseGuard: guard,
        identity: candidate.identity });
      else if (stage === "branch") receipt = await this.publisher.recoverBranchMutation({ capability, leaseGuard: guard,
        identity: candidate.identity, persistedCommitSha: candidate.commitSha });
      else if (stage === "pull_request") receipt = await this.publisher.recoverDraftPullRequestMutation({ capability,
        leaseGuard: guard, identity: candidate.identity, persistedCommitSha: candidate.commitSha,
        persistedBranchName: candidate.branchName });
    } catch { receipt = null; }
    if (!receipt) return this.manualize(candidate, actorIdentityUserId, failureCode(stage));

    try {
      const freshContext = await this.contexts.prepare(candidate.lease);
      if (!isTrustedClaimExecutionContext(freshContext) || freshContext.tenantId !== capability.tenantId ||
          freshContext.organizationId !== capability.organizationId || freshContext.projectId !== capability.projectId ||
          freshContext.repositoryBindingId !== capability.repositoryBindingId ||
          freshContext.installationRecordId !== capability.installationRecordId ||
          freshContext.githubRepositoryId !== capability.repositoryId || freshContext.artifactHash !== capability.artifactHash ||
          freshContext.baseRef !== capability.baseRef || freshContext.baseCommitSha !== capability.baseCommitSha) {
        return this.manualize(candidate, actorIdentityUserId, "claim_not_authorized");
      }
      await guard.assertOwned();
      await session.recordMutationVerified({ identity: candidate.identity, capability, verificationReceipt: receipt,
        resourceType: stage, resourceId: recoveredResourceId(candidate, stage, receipt),
        ...(stage === "branch" ? { branchName: candidate.branchName ?? derivedBranch(capability)!, commitSha: candidate.commitSha! } : {}),
        ...(stage === "pull_request" ? { branchName: candidate.branchName!, commitSha: candidate.commitSha!,
          pullRequestNumber: Number(recoveredResourceId(candidate, stage, receipt)),
          pullRequestUrl: readReceiptString(receipt, "pullRequestUrl") } : {}) });
      return Object.freeze({ kind: "verified", executionId: candidate.executionId, stage,
        operationKey: candidate.identity.operationKey });
    } catch {
      return this.manualize(candidate, actorIdentityUserId, "claim_not_authorized");
    }
  }

  private async recoverClosedPr(candidate: UnresolvedExecutionIntent, actorIdentityUserId: string,
    capability: import("../github/github-execution-capability.js").AuthorizedArtifactGitHubCapability): Promise<ExecutionRecoveryOutcome> {
    if (!candidate.pullRequestNumber || !candidate.pullRequestUrl || !candidate.branchName || !candidate.commitSha) {
      return this.manualize(candidate, actorIdentityUserId, "ambiguous_remote_operation");
    }
    const operation = candidate.identity.operation!;
    const expected = candidate.identity.expected!;
    if (operation.pullRequestNumber !== candidate.pullRequestNumber || operation.pullRequestUrl !== candidate.pullRequestUrl ||
        operation.branchName !== candidate.branchName || operation.expectedHeadSha !== candidate.commitSha ||
        operation.expectedBaseRef !== candidate.baseRef || operation.expectedBaseCommitSha !== candidate.baseCommitSha ||
        operation.requestedState !== "closed" || expected.pullRequestNumber !== candidate.pullRequestNumber ||
        expected.pullRequestUrl !== candidate.pullRequestUrl || expected.state !== "closed" ||
        expected.headRef !== candidate.branchName || expected.headSha !== candidate.commitSha ||
        expected.baseRef !== candidate.baseRef || expected.headRepositoryId !== candidate.githubRepositoryId ||
        expected.baseRepositoryId !== candidate.githubRepositoryId) {
      return this.manualize(candidate, actorIdentityUserId, "ambiguous_remote_operation");
    }

    // Claim the SYSTEM recovery lease to prevent concurrent automated recovery on the same execution.
    // The system lease is strictly separate from the human reconciliation lease; claiming it here
    // does NOT grant human reconciliation authority.
    const recoveryLease = await this.persistence.claimSystemRecoveryLease({
      executionId: candidate.executionId,
      organizationId: candidate.organizationId,
      tenantId: candidate.tenantId,
      projectId: candidate.projectId,
      recoveryOwnerId: "system:recovery",
    });
    if (!recoveryLease) {
      // Another automated recovery worker holds the lease — skip without escalating.
      return skipped(candidate, "recovery_lease_unavailable");
    }

    try {
      // Read-only GitHub verification: confirm whether the PR is actually closed.
      let result: Awaited<ReturnType<typeof this.publisher.recoverClosedPullRequest>>;
      try {
        result = await this.publisher.recoverClosedPullRequest({
          capability,
          pullRequestNumber: candidate.pullRequestNumber,
          pullRequestUrl: candidate.pullRequestUrl,
          branchName: candidate.branchName,
          commitSha: candidate.commitSha,
        });
      } catch {
        result = null;
      }

      // Assert the system recovery lease is still valid before persisting outcome (fencing check).
      try { await this.persistence.assertSystemRecoveryLeaseOwned(recoveryLease); }
      catch { return skipped(candidate, "recovery_lease_unavailable"); }

      // Whether or not the PR state was confirmed, automated recovery cannot settle reconciliation.
      // Human reconciliation authority is required to close out the execution. Escalate.
      const escalated = await this.persistence.requireRecoveryReview(
        candidate, actorIdentityUserId,
        result ? "ambiguous_remote_operation" : "ambiguous_remote_operation",
        recoveryLease
      );
      if (!escalated) return skipped(candidate, "authorization_or_state_changed");
      return manual(candidate, "ambiguous_remote_operation");
    } finally {
      // Always release the system recovery lease (best-effort).
      await this.persistence.releaseSystemRecoveryLease(recoveryLease).catch(() => { /* best effort */ });
    }
  }

  private async manualize(candidate: UnresolvedExecutionIntent, actorIdentityUserId: string,
    code: string): Promise<ExecutionRecoveryOutcome> {
    try {
      const changed = await this.persistence.requireRecoveryReview(candidate, actorIdentityUserId, code);
      return changed ? manual(candidate, code) : skipped(candidate, "authorization_or_state_changed");
    } catch (error) {
      if (error instanceof RemediationExecutionPersistenceError) return skipped(candidate, error.code);
      return skipped(candidate, "persistence_unavailable");
    }
  }
}

export function executionRecoveryPolicy(stage: string): "read_verify" | "manual_review_only" {
  return stage === "blob" || stage === "branch" || stage === "pull_request" || stage === "pull_request_close"
    ? "read_verify" : "manual_review_only";
}

export function isValidExecutionRecoveryIntent(candidate: UnresolvedExecutionIntent): boolean {
  const i = candidate.identity;
  if (!i.operation || !i.expected) return false;
  if (!["blob", "tree", "commit", "branch", "pull_request", "pull_request_close"].includes(i.stage)) return false;
  const scope = { proposalId: candidate.remediationId, tenantId: candidate.tenantId,
    organizationId: candidate.organizationId, projectId: candidate.projectId,
    repositoryBindingId: candidate.repositoryBindingId, repositoryId: candidate.githubRepositoryId,
    installationRecordId: candidate.installationRecordId, artifactHash: candidate.artifactHash,
    baseRef: candidate.baseRef, baseCommitSha: candidate.baseCommitSha };
  const digest = mutationRequestHash(i.stage, scope, i.operation, i.expected);
  return i.requestHash === digest && i.operationKey === `${i.stage}:${digest}`;
}

function failureCode(stage: string): string {
  return stage === "blob" ? "ambiguous_blob_write" : stage === "branch" ? "ambiguous_branch_creation" :
    stage === "pull_request" ? "ambiguous_pull_request_creation" : "ambiguous_remote_operation";
}
function recoveredResourceId(candidate: UnresolvedExecutionIntent, stage: string, receipt: object): string {
  if (stage === "branch") return candidate.branchName ?? derivedBranchFromIntent(candidate) ?? "";
  if (stage === "pull_request") return String(readReceiptNumber(receipt, "pullRequestNumber") ?? "");
  return String(candidate.identity.expected?.blobSha ?? "");
}
function readReceiptString(value: object, field: string): string {
  const v = (value as Record<string, unknown>)[field]; return typeof v === "string" ? v : "";
}
function readReceiptNumber(value: object, field: string): number | null {
  const v = (value as Record<string, unknown>)[field]; return typeof v === "number" ? v : null;
}
function derivedBranch(capability: import("../github/github-execution-capability.js").AuthorizedArtifactGitHubCapability): string | null {
  try { return deriveRemediationBranchName(capability); } catch { return null; }
}
function derivedBranchFromIntent(candidate: UnresolvedExecutionIntent): string | null {
  const value = candidate.identity.operation?.branchName;
  return typeof value === "string" ? value : null;
}
function skipped(candidate: UnresolvedExecutionIntent, reason: string): ExecutionRecoveryOutcome {
  return Object.freeze({ kind: "skipped", executionId: candidate.executionId, stage: candidate.identity.stage, reason });
}
function manual(candidate: UnresolvedExecutionIntent, reason: string): ExecutionRecoveryOutcome {
  return Object.freeze({ kind: "manual_review", executionId: candidate.executionId, stage: candidate.identity.stage, reason });
}
