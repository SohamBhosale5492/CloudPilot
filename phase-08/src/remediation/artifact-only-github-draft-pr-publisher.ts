import { createHash } from "node:crypto";
import {
  ArtifactGitHubClientError,
  githubMutationRequestFingerprint,
  githubMutationTarget,
  type ArtifactOnlyGitHubClient,
  type GitHubPullRequest,
  type GitHubRepositoryIdentity,
  type GitHubMutationCorrelation
} from "../github/artifact-only-github-client.js";
import {
  isAuthorizedArtifactGitHubCapability,
  isLeaseGuardForCapability,
  type AuthorizedArtifactGitHubCapability,
  type AuthorizedArtifactPullRequestCapability,
  type GitHubExecutionCapabilityService,
  type ServerOwnedExecutionLeaseGuard
} from "../github/github-execution-capability.js";
import {
  isVerifiedArtifactOnlyGitHubWriteResult,
  type VerifiedArtifactOnlyGitHubWriteResult
} from "./artifact-only-github-writer.js";
import { internalMutationBoundary, MutationIntentCommittedError } from "../github/internal-mutation-boundary.js";
import { isRemediationExecutionSession, type RemediationExecutionSession } from "./remediation-execution-persistence.js";

const SHA1 = /^[0-9a-f]{40}$/i;
const verifiedDraftResults = new WeakMap<object, AuthorizedArtifactGitHubCapability>();
const verifiedCloseResults = new WeakMap<object, AuthorizedArtifactGitHubCapability>();
const verifiedMutationReceipts = new WeakMap<object, { capability: AuthorizedArtifactGitHubCapability; stage: string;
  operationKey: string; requestHash: string }>();

export function isVerifiedArtifactPublisherMutationReceipt(value: unknown, capability: AuthorizedArtifactGitHubCapability,
  stage: string, operationKey: string, requestHash: string,
  expected: { readonly resourceType: string; readonly resourceId: string; readonly commitSha?: string;
    readonly branchName?: string; readonly pullRequestNumber?: number; readonly pullRequestUrl?: string }): boolean {
  if (!value || typeof value !== "object") return false;
  const receipt = verifiedMutationReceipts.get(value as object);
  const fields = value as Record<string, unknown>;
  return !!receipt && receipt.capability === capability && receipt.stage === stage &&
    receipt.operationKey === operationKey && receipt.requestHash === requestHash &&
    fields.resourceType === expected.resourceType && fields.resourceId === expected.resourceId &&
    fields.commitSha === expected.commitSha && fields.branchName === expected.branchName &&
    fields.pullRequestNumber === expected.pullRequestNumber && fields.pullRequestUrl === expected.pullRequestUrl;
}

export type VerifiedArtifactOnlyDraftPullRequestResult = Extract<ArtifactOnlyDraftPullRequestResult, { kind: "draft_pull_request" }>;
export type VerifiedArtifactOnlyPullRequestCloseResult = Extract<ArtifactOnlyDraftPullRequestResult, { kind: "manual_review" }> & {
  readonly pullRequestNumber: number; readonly pullRequestUrl: string; readonly branchName: string;
  readonly commitSha: string; readonly artifactHash: string;
};

export function isVerifiedArtifactOnlyDraftPullRequestResult(value: unknown,
  capability: AuthorizedArtifactGitHubCapability): value is VerifiedArtifactOnlyDraftPullRequestResult {
  return !!value && typeof value === "object" && verifiedDraftResults.get(value as object) === capability;
}

export function isVerifiedArtifactOnlyPullRequestCloseResult(value: unknown,
  capability: AuthorizedArtifactGitHubCapability): value is VerifiedArtifactOnlyPullRequestCloseResult {
  if (!value || typeof value !== "object" || verifiedCloseResults.get(value as object) !== capability) return false;
  const result = value as Partial<VerifiedArtifactOnlyPullRequestCloseResult>;
  return result.kind === "manual_review" &&
    ["base_moved_draft_closed", "base_mismatch_draft_closed"].includes(result.code ?? "") &&
    Number.isSafeInteger(result.pullRequestNumber) && typeof result.pullRequestUrl === "string" &&
    typeof result.branchName === "string" && typeof result.commitSha === "string" && typeof result.artifactHash === "string";
}

export interface ArtifactOnlyDraftPullRequestInput {
  readonly writeResult: VerifiedArtifactOnlyGitHubWriteResult;
  readonly capability: AuthorizedArtifactGitHubCapability;
  readonly leaseGuard: ServerOwnedExecutionLeaseGuard;
  readonly executionSession: RemediationExecutionSession;
  readonly signal?: AbortSignal;
}

