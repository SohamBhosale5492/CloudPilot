import {
  isAuthorizedArtifactGitHubCapability,
  isLeaseGuardForCapability,
  type GitHubExecutionCapabilityService,
  type ServerOwnedExecutionLeaseGuard
} from "../github/github-execution-capability.js";
import type { RemediationLease } from "../jobs/remediation-repo.js";
import { RemediationExecutionPersistenceError, type RemediationExecutionPersistenceService,
  type RemediationExecutionSession } from "./remediation-execution-persistence.js";
import {
  ArtifactOnlyGitHubWriter,
  isVerifiedArtifactOnlyGitHubWriteResult,
  type ArtifactOnlyGitHubWriteResult
} from "./artifact-only-github-writer.js";
import {
  ArtifactOnlyGitHubDraftPrPublisher,
  type ArtifactOnlyDraftPullRequestResult
} from "./artifact-only-github-draft-pr-publisher.js";
import {
  isTrustedClaimExecutionContext,
  type TrustedClaimExecutionContext,
  type TrustedClaimExecutionContextService
} from "./trusted-claim-execution-context.js";

export type ArtifactOnlyExecutionOutcome =
  | { readonly kind: "draft_pull_request"; readonly remediationId: string; readonly proposalId: string;
      readonly artifactHash: string; readonly commitSha: string; readonly pullRequestNumber: number;
      readonly pullRequestUrl: string; readonly branchName: string; readonly reconciled: boolean }
  | { readonly kind: "retry_scheduled"; readonly stage: "write"; readonly code: "rate_limited";
      readonly remediationId: string; readonly retryAfterMs: number }
  | { readonly kind: "failed"; readonly stage: "claim" | "context" | "capability" | "write";
      readonly code: string; readonly remediationId?: string; readonly retryAfterMs?: number }
  | { readonly kind: "manual_review"; readonly stage: "write" | "publish"; readonly code: string;
      readonly remediationId: string; readonly proposalId: string; readonly artifactHash: string;
      readonly commitSha?: string; readonly pullRequestNumber?: number; readonly pullRequestUrl?: string;
      readonly branchName?: string };

interface ContextPreparer {
  prepare(lease: RemediationLease): Promise<TrustedClaimExecutionContext | null>;
}
interface CapabilityIssuer {
  issue(lease: RemediationLease): ReturnType<GitHubExecutionCapabilityService["issue"]>;
  leaseGuardFor(capability: unknown): ServerOwnedExecutionLeaseGuard | null;
}
interface ArtifactWriter {
  write(input: { context: TrustedClaimExecutionContext; capability: Parameters<ArtifactOnlyGitHubWriter["write"]>[0]["capability"];
    leaseGuard: ServerOwnedExecutionLeaseGuard; executionSession: RemediationExecutionSession; signal?: AbortSignal }): Promise<ArtifactOnlyGitHubWriteResult>;
}
interface DraftPublisher {
  publish(input: Parameters<ArtifactOnlyGitHubDraftPrPublisher["publish"]>[0]): Promise<ArtifactOnlyDraftPullRequestResult>;
}

/**
 * Server-owned composition of the already trusted context, capability, writer,
 * and publisher boundaries. The lease is only a selector: prepare()/issue()
 * revalidate its token, owner, status, and expiry against persisted state.
 * This service is deliberately not registered as an API route or worker.
 */
export class ArtifactOnlyExecutionOrchestrator {
  constructor(
    private readonly contexts: ContextPreparer,
    private readonly capabilities: CapabilityIssuer,
    private readonly writer: ArtifactWriter,
    private readonly publisher: DraftPublisher,
    private readonly persistence: RemediationExecutionPersistenceService
  ) {}