export type ArtifactOnlyDraftPullRequestResult =
  | { readonly kind: "draft_pull_request"; readonly pullRequestNumber: number; readonly pullRequestUrl: string;
      readonly branchName: string; readonly commitSha: string; readonly artifactHash: string; readonly reconciled: boolean }
  | { readonly kind: "failed"; readonly code: "invalid_trust_input" | "lease_lost" | "base_ref_moved" |
      "branch_conflict" | "github_request_failed" }
  | { readonly kind: "manual_review"; readonly code: "ambiguous_branch_creation" | "ambiguous_pull_request_creation" |
      "pull_request_conflict" | "pull_request_verification_failed" | "base_moved_draft_closed" |
      "base_mismatch_draft_closed" | "base_moved_draft_close_failed" | "base_moved_existing_draft" |
      "base_moved_before_pull_request" |
      "lease_lost_after_write" | "ambiguous_remote_operation";
      readonly pullRequestNumber?: number; readonly pullRequestUrl?: string; readonly branchName: string;
      readonly commitSha?: string; readonly artifactHash?: string };

/** Deterministic, bounded Git ref derived only from trusted proposal/artifact identity. */
export function deriveRemediationBranchName(capability: AuthorizedArtifactGitHubCapability): string {
  const digest = createHash("sha256").update(`${capability.proposalId}\0${capability.artifactHash}`, "utf8").digest("hex");
  return `cloudpilot/remediation/${digest.slice(0, 40)}`;
}

/**
 * Creates/reconciles a deterministic branch and a draft PR for an already
 * verified artifact commit. It never accepts caller-selected repository or ref
 * coordinates and never regenerates or rebases the artifact.
 */
export class ArtifactOnlyGitHubDraftPrPublisher {
  constructor(private readonly capabilities: GitHubExecutionCapabilityService, private readonly now: () => number = Date.now) {}

  /** Read-only restart recovery for a deterministic branch created from a persisted commit result. */
  async recoverBranchMutation(input: {
    readonly capability: AuthorizedArtifactGitHubCapability; readonly leaseGuard: ServerOwnedExecutionLeaseGuard;
    readonly identity: import("./remediation-execution-persistence.js").ExecutionMutationIdentity;
    readonly persistedCommitSha: string | null;
  }): Promise<object | null> {
    const { capability, leaseGuard, identity, persistedCommitSha } = input;
    const branchName = deriveRemediationBranchName(capability);
    if (!isAuthorizedArtifactGitHubCapability(capability) || !isLeaseGuardForCapability(leaseGuard, capability) ||
        identity.stage !== "branch" || !identity.operation || !identity.expected || !persistedCommitSha || !SHA1.test(persistedCommitSha) ||
        identity.operation.branchName !== branchName || identity.operation.commitSha !== persistedCommitSha ||
        identity.expected.branchName !== branchName || identity.expected.refSha !== persistedCommitSha ||
        identity.expected.immutableRepositoryId !== capability.repositoryId) return null;
    const client = this.capabilities.clientFor(capability);
    if (!client) return null;
    try {
      await leaseGuard.assertOwned();
      const repository = await client.resolveRepository();
      if (repository.id !== capability.repositoryId) return null;
      const branch = await readBranch(client, repository, branchName, new AbortController().signal);
      await leaseGuard.assertOwned();
      if (!branch || branch.sha !== persistedCommitSha) return null;
      const receipt = Object.freeze({ stage: "branch", operationKey: identity.operationKey, requestHash: identity.requestHash,
        resourceType: "branch", resourceId: branchName, branchName, commitSha: branch.sha });
      verifiedMutationReceipts.set(receipt, { capability, stage: "branch", operationKey: identity.operationKey,
        requestHash: identity.requestHash });
      return receipt;
    } catch { return null; }
  }

  /** Read-only restart recovery for a deterministic open draft PR. */
  async recoverDraftPullRequestMutation(input: {
    readonly capability: AuthorizedArtifactGitHubCapability; readonly leaseGuard: ServerOwnedExecutionLeaseGuard;
    readonly identity: import("./remediation-execution-persistence.js").ExecutionMutationIdentity;
    readonly persistedCommitSha: string | null; readonly persistedBranchName: string | null;
  }): Promise<object | null> {
    const { capability, leaseGuard, identity, persistedCommitSha, persistedBranchName } = input;
    const branchName = deriveRemediationBranchName(capability);
    if (!isAuthorizedArtifactGitHubCapability(capability) || !isLeaseGuardForCapability(leaseGuard, capability) ||
        identity.stage !== "pull_request" || !identity.operation || !identity.expected || !persistedCommitSha ||
        persistedCommitSha !== identity.operation.headCommitSha || persistedBranchName !== branchName ||
        identity.operation.branchName !== branchName || identity.operation.baseRef !== capability.baseRef ||
        identity.operation.baseCommitSha !== capability.baseCommitSha || identity.expected.headRef !== branchName ||
        identity.expected.headSha !== persistedCommitSha || identity.expected.baseRef !== capability.baseRef ||
        identity.expected.baseSha !== capability.baseCommitSha || identity.expected.headRepositoryId !== capability.repositoryId ||
        identity.expected.baseRepositoryId !== capability.repositoryId || identity.expected.draft !== true ||
        identity.expected.state !== "open") return null;
    const prCapability = await this.capabilities.issueDraftPullRequestCapability(capability);
    if (!prCapability) return null;
    const pullClient = this.capabilities.pullRequestClientFor(prCapability);
    const contentClient = this.capabilities.clientFor(capability);
    if (!pullClient || !contentClient) return null;
    try {
      await leaseGuard.assertOwned();
      const repository = await pullClient.resolveRepository();
      if (repository.id !== capability.repositoryId) return null;
      const contentRepository = await contentClient.resolveRepository();
      if (contentRepository.id !== capability.repositoryId) return null;
      const signal = new AbortController().signal;
      const prs = await listPullRequests(pullClient, repository, branchName, capability.baseRef, signal);
      if (prs.length !== 1 || !isExpectedPullRequest(prs[0]!, capability, branchName, persistedCommitSha)) return null;
      const currentBase = await currentBaseMatches(contentClient, contentRepository, capability, signal);
      const readBack = await pullClient.readPullRequest(repository, prs[0]!.number, signal);
      await leaseGuard.assertOwned();
      if (!currentBase || !isExpectedPullRequest(readBack, capability, branchName, persistedCommitSha)) return null;
      const receipt = Object.freeze({ stage: "pull_request", operationKey: identity.operationKey, requestHash: identity.requestHash,
        resourceType: "pull_request", resourceId: String(readBack.number), commitSha: persistedCommitSha,
        branchName, pullRequestNumber: readBack.number, pullRequestUrl: readBack.url });
      verifiedMutationReceipts.set(receipt, { capability, stage: "pull_request", operationKey: identity.operationKey,
        requestHash: identity.requestHash });
      return receipt;
    } catch { return null; }
  }

  /** Read-only PR-close recovery. It only creates evidence after an exact closed-state read-back. */
  async recoverClosedPullRequest(input: {
    readonly capability: AuthorizedArtifactGitHubCapability; readonly pullRequestNumber: number;
    readonly pullRequestUrl: string; readonly branchName: string; readonly commitSha: string;
  }): Promise<VerifiedArtifactOnlyPullRequestCloseResult | null> {
    const { capability } = input;
    if (!isAuthorizedArtifactGitHubCapability(capability) || !Number.isSafeInteger(input.pullRequestNumber) ||
        !SHA1.test(input.commitSha) || input.branchName !== deriveRemediationBranchName(capability)) return null;
    const prCapability = await this.capabilities.issueDraftPullRequestCapability(capability);
    const client = prCapability && this.capabilities.pullRequestClientFor(prCapability);
    if (!client) return null;
    try {
      const repository = await client.resolveRepository();
      if (repository.id !== capability.repositoryId) return null;
      const pr = await client.readPullRequest(repository, input.pullRequestNumber);
      if (pr.url !== input.pullRequestUrl || pr.state !== "closed" ||
          !sameDraftScope(pr, capability, input.branchName, input.commitSha)) return null;
      const result = Object.freeze({ kind: "manual_review" as const, code: "base_moved_draft_closed" as const,
        pullRequestNumber: pr.number, pullRequestUrl: pr.url, branchName: input.branchName,
        commitSha: input.commitSha, artifactHash: capability.artifactHash });
      verifiedCloseResults.set(result, capability);
      return result;
    } catch { return null; }
  }