  async execute(lease: RemediationLease, signal?: AbortSignal): Promise<ArtifactOnlyExecutionOutcome> {
    if (!validLeaseSelector(lease) || signal?.aborted) {
      return { kind: "failed", stage: "claim", code: signal?.aborted ? "cancelled" : "invalid_claim" };
    }

    let context: TrustedClaimExecutionContext | null;
    try { context = await this.contexts.prepare(lease); }
    catch { return failed("context", "authorization_unavailable", lease.id); }
    if (!isTrustedClaimExecutionContext(context)) return failed("context", "claim_not_authorized", lease.id);

    let executionSession: RemediationExecutionSession | null;
    try { executionSession = await this.persistence.start(lease, context); }
    catch { return failed("claim", "execution_conflict", lease.id); }
    if (!executionSession) return failed("claim", "claim_not_authorized", lease.id);

    let capability;
    try { capability = await this.capabilities.issue(lease); }
    catch {
      await executionSession.recordFailure("execution", "capability_unavailable").catch(() => undefined);
      return failed("capability", "capability_unavailable", lease.id);
    }
    if (!isAuthorizedArtifactGitHubCapability(capability)) {
      await executionSession.recordFailure("execution", "claim_not_authorized").catch(() => undefined);
      return failed("capability", "claim_not_authorized", lease.id);
    }
    const leaseGuard = this.capabilities.leaseGuardFor(capability);
    if (!isLeaseGuardForCapability(leaseGuard, capability)) {
      await executionSession.recordFailure("execution", "lease_guard_unavailable").catch(() => undefined);
      return failed("capability", "lease_guard_unavailable", lease.id);
    }

    let writeResult: ArtifactOnlyGitHubWriteResult;
    try { writeResult = await this.writer.write({ context, capability, leaseGuard, executionSession, ...(signal ? { signal } : {}) }); }
    catch {
      const resolution = await executionSession.recordFailure("execution", "writer_unavailable").catch(() => "manual_review" as const);
      return resolution === "manual_review"
        ? { kind: "manual_review", stage: "write", code: "ambiguous_remote_operation", remediationId: context.remediationId,
            proposalId: context.proposalId, artifactHash: context.artifactHash }
        : failed("write", "writer_unavailable", lease.id);
    }
    if (writeResult.kind === "manual_review") {
      try { await executionSession.requireManualReview("execution", writeResult.code); } catch { /* Intent remains the durable recovery fence. */ }
      return { kind: "manual_review", stage: "write", code: writeResult.code, remediationId: context.remediationId,
        proposalId: context.proposalId, artifactHash: context.artifactHash };
    }
    if (writeResult.kind !== "committed" || !isVerifiedArtifactOnlyGitHubWriteResult(writeResult, capability)) {
      if (writeResult.kind === "failed") {
        if (writeResult.code === "rate_limited" && writeResult.rejectionEvidence) {
          try {
            const scheduled = await executionSession.scheduleRateLimitRetry(writeResult.rejectionEvidence);
            if (scheduled === "scheduled") return { kind: "retry_scheduled", stage: "write", code: "rate_limited",
              remediationId: lease.id, retryAfterMs: boundedRetryDelayForOutcome(writeResult.retryAfterMs) };
            if (scheduled === "manual_review") return { kind: "manual_review", stage: "write",
              code: "ambiguous_remote_operation", remediationId: context.remediationId,
              proposalId: context.proposalId, artifactHash: context.artifactHash };
            return failed("write", "rate_limited", lease.id, boundedRetryDelayForOutcome(writeResult.retryAfterMs));
          } catch {
            const resolution = await executionSession.recordFailure(writeResult.rejectionEvidence.stage, "rate_limited")
              .catch(() => "manual_review" as const);
            if (resolution === "manual_review") return { kind: "manual_review", stage: "write",
              code: "ambiguous_remote_operation", remediationId: context.remediationId,
              proposalId: context.proposalId, artifactHash: context.artifactHash };
            return failed("write", "rate_limited", lease.id, boundedRetryDelayForOutcome(writeResult.retryAfterMs));
          }
        }
        const resolution = await executionSession.recordFailure("commit", writeResult.code).catch(() => "manual_review" as const);
        if (resolution === "manual_review") return { kind: "manual_review", stage: "write",
          code: "ambiguous_remote_operation", remediationId: context.remediationId, proposalId: context.proposalId,
          artifactHash: context.artifactHash };
      }
      return failed("write", writeResult.kind === "failed" ? writeResult.code : "unverified_write_result", lease.id,
        writeResult.kind === "failed" ? writeResult.retryAfterMs : undefined);
    }

    // The Git commit may already exist. Loss of authorization here therefore
    // requires reconciliation and must never be reported as an ordinary failure.
    try { await leaseGuard.assertOwned(signal); }
    catch {
      return { kind: "manual_review", stage: "publish", code: "lease_lost_after_write", remediationId: context.remediationId,
        proposalId: context.proposalId, artifactHash: context.artifactHash, commitSha: writeResult.commitSha };
    }

    let publishResult: ArtifactOnlyDraftPullRequestResult;
    try { publishResult = await this.publisher.publish({ writeResult, capability, leaseGuard, executionSession, ...(signal ? { signal } : {}) }); }
    catch {
      await executionSession.requireManualReview("pull_request", "publisher_unavailable", { commitSha: writeResult.commitSha })
        .catch(() => undefined);
      return { kind: "manual_review", stage: "publish", code: "publisher_unavailable", remediationId: context.remediationId,
        proposalId: context.proposalId, artifactHash: context.artifactHash, commitSha: writeResult.commitSha };
    }
    if (publishResult.kind === "draft_pull_request") {
      try { await executionSession.complete(); }
      catch (error) {
        try { await executionSession.requireManualReview("pull_request", "execution_conflict", {
          commitSha: writeResult.commitSha, branchName: publishResult.branchName,
          pullRequestNumber: publishResult.pullRequestNumber, pullRequestUrl: publishResult.pullRequestUrl
        }); } catch { /* The verified remote reference remains in the unresolved result for reconciliation. */ }
        return { kind: "manual_review", stage: "publish",
          code: error instanceof RemediationExecutionPersistenceError ? error.code : "execution_conflict",
          remediationId: context.remediationId,
          proposalId: context.proposalId, artifactHash: context.artifactHash, commitSha: writeResult.commitSha,
          pullRequestNumber: publishResult.pullRequestNumber, pullRequestUrl: publishResult.pullRequestUrl,
          branchName: publishResult.branchName };
      }
      return Object.freeze({ kind: "draft_pull_request", remediationId: context.remediationId, proposalId: context.proposalId,
        artifactHash: publishResult.artifactHash, commitSha: publishResult.commitSha,
        pullRequestNumber: publishResult.pullRequestNumber, pullRequestUrl: publishResult.pullRequestUrl,
        branchName: publishResult.branchName, reconciled: publishResult.reconciled });
    }
    if (publishResult.kind === "manual_review") {
      try { await executionSession.requireManualReview("pull_request", publishResult.code, {
        commitSha: writeResult.commitSha, branchName: publishResult.branchName,
        ...(publishResult.pullRequestNumber ? { pullRequestNumber: publishResult.pullRequestNumber } : {}),
        ...(publishResult.pullRequestUrl ? { pullRequestUrl: publishResult.pullRequestUrl } : {})
      }); } catch { /* Preserve the explicit manual-review return if persistence is unavailable. */ }
      return Object.freeze({ kind: "manual_review", stage: "publish", code: publishResult.code,
        remediationId: context.remediationId, proposalId: context.proposalId, artifactHash: context.artifactHash,
        commitSha: writeResult.commitSha, ...(publishResult.pullRequestNumber ? { pullRequestNumber: publishResult.pullRequestNumber } : {}),
        ...(publishResult.pullRequestUrl ? { pullRequestUrl: publishResult.pullRequestUrl } : {}),
        ...(publishResult.branchName ? { branchName: publishResult.branchName } : {}) });
    }
    // A verified commit already exists, so any publication failure is a
    // reconciliation case even when no PR was created.
    await executionSession.requireManualReview("pull_request", publishResult.code, { commitSha: writeResult.commitSha })
      .catch(() => undefined);
    return Object.freeze({ kind: "manual_review", stage: "publish", code: publishResult.code,
      remediationId: context.remediationId, proposalId: context.proposalId, artifactHash: context.artifactHash,
      commitSha: writeResult.commitSha });
  }
}