  async publish(input: ArtifactOnlyDraftPullRequestInput): Promise<ArtifactOnlyDraftPullRequestResult> {
    const { capability, writeResult, leaseGuard } = input ?? {};
    if (!isAuthorizedArtifactGitHubCapability(capability) || !isLeaseGuardForCapability(leaseGuard, capability) ||
        !isRemediationExecutionSession(input.executionSession) ||
        !isVerifiedArtifactOnlyGitHubWriteResult(writeResult, capability)) {
      return { kind: "failed", code: "invalid_trust_input" };
    }
    const contentClient = this.capabilities.clientFor(capability);
    if (!contentClient) return { kind: "failed", code: "invalid_trust_input" };
    const branchName = deriveRemediationBranchName(capability);
    // Latest validated, token-bounded deadline from the capability service; follows accepted renewals.
    const deadlinePassed = (): boolean => {
      const deadline = this.capabilities.currentDeadlineFor(capability);
      return deadline === null || !Number.isFinite(deadline) || deadline <= this.now();
    };
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (input.signal?.aborted) controller.abort();
    else input.signal?.addEventListener("abort", abort, { once: true });
    // Abort any in-flight request as soon as the capability is revoked or its latest deadline passes.
    const stopDeadlineWatch = this.capabilities.watchDeadline(capability, () => controller.abort());
    const guard = async (): Promise<void> => {
      if (controller.signal.aborted || deadlinePassed()) {
        controller.abort(); throw new PublishFailure("lease_lost");
      }
      try { await leaseGuard.assertOwned(controller.signal); }
      catch { controller.abort(); throw new PublishFailure("lease_lost"); }
      if (deadlinePassed()) { controller.abort(); throw new PublishFailure("lease_lost"); }
    };
    let branchMutationStarted = false;
    let pullRequestMutationStarted = false;
    let branchMayExist = false;
    let branchCreatedThisCall = false;
    let possiblePullRequest: GitHubPullRequest | undefined;
    try {
      await guard();
      const repository = await contentClient.resolveRepository(controller.signal);
      if (!matchesRepository(repository, capability)) throw new PublishFailure("invalid_trust_input");

      let branch = await readBranch(contentClient, repository, branchName, controller.signal);
      if (branch && branch.sha !== writeResult.commitSha) {
        return { kind: "failed", code: "branch_conflict" };
      }
      if (!branch) {
        await guard();
        branchMutationStarted = true;
        branchMayExist = true;
        const branchOperation = internalMutationBoundary<void, { readonly sha: string } | null>({
          stage: "branch",
          scope: mutationScope(capability),
          requestFingerprint: githubMutationRequestFingerprint("POST", githubMutationTarget(repository, "/git/refs"),
            JSON.stringify({ ref: `refs/heads/${branchName}`, sha: writeResult.commitSha })),
          operation: { branchName, commitSha: writeResult.commitSha, expectedBaseRef: capability.baseRef,
            expectedBaseCommitSha: capability.baseCommitSha },
          expected: { branchName, refSha: writeResult.commitSha, immutableRepositoryId: capability.repositoryId },
          mutate: async (identity) => { await guard(); return contentClient.createBranch(repository, branchName,
            writeResult.commitSha, mutationCorrelation(input.executionSession, identity), controller.signal); },
          verify: async () => readBranch(contentClient, repository, branchName, controller.signal)
        });
        try {
          await persistMutationIntent(input.executionSession, branchOperation, guard);
          await branchOperation.mutateOnce();
        }
        catch (error) {
          if (error instanceof MutationIntentCommittedError) return { kind: "manual_review",
            code: "ambiguous_remote_operation", branchName };
          if (error instanceof ArtifactGitHubClientError && error.code === "invalid_token") {
            branchMayExist = false; branchMutationStarted = false; throw new PublishFailure("lease_lost");
          }
          if (!isAmbiguousOrConflict(error)) {
            branchMayExist = false; branchMutationStarted = false; throw new PublishFailure("github_request_failed");
          }
          branch = await readBranch(contentClient, repository, branchName, controller.signal);
          if (!branch || branch.sha !== writeResult.commitSha) {
            return { kind: "manual_review", code: "ambiguous_branch_creation", branchName };
          }
        }
        branchMutationStarted = false;
        if (!branch) branch = await branchOperation.verify(undefined);
        if (!branch || branch.sha !== writeResult.commitSha) {
          return { kind: "manual_review", code: "ambiguous_branch_creation", branchName };
        }
        await persistMutationResult(input.executionSession, branchOperation, capability, "branch", branchName,
          { commitSha: branch.sha, branchName });
        branchMayExist = false;
        branchCreatedThisCall = true;
      }

      const prCapability = await this.capabilities.issueDraftPullRequestCapability(capability);
      if (!prCapability || !matchesPullRequestCapability(prCapability, capability)) {
        // The deterministic branch was created remotely by this call; never report an ordinary retryable failure.
        if (branchCreatedThisCall) return { kind: "manual_review", code: "lease_lost_after_write", branchName };
        return { kind: "failed", code: "github_request_failed" };
      }
      const pullClient = this.capabilities.pullRequestClientFor(prCapability);
      if (!pullClient) {
        if (branchCreatedThisCall) return { kind: "manual_review", code: "lease_lost_after_write", branchName };
        return { kind: "failed", code: "invalid_trust_input" };
      }
      const prRepository = await pullClient.resolveRepository(controller.signal);
      if (!matchesRepository(prRepository, capability)) throw new PublishFailure("invalid_trust_input");

      let existing = await listPullRequests(pullClient, prRepository, branchName, capability.baseRef, controller.signal);
      if (existing.length > 1) return { kind: "manual_review", code: "pull_request_conflict", branchName };
      if (existing.length === 1) {
        const prior = existing[0]!;
        if (!isExpectedPullRequest(prior, capability, branchName, writeResult.commitSha)) {
          const baseCurrent = await currentBaseMatches(contentClient, repository, capability, controller.signal);
          if (isSafeToClose(prior, capability, branchName, writeResult.commitSha) &&
              (prior.baseSha !== capability.baseCommitSha || !baseCurrent)) {
            return this.closeStaleDraft(pullClient, prRepository, prior, capability, branchName, writeResult.commitSha,
              guard, input.executionSession, "pull_request_verification_failed", prior.baseSha !== capability.baseCommitSha ?
                "base_mismatch_draft_closed" : "base_moved_draft_closed");
          }
          return manualPr("pull_request_conflict", prior, branchName);
        }
        const currentBase = await currentBaseMatches(contentClient, repository, capability, controller.signal);
        if (!currentBase) return this.closeStaleDraft(pullClient, prRepository, prior, capability, branchName,
          writeResult.commitSha, guard, input.executionSession);
        const confirmed = await pullClient.readPullRequest(prRepository, prior.number, controller.signal);
        if (!isExpectedPullRequest(confirmed, capability, branchName, writeResult.commitSha)) {
          return manualPr("pull_request_verification_failed", confirmed, branchName);
        }
        const baseStillCurrent = await currentBaseMatches(contentClient, repository, capability, controller.signal);
        if (!baseStillCurrent) return this.closeStaleDraft(pullClient, prRepository, confirmed, capability, branchName,
          writeResult.commitSha, guard, input.executionSession);
        // An existing PR has no operation intent in this execution attempt. Do
        // not report completion without a journaled creation/reconciliation path.
        return manualPr("pull_request_conflict", confirmed, branchName);
      }

      if (!await currentBaseMatches(contentClient, repository, capability, controller.signal)) {
        return { kind: "manual_review", code: "base_moved_before_pull_request", branchName };
      }
      await guard();
      pullRequestMutationStarted = true;
      let created: GitHubPullRequest | undefined;
      let reconciled = false;
      const prInput = Object.freeze({ head: branchName, base: capability.baseRef,
        title: "CloudPilot: approved observability remediation",
        body: `Approved artifact: ${capability.artifactHash}\nVerified commit: ${writeResult.commitSha}` });
      const prOperation = internalMutationBoundary<GitHubPullRequest, GitHubPullRequest>({
        stage: "pull_request",
        scope: mutationScope(capability),
        requestFingerprint: githubMutationRequestFingerprint("POST", githubMutationTarget(prRepository, "/pulls"),
          JSON.stringify({ head: prInput.head, base: prInput.base, title: prInput.title, body: prInput.body, draft: true })),
        operation: { branchName, headCommitSha: writeResult.commitSha, baseRef: capability.baseRef,
          baseCommitSha: capability.baseCommitSha, title: prInput.title, body: prInput.body, draft: true },
        expected: { headRef: branchName, headSha: writeResult.commitSha, baseRef: capability.baseRef,
          baseSha: capability.baseCommitSha, headRepositoryId: capability.repositoryId,
          baseRepositoryId: capability.repositoryId, draft: true, state: "open" },
        mutate: async (identity) => { await guard(); return pullClient.createDraftPullRequest(prRepository, prInput,
          mutationCorrelation(input.executionSession, identity), controller.signal); },
        verify: async (response) => {
          const readBack = await pullClient.readPullRequest(prRepository, response.number, controller.signal);
          if (readBack.number !== response.number) throw new PublishFailure("github_request_failed");
          return readBack;
        }
      });
      try {
        await persistMutationIntent(input.executionSession, prOperation, guard);
        const response = await prOperation.mutateOnce();
        created = response;
      } catch (error) {
        if (error instanceof MutationIntentCommittedError) return { kind: "manual_review",
          code: "ambiguous_remote_operation", branchName, commitSha: writeResult.commitSha,
          artifactHash: capability.artifactHash };
        if (error instanceof ArtifactGitHubClientError && error.code === "invalid_token") {
          pullRequestMutationStarted = false; throw new PublishFailure("lease_lost");
        }
        if (!isAmbiguousOrConflict(error)) {
          pullRequestMutationStarted = false; throw new PublishFailure("github_request_failed");
        }
        existing = await listPullRequests(pullClient, prRepository, branchName, capability.baseRef, controller.signal);
        if (existing.length === 1 && !isExpectedPullRequest(existing[0]!, capability, branchName, writeResult.commitSha) &&
            isSafeToClose(existing[0]!, capability, branchName, writeResult.commitSha) &&
            (existing[0]!.baseSha !== capability.baseCommitSha ||
              !await currentBaseMatches(contentClient, repository, capability, controller.signal))) {
          possiblePullRequest = existing[0];
          return this.closeStaleDraft(pullClient, prRepository, possiblePullRequest, capability, branchName,
            writeResult.commitSha, guard, input.executionSession, "ambiguous_pull_request_creation",
            possiblePullRequest.baseSha !== capability.baseCommitSha ? "base_mismatch_draft_closed" : "base_moved_draft_closed");
        }
        if (existing.length !== 1 || !isExpectedPullRequest(existing[0]!, capability, branchName, writeResult.commitSha)) {
          const conflicting = existing[0];
          return conflicting ? manualPr("ambiguous_pull_request_creation", conflicting, branchName) :
            { kind: "manual_review", code: "ambiguous_pull_request_creation", branchName };
        }
        created = existing[0];
        reconciled = true;
      }
      pullRequestMutationStarted = false;
      if (!created) return { kind: "manual_review", code: "ambiguous_pull_request_creation", branchName };
      possiblePullRequest = created;

      if (!reconciled) {
        try { created = await prOperation.verify(created); }
        catch { return manualPr("pull_request_verification_failed", possiblePullRequest, branchName); }
      }

      const verified = await pullClient.readPullRequest(prRepository, created.number, controller.signal);
      possiblePullRequest = verified;
      if (!isExpectedPullRequest(verified, capability, branchName, writeResult.commitSha)) {
        const baseCurrent = await currentBaseMatches(contentClient, repository, capability, controller.signal);
        if (isSafeToClose(verified, capability, branchName, writeResult.commitSha) &&
            (verified.baseSha !== capability.baseCommitSha || !baseCurrent)) {
          return this.closeStaleDraft(pullClient, prRepository, verified, capability, branchName, writeResult.commitSha, guard,
            input.executionSession, "pull_request_verification_failed", verified.baseSha !== capability.baseCommitSha ?
              "base_mismatch_draft_closed" : "base_moved_draft_closed");
        }
        return manualPr("pull_request_verification_failed", verified, branchName);
      }
      await persistMutationResult(input.executionSession, prOperation, capability, "pull_request", String(verified.number),
        { commitSha: writeResult.commitSha, branchName, pullRequestNumber: verified.number, pullRequestUrl: verified.url });
      if (!await currentBaseMatches(contentClient, repository, capability, controller.signal)) {
        return this.closeStaleDraft(pullClient, prRepository, verified, capability, branchName, writeResult.commitSha, guard, input.executionSession);
      }
      return result(verified, branchName, writeResult, reconciled, capability);
    } catch (error) {
      controller.abort();
      if (possiblePullRequest) return manualPr("pull_request_verification_failed", possiblePullRequest, branchName);
      if ((error instanceof PublishFailure && error.code === "lease_lost") ||
          (error instanceof ArtifactGitHubClientError && error.code === "invalid_token")) {
        if (pullRequestMutationStarted || branchMutationStarted || branchMayExist || branchCreatedThisCall) {
          return { kind: "manual_review", code: "lease_lost_after_write", branchName };
        }
        return { kind: "failed", code: "lease_lost" };
      }
      if (error instanceof PublishFailure && error.code === "invalid_trust_input") return { kind: "failed", code: error.code };
      if (pullRequestMutationStarted) return { kind: "manual_review", code: "ambiguous_pull_request_creation", branchName };
      if (branchMayExist) return { kind: "manual_review", code: "ambiguous_branch_creation", branchName };
      return { kind: "failed", code: "github_request_failed" };
    } finally {
      stopDeadlineWatch();
      input.signal?.removeEventListener("abort", abort);
    }
  }

  private async closeStaleDraft(client: ArtifactOnlyGitHubClient, repository: GitHubRepositoryIdentity, pr: GitHubPullRequest,
    capability: AuthorizedArtifactGitHubCapability, branchName: string, expectedHeadSha: string, guard: () => Promise<void>,
    executionSession: RemediationExecutionSession,
    fallback: "base_moved_existing_draft" | "pull_request_verification_failed" | "ambiguous_pull_request_creation" = "base_moved_existing_draft",
    closedCode: "base_moved_draft_closed" | "base_mismatch_draft_closed" = "base_moved_draft_closed"):
    Promise<ArtifactOnlyDraftPullRequestResult> {
    if (!isSafeToClose(pr, capability, branchName, expectedHeadSha)) return manualPr(fallback, pr, branchName);
    try {
      const closeOperation = internalMutationBoundary<GitHubPullRequest, GitHubPullRequest>({
        stage: "pull_request_close",
        scope: mutationScope(capability),
        requestFingerprint: githubMutationRequestFingerprint("PATCH", githubMutationTarget(repository, `/pulls/${pr.number}`),
          JSON.stringify({ state: "closed" })),
        operation: { pullRequestNumber: pr.number, pullRequestUrl: pr.url, branchName,
          expectedHeadSha, expectedBaseRef: capability.baseRef, expectedBaseCommitSha: capability.baseCommitSha,
          requestedState: "closed" },
        expected: { pullRequestNumber: pr.number, pullRequestUrl: pr.url, state: "closed",
          headRef: branchName, headSha: expectedHeadSha, baseRef: capability.baseRef,
          headRepositoryId: capability.repositoryId, baseRepositoryId: capability.repositoryId },
        mutate: async (identity) => { await guard(); return client.closePullRequest(repository, pr.number,
          mutationCorrelation(executionSession, identity)); },
        verify: async (response) => {
          const readBack = await client.readPullRequest(repository, pr.number);
          if (response.number !== pr.number || readBack.number !== pr.number || readBack.state !== "closed" ||
              !sameDraftScope(readBack, capability, branchName, expectedHeadSha)) {
            throw new PublishFailure("github_request_failed");
          }
          return readBack;
        }
      });
      await persistMutationIntent(executionSession, closeOperation, guard);
      const response = await closeOperation.mutateOnce();
      const closed = await closeOperation.verify(response);
      if (closed.number !== pr.number || closed.state !== "closed" ||
          !sameDraftScope(closed, capability, branchName, expectedHeadSha)) {
        return manualPr("base_moved_draft_close_failed", pr, branchName);
      }
      const verified = Object.freeze({ ...manualPr(closedCode, closed, branchName),
        commitSha: expectedHeadSha, artifactHash: capability.artifactHash });
      verifiedCloseResults.set(verified, capability);
      await persistMutationResult(executionSession, closeOperation, capability, "pull_request_close", String(closed.number),
        { commitSha: expectedHeadSha, branchName, pullRequestNumber: closed.number, pullRequestUrl: closed.url });
      return verified;
    } catch {
      return manualPr("base_moved_draft_close_failed", pr, branchName);
    }
  }
}