function validLeaseSelector(value: unknown): value is RemediationLease {
  if (!value || typeof value !== "object") return false;
  const lease = value as Partial<RemediationLease>;
  return typeof lease.id === "string" && lease.id.length > 0 &&
    typeof lease.tenantId === "string" && lease.tenantId.length > 0 &&
    typeof lease.projectId === "string" && lease.projectId.length > 0 &&
    typeof lease.workerId === "string" && lease.workerId.length > 0 &&
    typeof lease.leaseToken === "string" && lease.leaseToken.length > 0 &&
    Number.isSafeInteger(lease.retriesLeft) && (lease.retriesLeft ?? -1) >= 0;
}

function failed(stage: "claim" | "context" | "capability", code: string, remediationId: string): ArtifactOnlyExecutionOutcome;
function failed(stage: "write", code: string, remediationId: string, retryAfterMs?: number): ArtifactOnlyExecutionOutcome;
function failed(stage: "claim" | "context" | "capability" | "write", code: string, remediationId: string, retryAfterMs?: number): ArtifactOnlyExecutionOutcome {
  return {
    kind: "failed",
    stage,
    code,
    remediationId,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
  };
}

function boundedRetryDelayForOutcome(retryAfterMs: number | undefined): number {
  if (retryAfterMs === undefined || !Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) return 1_000;
  return Math.max(1_000, Math.min(60_000, retryAfterMs));
}