class PublishFailure extends Error {
  constructor(readonly code: "invalid_trust_input" | "lease_lost" | "github_request_failed") { super(code); }
}

function matchesRepository(repository: GitHubRepositoryIdentity, capability: AuthorizedArtifactGitHubCapability): boolean {
  return repository.id === capability.repositoryId && repository.owner === capability.repository.owner &&
    repository.name === capability.repository.name;
}

function mutationScope(capability: AuthorizedArtifactGitHubCapability) {
  return { proposalId: capability.proposalId, tenantId: capability.tenantId,
    organizationId: capability.organizationId, projectId: capability.projectId,
    repositoryBindingId: capability.repositoryBindingId,
    repositoryId: capability.repositoryId, installationRecordId: capability.installationRecordId,
    artifactHash: capability.artifactHash, baseRef: capability.baseRef, baseCommitSha: capability.baseCommitSha };
}

function mutationCorrelation(session: RemediationExecutionSession,
  operation: { readonly operationKey: string; readonly requestHash: string; readonly stage: GitHubMutationCorrelation["stage"];
    readonly requestFingerprint: string }): GitHubMutationCorrelation {
  return Object.freeze({ executionId: session.executionId, attempt: session.attemptNumber,
    operationKey: operation.operationKey, stage: operation.stage, requestHash: operation.requestHash,
    requestFingerprint: operation.requestFingerprint });
}

async function persistMutationIntent(session: RemediationExecutionSession,
  operation: import("../github/internal-mutation-boundary.js").InternalMutationBoundary<unknown, unknown>,
  guard: () => Promise<void>): Promise<void> {
  await guard();
  await session.recordIntent({ stage: operation.stage, operationKey: operation.operationKey, requestHash: operation.requestHash,
    operation: operation.operation, expected: operation.expected });
  try { await guard(); } catch { throw new MutationIntentCommittedError(); }
}

async function persistMutationResult(session: RemediationExecutionSession,
  operation: import("../github/internal-mutation-boundary.js").InternalMutationBoundary<unknown, unknown>,
  capability: AuthorizedArtifactGitHubCapability, resourceType: string, resourceId: string,
  details: { readonly commitSha?: string; readonly branchName?: string; readonly pullRequestNumber?: number;
    readonly pullRequestUrl?: string } = {}): Promise<void> {
  const receipt = Object.freeze({ stage: operation.stage, operationKey: operation.operationKey,
    requestHash: operation.requestHash, resourceType, resourceId, ...details });
  verifiedMutationReceipts.set(receipt, { capability, stage: operation.stage,
    operationKey: operation.operationKey, requestHash: operation.requestHash });
  await session.recordMutationVerified({ identity: { stage: operation.stage, operationKey: operation.operationKey,
    requestHash: operation.requestHash }, capability, verificationReceipt: receipt, resourceType, resourceId, ...details });
}

function matchesPullRequestCapability(pr: AuthorizedArtifactPullRequestCapability,
  capability: AuthorizedArtifactGitHubCapability): boolean {
  return pr.proposalId === capability.proposalId && pr.organizationId === capability.organizationId &&
    pr.tenantId === capability.tenantId &&
    pr.projectId === capability.projectId && pr.repositoryBindingId === capability.repositoryBindingId &&
    pr.installationRecordId === capability.installationRecordId && pr.installationId === capability.installationId &&
    pr.repositoryId === capability.repositoryId && pr.executionContextHash === capability.executionContextHash &&
    pr.artifactHash === capability.artifactHash && pr.baseRef === capability.baseRef &&
    pr.baseCommitSha === capability.baseCommitSha && pr.lease.remediationId === capability.lease.remediationId &&
    pr.lease.workerId === capability.lease.workerId && pr.lease.leaseTokenHash === capability.lease.leaseTokenHash &&
    pr.lease.expiresAt === capability.lease.expiresAt && pr.permissions.pull_requests === "write" &&
    pr.permissions.metadata === "read" && Object.keys(pr.permissions).length === 2;
}

async function readBranch(client: ArtifactOnlyGitHubClient, repository: GitHubRepositoryIdentity, branch: string,
  signal: AbortSignal): Promise<{ readonly sha: string } | null> {
  try { return await client.readReference(repository, branch, signal); }
  catch (error) {
    if (error instanceof ArtifactGitHubClientError && error.code === "not_found") return null;
    throw error;
  }
}

async function listPullRequests(client: ArtifactOnlyGitHubClient, repository: GitHubRepositoryIdentity, head: string,
  base: string, signal: AbortSignal): Promise<readonly GitHubPullRequest[]> {
  return client.listPullRequestsForHead(repository, head, base, signal);
}

async function currentBaseMatches(client: ArtifactOnlyGitHubClient, repository: GitHubRepositoryIdentity,
  capability: AuthorizedArtifactGitHubCapability, signal: AbortSignal): Promise<boolean> {
  try { return (await client.readReference(repository, capability.baseRef, signal)).sha === capability.baseCommitSha; }
  catch { return false; }
}

function isExpectedPullRequest(pr: GitHubPullRequest, capability: AuthorizedArtifactGitHubCapability, branch: string,
  commitSha: string): boolean {
  return pr.state === "open" && pr.draft && pr.number > 0 && SHA1.test(pr.headSha) && pr.headRef === branch &&
    pr.headSha === commitSha && pr.headRepositoryId === capability.repositoryId && pr.baseRepositoryId === capability.repositoryId &&
    pr.baseRef === capability.baseRef && pr.baseSha === capability.baseCommitSha;
}

function isSafeToClose(pr: GitHubPullRequest, capability: AuthorizedArtifactGitHubCapability, branch: string,
  expectedHeadSha: string): boolean {
  return pr.state === "open" && sameDraftScope(pr, capability, branch, expectedHeadSha);
}

function sameDraftScope(pr: GitHubPullRequest, capability: AuthorizedArtifactGitHubCapability, branch: string,
  expectedHeadSha: string): boolean {
  return pr.draft && pr.headRef === branch &&
    pr.headSha === expectedHeadSha &&
    pr.headRepositoryId === capability.repositoryId && pr.baseRepositoryId === capability.repositoryId &&
    pr.baseRef === capability.baseRef;
}

function result(pr: GitHubPullRequest, branchName: string, write: VerifiedArtifactOnlyGitHubWriteResult,
  reconciled: boolean, capability: AuthorizedArtifactGitHubCapability): ArtifactOnlyDraftPullRequestResult {
  const value = Object.freeze({ kind: "draft_pull_request" as const, pullRequestNumber: pr.number, pullRequestUrl: pr.url,
    branchName, commitSha: write.commitSha, artifactHash: write.artifactHash, reconciled });
  verifiedDraftResults.set(value, capability);
  return value;
}

function manualPr(code: Exclude<ArtifactOnlyDraftPullRequestResult, { kind: "draft_pull_request" | "failed" }>['code'] | "base_moved_draft_closed",
  pr: GitHubPullRequest, branchName: string): ArtifactOnlyDraftPullRequestResult {
  return Object.freeze({ kind: "manual_review", code, pullRequestNumber: pr.number, pullRequestUrl: pr.url, branchName });
}

function isAmbiguousOrConflict(error: unknown): boolean {
  return error instanceof ArtifactGitHubClientError &&
    (error.code === "network_failure" || error.code === "timeout" || error.code === "aborted" ||
      error.code === "upstream_failure" || error.code === "invalid_response" || error.code === "conflict");
}
