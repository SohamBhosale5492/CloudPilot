import { createHash, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { mutationRequestHash, type MutationBoundaryScope } from "../github/internal-mutation-boundary.js";
import { hasOrganizationPermission } from "../organizations/permissions.js";
import { REMEDIATION_RETRY_DELAYS_MS, type ExpiredRemediationClaim, type RemediationLease } from "../jobs/remediation-repo.js";
import { isTrustedClaimExecutionContext, type TrustedClaimExecutionContext } from "./trusted-claim-execution-context.js";
import { lockActiveActorForUpdate, lockActiveBindingInstallation, lockActiveMember, lockActiveOrganization } from "./postgres-lock-helpers.js";
import { isAuthorizedArtifactGitHubCapability, type AuthorizedArtifactGitHubCapability } from "../github/github-execution-capability.js";
import { isTrustedGitHubMutationRejectionEvidence, type GitHubMutationRejectionEvidence } from "../github/artifact-only-github-client.js";
import { isVerifiedArtifactOnlyGitHubWriteResult, isVerifiedArtifactWriterMutationReceipt,
  type VerifiedArtifactOnlyGitHubWriteResult } from "./artifact-only-github-writer.js";
import {
  isVerifiedArtifactOnlyDraftPullRequestResult, isVerifiedArtifactOnlyPullRequestCloseResult,
  isVerifiedArtifactPublisherMutationReceipt,
  type VerifiedArtifactOnlyDraftPullRequestResult, type VerifiedArtifactOnlyPullRequestCloseResult
} from "./artifact-only-github-draft-pr-publisher.js";

export type ExecutionStatus = "queued" | "execution_started" | "commit_verified" | "branch_verified" |
  "draft_pr_verified" | "completed" | "failed" | "manual_review_required" | "reconciliation_in_progress" |
  "reconciliation_resolved";
export type ExecutionStage = "execution" | "blob" | "tree" | "commit" | "branch" | "pull_request" | "pull_request_close" | "reconciliation";
export type ExecutionMutationStage = Exclude<ExecutionStage, "execution" | "reconciliation">;

export interface ExecutionMutationIdentity {
  readonly stage: ExecutionMutationStage;
  readonly operationKey: string;
  /** SHA-256 of the canonical, secret-free request identity. */
  readonly requestHash: string;
  /** Secret-free scalar request descriptor used only for restart reconciliation. */
  readonly operation?: Readonly<Record<string, string | number | boolean | null>>;
  /** Exact scalar predicates a read-only lookup must establish. */
  readonly expected?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface UnresolvedExecutionIntent {
  readonly executionId: string;
  readonly attemptNumber: number;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly remediationId: string;
  readonly repositoryBindingId: string;
  readonly installationRecordId: string;
  readonly githubRepositoryId: string;
  readonly artifactHash: string;
  readonly baseRef: string;
  readonly baseCommitSha: string;
  readonly identity: ExecutionMutationIdentity;
  readonly lease: RemediationLease;
  readonly status: ExecutionStatus;
  readonly reconciliationStatus: string;
  readonly commitSha: string | null;
  readonly branchName: string | null;
  readonly pullRequestNumber: number | null;
  readonly pullRequestUrl: string | null;
}

export type VerifiedExecutionRemoteResult =
  | { readonly operationKey: string; readonly capability: AuthorizedArtifactGitHubCapability;
      readonly result: VerifiedArtifactOnlyGitHubWriteResult }
  | { readonly operationKey: string; readonly capability: AuthorizedArtifactGitHubCapability;
      readonly result: VerifiedArtifactOnlyDraftPullRequestResult };

export interface RemediationExecutionSession {
  readonly executionId: string;
  readonly attemptNumber: number;
  recordIntent(input: ExecutionMutationIdentity): Promise<void>;
  recordVerified(input: VerifiedExecutionRemoteResult): Promise<void>;
  recordMutationVerified(input: {
    readonly identity: ExecutionMutationIdentity; readonly capability: AuthorizedArtifactGitHubCapability;
    readonly verificationReceipt: object;
    readonly resourceType: string; readonly resourceId: string;
    readonly commitSha?: string; readonly branchName?: string;
    readonly pullRequestNumber?: number; readonly pullRequestUrl?: string;
  }): Promise<void>;
  scheduleRateLimitRetry(evidence: GitHubMutationRejectionEvidence): Promise<"scheduled" | "failed" | "manual_review">;
  recordFailure(stage: ExecutionStage, code: string): Promise<"failed" | "manual_review">;
  requireManualReview(stage: ExecutionStage, code: string,
    details?: { readonly commitSha?: string; readonly branchName?: string;
      readonly pullRequestNumber?: number; readonly pullRequestUrl?: string }): Promise<void>;
  complete(): Promise<void>;
}

export interface ReconciliationLease {
  readonly executionId: string;
  readonly organizationId: string;
  readonly actorIdentityUserId: string;
  /** One-time in-memory bearer value; only its SHA-256 is persisted. */
  readonly leaseToken: string;
  readonly expiresAt: string;
}

export interface SystemRecoveryLease {
  readonly executionId: string;
  readonly organizationId: string;
  readonly tenantId: string;
  readonly projectId: string;
  /** One-time in-memory bearer; only its SHA-256 is stored in recovery_lease_hash. */
  readonly leaseToken: string;
  readonly expiresAt: string;
}

export class RemediationExecutionPersistenceError extends Error {
  constructor(readonly code: "claim_not_authorized" | "execution_conflict" | "intent_conflict" |
    "invalid_transition" | "reconciliation_not_authorized" | "invalid_input" | "lease_guard_unavailable") {
    super(code);
    this.name = "RemediationExecutionPersistenceError";
  }
}

interface ExecutionRow {
  id: string; tenantId: string; organizationId: string; projectId: string; remediationId: string;
  repositoryBindingId: string; installationRecordId: string; githubRepositoryId: bigint;
  artifactHash: string; baseRef: string; baseCommitSha: string; status: ExecutionStatus;
  stage: ExecutionStage | null; attemptNumber: number; version: bigint; leaseTokenHash: string | null;
  leaseExpiresAt: Date | null; commitSha: string | null; branchName: string | null;
  pullRequestNumber: number | null; pullRequestUrl: string | null; reconciliationStatus: string;
}

type Tx = Prisma.TransactionClient;
interface AuditInput {
  readonly organizationId: string; readonly tenantId: string; readonly projectId: string;
  readonly action: string; readonly targetId: string; readonly metadata: Readonly<Record<string, string | number | null>>;
  readonly actorIdentityUserId?: string;
}
export type ExecutionAuditWriter = (tx: Tx, input: AuditInput) => Promise<void>;

const SYSTEM_ACTOR = "cloudpilot.remediation-executor";
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const BRANCH = /^cloudpilot\/remediation\/[0-9a-f]{40}$/;
const SAFE_FAILURE_CODES = new Set([
  "ambiguous_blob_write", "ambiguous_branch_creation", "ambiguous_commit_write", "ambiguous_pull_request_creation",
  "ambiguous_remote_operation", "ambiguous_tree_write", "authorization_unavailable", "base_mismatch_draft_closed",
  "base_moved_before_pull_request", "base_moved_draft_close_failed", "base_moved_draft_closed", "base_moved_existing_draft",
  "base_ref_moved", "branch_conflict", "cancelled", "capability_unavailable", "claim_not_authorized", "execution_conflict",
  "execution_failed", "github_read_failed", "github_request_failed", "github_write_rejected", "intent_conflict",
  "invalid_claim", "invalid_input", "invalid_response", "invalid_transition", "invalid_token", "invalid_trust_input",
  "lease_guard_unavailable", "lease_lost", "lease_lost_after_write", "network_failure", "not_found",
  "post_write_verification_failed", "pull_request_conflict", "pull_request_verification_failed", "rate_limited", "reconciliation_not_authorized",
  "source_state_mismatch", "timeout", "unverified_write_result", "upstream_failure", "writer_unavailable", "publisher_unavailable",
  "recovery_lease_unavailable"
]);
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_EXECUTION_ATTEMPTS = MAX_RATE_LIMIT_RETRIES + 1;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 1_000;
const sessions = new WeakSet<object>();
const recoveryCandidates = new WeakSet<object>();
export function isRemediationExecutionSession(value: unknown): value is RemediationExecutionSession {
  return !!value && typeof value === "object" && sessions.has(value as object);
}

/** Internal runtime provenance for records freshly loaded from the execution journal. */
export function isPersistedUnresolvedExecutionIntent(value: unknown): value is UnresolvedExecutionIntent {
  return !!value && typeof value === "object" && recoveryCandidates.has(value as object);
}

/**
 * Persists the execution state independently from historical Remediation status.
 * Every remote mutation must have a committed request_intent before it is sent.
 * The intent remains the recovery fence if the process exits before read-back.
 */
export class RemediationExecutionPersistenceService {
  constructor(private readonly prisma: PrismaClient, private readonly auditWriter: ExecutionAuditWriter = writeOrganizationAudit) {}

  /** Discover pending intents from durable rows. Results carry process-local provenance and are reloaded on every run. */
  async discoverUnresolvedIntents(limit = 100): Promise<readonly UnresolvedExecutionIntent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new RemediationExecutionPersistenceError("invalid_input");
    }
    const rows = await this.prisma.$queryRaw<Array<{
      executionId: string; attemptNumber: number; stage: string; operationKey: string; requestHash: string;
      metadata: unknown; status: ExecutionStatus; reconciliationStatus: string; commitSha: string | null;
      branchName: string | null; pullRequestNumber: number | null; pullRequestUrl: string | null;
      remediationId: string; tenantId: string; projectId: string; workerId: string | null;
      organizationId: string; repositoryBindingId: string; installationRecordId: string; githubRepositoryId: bigint;
      artifactHash: string; baseRef: string; baseCommitSha: string;
      leaseToken: string | null; retriesLeft: number; leaseExpiresAt: Date | null;
    }>>`
      SELECT e.id AS "executionId", e.attempt_number AS "attemptNumber", intent.stage,
        intent.operation_key AS "operationKey", intent.request_hash AS "requestHash", intent.metadata,
        e.status, e.reconciliation_status AS "reconciliationStatus", e.commit_sha AS "commitSha",
        e.branch_name AS "branchName", e.pull_request_number AS "pullRequestNumber", e.pull_request_url AS "pullRequestUrl",
        e.organization_id AS "organizationId", e.repository_binding_id AS "repositoryBindingId",
        e.installation_record_id AS "installationRecordId", e.github_repository_id AS "githubRepositoryId",
        e.artifact_hash AS "artifactHash", e.base_ref AS "baseRef", e.base_commit_sha AS "baseCommitSha",
        r.id AS "remediationId", r.tenant_id AS "tenantId", r.project_id AS "projectId", r.worker_id AS "workerId",
        r.lease_token::text AS "leaseToken", r.retries_left AS "retriesLeft", r.lease_expires_at AS "leaseExpiresAt"
      FROM remediation_execution_events intent
      JOIN remediation_executions e ON e.id = intent.execution_id AND e.attempt_number = intent.attempt_number
      JOIN remediations r ON r.id = e.remediation_id AND r.tenant_id = e.tenant_id
        AND r.organization_id = e.organization_id AND r.project_id = e.project_id
      WHERE intent.event_type = 'request_intent'
        AND ((SELECT count(*) FROM remediation_execution_events terminal
          WHERE terminal.execution_id = intent.execution_id AND terminal.attempt_number = intent.attempt_number
            AND terminal.operation_key = intent.operation_key AND terminal.stage = intent.stage
            AND terminal.request_hash = intent.request_hash
            AND terminal.event_type IN ('remote_result_verified', 'remote_mutation_rejected')
            AND (terminal.event_type <> 'remote_mutation_rejected' OR
              terminal.metadata->>'requestFingerprint' = intent.metadata #>> '{expected,requestFingerprint}')) <> 1
          OR NOT EXISTS (SELECT 1 FROM remediation_execution_events done
          WHERE done.execution_id = intent.execution_id AND done.attempt_number = intent.attempt_number
            AND done.operation_key = intent.operation_key AND done.stage = intent.stage
            AND done.request_hash = intent.request_hash
            AND done.event_type IN ('remote_result_verified', 'remote_mutation_rejected')
            AND (done.event_type <> 'remote_mutation_rejected' OR
              done.metadata->>'requestFingerprint' = intent.metadata #>> '{expected,requestFingerprint}')))
      ORDER BY intent.created_at ASC, intent.id ASC
      LIMIT ${limit}
    `;
    const result: UnresolvedExecutionIntent[] = [];
    for (const row of rows) {
      const metadata = asRecord(row.metadata);
      const operation = asScalarRecord(metadata?.operation);
      const expected = asScalarRecord(metadata?.expected);
      const identity: ExecutionMutationIdentity = Object.freeze({ stage: row.stage as ExecutionMutationStage,
        operationKey: row.operationKey, requestHash: row.requestHash,
        ...(operation ? { operation } : {}), ...(expected ? { expected } : {}) });
      const candidate: UnresolvedExecutionIntent = Object.freeze({ executionId: row.executionId,
        attemptNumber: row.attemptNumber, tenantId: row.tenantId, organizationId: row.organizationId,
        projectId: row.projectId, remediationId: row.remediationId, repositoryBindingId: row.repositoryBindingId,
        installationRecordId: row.installationRecordId, githubRepositoryId: row.githubRepositoryId.toString(),
        artifactHash: row.artifactHash, baseRef: row.baseRef, baseCommitSha: row.baseCommitSha, identity,
        lease: Object.freeze({ id: row.remediationId, tenantId: row.tenantId, projectId: row.projectId,
          workerId: row.workerId ?? "", leaseToken: row.leaseToken ?? "", retriesLeft: row.retriesLeft ?? 0 }),
        status: row.status, reconciliationStatus: row.reconciliationStatus, commitSha: row.commitSha,
        branchName: row.branchName, pullRequestNumber: row.pullRequestNumber, pullRequestUrl: row.pullRequestUrl });
      recoveryCandidates.add(candidate);
      result.push(candidate);
    }
    return Object.freeze(result);
  }

  /** Reopen a session only for a freshly discovered, still-pending intent and a live persisted lease. */
  async resumeForRecovery(candidate: UnresolvedExecutionIntent): Promise<RemediationExecutionSession | null> {
    if (!isPersistedUnresolvedExecutionIntent(candidate)) return null;
    const row = await this.prisma.$transaction(async (tx) => {
      const execution = await lockExecution(tx, candidate.lease, candidate.executionId);
      if (execution.attemptNumber !== candidate.attemptNumber || execution.tenantId !== candidate.tenantId ||
          execution.organizationId !== candidate.organizationId || execution.projectId !== candidate.projectId ||
          execution.remediationId !== candidate.remediationId || execution.repositoryBindingId !== candidate.repositoryBindingId ||
          execution.installationRecordId !== candidate.installationRecordId ||
          execution.githubRepositoryId.toString() !== candidate.githubRepositoryId || execution.artifactHash !== candidate.artifactHash ||
          execution.baseRef !== candidate.baseRef || execution.baseCommitSha !== candidate.baseCommitSha) return null;
      const intents = await tx.$queryRaw<Array<{ stage: string; requestHash: string; metadata: unknown }>>`
        SELECT stage, request_hash AS "requestHash", metadata FROM remediation_execution_events
        WHERE execution_id = ${candidate.executionId}::uuid AND attempt_number = ${candidate.attemptNumber}
          AND operation_key = ${candidate.identity.operationKey} AND event_type = 'request_intent'
      `;
      const done = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM remediation_execution_events WHERE execution_id = ${candidate.executionId}::uuid
          AND attempt_number = ${candidate.attemptNumber} AND operation_key = ${candidate.identity.operationKey}
          AND event_type IN ('remote_result_verified', 'remote_mutation_rejected')
      `;
      const metadata = asRecord(intents[0]?.metadata);
      if (intents.length !== 1 || done.length || intents[0]?.stage !== candidate.identity.stage ||
          intents[0]?.requestHash !== candidate.identity.requestHash ||
          canonicalDescriptorEqual(metadata?.operation, candidate.identity.operation) !== true ||
          canonicalDescriptorEqual(metadata?.expected, candidate.identity.expected) !== true) return null;
      return execution;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return row ? this.makeSession(candidate.lease, row) : null;
  }

  /** Fail-closed durable escalation when an intent cannot be proved or its worker lease expired. */
  async requireRecoveryReview(candidate: UnresolvedExecutionIntent, actorIdentityUserId: string,
    code = "ambiguous_remote_operation", recoveryLease?: SystemRecoveryLease): Promise<boolean> {
    validateCode(code);
    if (!isPersistedUnresolvedExecutionIntent(candidate) || !validIdentityUserId(actorIdentityUserId)) return false;
    if (recoveryLease) {
      if (recoveryLease.executionId !== candidate.executionId ||
          recoveryLease.organizationId !== candidate.organizationId ||
          recoveryLease.tenantId !== candidate.tenantId ||
          recoveryLease.projectId !== candidate.projectId) {
        return false;
      }
    }
    const tokenHash = recoveryLease ? hash(recoveryLease.leaseToken) : null;
    return this.prisma.$transaction(async (tx) => {
      const role = await lockActiveActorForUpdate(tx, candidate.organizationId, actorIdentityUserId);
      if (!role || !hasOrganizationPermission(role, "remediation:approve")) return false;
      const rows = await tx.$queryRaw<ExecutionRow[]>`
        SELECT e.id, e.tenant_id AS "tenantId", e.organization_id AS "organizationId", e.project_id AS "projectId",
          e.remediation_id AS "remediationId", e.repository_binding_id AS "repositoryBindingId",
          e.installation_record_id AS "installationRecordId", e.github_repository_id AS "githubRepositoryId",
          e.artifact_hash AS "artifactHash", e.base_ref AS "baseRef", e.base_commit_sha AS "baseCommitSha",
          e.status, e.stage, e.attempt_number AS "attemptNumber", e.version, e.lease_token_hash AS "leaseTokenHash",
          e.lease_expires_at AS "leaseExpiresAt", e.commit_sha AS "commitSha", e.branch_name AS "branchName",
          e.pull_request_number AS "pullRequestNumber", e.pull_request_url AS "pullRequestUrl",
          e.reconciliation_status AS "reconciliationStatus"
        FROM remediation_executions e
        WHERE e.id = ${candidate.executionId}::uuid AND e.tenant_id = ${candidate.tenantId}
          AND e.organization_id = ${candidate.organizationId}::uuid AND e.project_id = ${candidate.projectId}
          AND e.remediation_id = ${candidate.remediationId} AND e.repository_binding_id = ${candidate.repositoryBindingId}::uuid
          AND e.github_repository_id = ${candidate.githubRepositoryId}::bigint AND e.artifact_hash = ${candidate.artifactHash}
          AND e.base_ref = ${candidate.baseRef} AND e.base_commit_sha = ${candidate.baseCommitSha}
          AND e.status NOT IN ('completed', 'reconciliation_resolved')
          ${recoveryLease ? Prisma.sql`AND e.recovery_lease_hash = ${tokenHash} AND e.recovery_lease_until > clock_timestamp()` : Prisma.empty}
        FOR UPDATE OF e
      `;
      const row = rows[0];
      if (!row) return false;
      if (row.reconciliationStatus === "in_progress" || row.status === "reconciliation_in_progress") return false;
      const intents = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM remediation_execution_events WHERE execution_id = ${row.id}::uuid
          AND attempt_number = ${candidate.attemptNumber} AND operation_key = ${candidate.identity.operationKey}
          AND request_hash = ${candidate.identity.requestHash} AND stage = ${candidate.identity.stage}
          AND event_type = 'request_intent'
      `;
      const done = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM remediation_execution_events WHERE execution_id = ${row.id}::uuid
          AND attempt_number = ${candidate.attemptNumber} AND operation_key = ${candidate.identity.operationKey}
          AND event_type = 'remote_result_verified'
      `;
      if (intents.length !== 1 || done.length) return false;
      if (!recoveryLease && row.status === "manual_review_required" && row.reconciliationStatus === "required") return true;
      return transitionToManualReview(tx, row, candidate.identity.stage, code, this.auditWriter, {
        ...(row.commitSha ? { commitSha: row.commitSha } : {}), ...(row.branchName ? { branchName: row.branchName } : {}),
        ...(row.pullRequestNumber && row.pullRequestUrl ? { pullRequestNumber: row.pullRequestNumber, pullRequestUrl: row.pullRequestUrl } : {})
      }, recoveryLease);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async start(lease: RemediationLease, context: TrustedClaimExecutionContext): Promise<RemediationExecutionSession | null> {
    if (!isTrustedClaimExecutionContext(context) || !leaseMatchesContext(lease, context)) return null;
    const row = await this.prisma.$transaction(
      (tx) => this.startWithinTransaction(tx, lease, context),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    return row ? this.makeSession(lease, row) : null;
  }

  /** Starts or resumes an execution inside the queue's existing serializable claim transaction. */
  async startWithinTransaction(tx: Tx, lease: RemediationLease,
    context: TrustedClaimExecutionContext): Promise<ExecutionRow | null> {
    if (!isTrustedClaimExecutionContext(context) || !leaseMatchesContext(lease, context)) return null;
    const tokenHash = hash(lease.leaseToken);
      const parent = await lockAuthorizedRemediation(tx, lease, context);
      if (!parent) return null;
      const existing = await tx.$queryRaw<ExecutionRow[]>`
        SELECT id, tenant_id AS "tenantId", organization_id AS "organizationId", project_id AS "projectId",
          remediation_id AS "remediationId", repository_binding_id AS "repositoryBindingId",
          installation_record_id AS "installationRecordId", github_repository_id AS "githubRepositoryId",
          artifact_hash AS "artifactHash", base_ref AS "baseRef", base_commit_sha AS "baseCommitSha",
          status, stage, attempt_number AS "attemptNumber", version, lease_token_hash AS "leaseTokenHash",
          lease_expires_at AS "leaseExpiresAt", commit_sha AS "commitSha", branch_name AS "branchName",
          pull_request_number AS "pullRequestNumber", pull_request_url AS "pullRequestUrl",
          reconciliation_status AS "reconciliationStatus"
        FROM remediation_executions
        WHERE tenant_id = ${context.tenantId} AND organization_id = ${context.organizationId}::uuid
          AND project_id = ${context.projectId} AND remediation_id = ${context.remediationId}
        FOR UPDATE
      `;
      let execution = existing[0];
      if (execution) {
        if (!sameSnapshot(execution, context)) throw new RemediationExecutionPersistenceError("execution_conflict");
        if (execution.status === "completed" || execution.status === "manual_review_required" ||
            execution.status === "reconciliation_in_progress" || execution.status === "reconciliation_resolved") {
          throw new RemediationExecutionPersistenceError("invalid_transition");
        }
        const pendingIntents = await pendingIntentCount(tx, execution);
        if (pendingIntents > 0) {
          await transitionToManualReview(tx, execution, "execution", "ambiguous_remote_operation", this.auditWriter);
          await settleRunningRemediation(tx, lease, "failed", "Execution requires manual review after an unresolved remote operation.");
          return null;
        }
        if (execution.leaseTokenHash === tokenHash) {
          const leaseState = await tx.$queryRaw<Array<{ valid: boolean }>>`
            SELECT lease_expires_at > clock_timestamp() AS valid
            FROM remediation_executions WHERE id = ${execution.id}::uuid
          `;
          if (leaseState[0]?.valid) return execution;
        }
        if (execution.status !== "failed" && execution.status !== "queued") {
          throw new RemediationExecutionPersistenceError("invalid_transition");
        }
        const nextAttempt = execution.attemptNumber + 1;
        const updated = await tx.$queryRaw<ExecutionRow[]>`
          UPDATE remediation_executions SET status = 'execution_started', stage = NULL, retry_eligible_at = NULL,
            attempt_number = ${nextAttempt}, version = version + 1,
            lease_owner = ${lease.workerId}, lease_token_hash = ${tokenHash},
            lease_expires_at = (SELECT lease_expires_at FROM remediations WHERE id = ${lease.id}),
            started_at = clock_timestamp(), failure_stage = NULL, failure_code = NULL,
            completed_at = NULL, updated_at = clock_timestamp()
          WHERE id = ${execution.id}::uuid AND version = ${execution.version}
            AND (retry_eligible_at IS NULL OR retry_eligible_at <= clock_timestamp())
          RETURNING id, tenant_id AS "tenantId", organization_id AS "organizationId", project_id AS "projectId",
            remediation_id AS "remediationId", repository_binding_id AS "repositoryBindingId",
            installation_record_id AS "installationRecordId", github_repository_id AS "githubRepositoryId",
            artifact_hash AS "artifactHash", base_ref AS "baseRef", base_commit_sha AS "baseCommitSha",
            status, stage, attempt_number AS "attemptNumber", version, lease_token_hash AS "leaseTokenHash",
            lease_expires_at AS "leaseExpiresAt", commit_sha AS "commitSha", branch_name AS "branchName",
            pull_request_number AS "pullRequestNumber", pull_request_url AS "pullRequestUrl",
            reconciliation_status AS "reconciliationStatus"
        `;
        execution = updated[0];
        if (!execution) throw new RemediationExecutionPersistenceError("execution_conflict");
        await appendEvent(tx, execution, "execution_started", "execution", null, null, null, null, null, null, null);
        await this.auditWriter(tx, auditFor(execution, "REMEDIATION_EXECUTION_STARTED", { attemptNumber: nextAttempt }));
        return execution;
      }

      const executionId = randomUUID();
      const inserted = await tx.$queryRaw<ExecutionRow[]>`
        INSERT INTO remediation_executions (
          id, tenant_id, organization_id, project_id, remediation_id, repository_binding_id,
          installation_record_id, github_repository_id, artifact_hash, base_ref, base_commit_sha,
          status, attempt_number, version, lease_owner, lease_token_hash, lease_expires_at, started_at,
          created_at, updated_at
        ) VALUES (
          ${executionId}::uuid, ${context.tenantId}, ${context.organizationId}::uuid, ${context.projectId},
          ${context.remediationId}, ${context.repositoryBindingId}::uuid, ${context.installationRecordId}::uuid,
          ${context.githubRepositoryId}::bigint, ${context.artifactHash}, ${context.baseRef}, ${context.baseCommitSha},
          'execution_started', 1, 0, ${lease.workerId}, ${tokenHash},
          (SELECT lease_expires_at FROM remediations WHERE id = ${lease.id}), clock_timestamp(), clock_timestamp(), clock_timestamp()
        ) RETURNING id, tenant_id AS "tenantId", organization_id AS "organizationId", project_id AS "projectId",
          remediation_id AS "remediationId", repository_binding_id AS "repositoryBindingId",
          installation_record_id AS "installationRecordId", github_repository_id AS "githubRepositoryId",
          artifact_hash AS "artifactHash", base_ref AS "baseRef", base_commit_sha AS "baseCommitSha",
          status, stage, attempt_number AS "attemptNumber", version, lease_token_hash AS "leaseTokenHash",
          lease_expires_at AS "leaseExpiresAt", commit_sha AS "commitSha", branch_name AS "branchName",
          pull_request_number AS "pullRequestNumber", pull_request_url AS "pullRequestUrl",
          reconciliation_status AS "reconciliationStatus"
      `;
      execution = inserted[0];
      if (!execution) throw new RemediationExecutionPersistenceError("execution_conflict");
      await appendEvent(tx, execution, "execution_started", "execution", null, null, null, null, null, null, null);
      await this.auditWriter(tx, auditFor(execution, "REMEDIATION_EXECUTION_STARTED", { attemptNumber: 1 }));
      return execution;
  }

  /**
   * Reaps an expired queue lease while holding the remediation row first and
   * execution row second. Only an execution with no remote mutation intent or
   * verified remote result may return to the queue.
   */
  async expireClaimWithinTransaction(tx: Tx, lease: ExpiredRemediationClaim): Promise<"requeued" | "failed" | "manual_review" | "terminal"> {
    const executionRows = await tx.$queryRaw<ExecutionRow[]>`
      SELECT e.id, e.tenant_id AS "tenantId", e.organization_id AS "organizationId", e.project_id AS "projectId",
        e.remediation_id AS "remediationId", e.repository_binding_id AS "repositoryBindingId",
        e.installation_record_id AS "installationRecordId", e.github_repository_id AS "githubRepositoryId",
        e.artifact_hash AS "artifactHash", e.base_ref AS "baseRef", e.base_commit_sha AS "baseCommitSha",
        e.status, e.stage, e.attempt_number AS "attemptNumber", e.version, e.lease_token_hash AS "leaseTokenHash",
        e.lease_expires_at AS "leaseExpiresAt", e.commit_sha AS "commitSha", e.branch_name AS "branchName",
        e.pull_request_number AS "pullRequestNumber", e.pull_request_url AS "pullRequestUrl",
        e.reconciliation_status AS "reconciliationStatus"
      FROM remediation_executions e
      WHERE e.tenant_id = ${lease.tenantId} AND e.project_id = ${lease.projectId} AND e.remediation_id = ${lease.id}
      FOR UPDATE
    `;
    const execution = executionRows[0];
    if (!execution) {
      // Legacy running rows without an execution aggregate are not safe retry
      // evidence. Fail closed instead of treating queue status as authority.
      await this.settleExpiredQueueRow(tx, lease, "failed", "Durable execution record is missing; manual review is required.");
      return "failed";
    }
    if (execution.leaseTokenHash !== hash(lease.leaseToken)) {
      await this.settleExpiredQueueRow(tx, lease, "failed", "Execution lease state is inconsistent; manual review is required.");
      return "failed";
    }

    const unresolvedIntentCount = await pendingIntentCount(tx, execution);
    const remoteSuccess = await tx.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM remediation_execution_events
        WHERE execution_id = ${execution.id}::uuid AND event_type = 'remote_result_verified') AS exists
    `;
    const hasRemoteHistory = unresolvedIntentCount > 0 || remoteSuccess[0]?.exists === true;
    const terminal = execution.status === "completed" || execution.status === "manual_review_required" ||
      execution.status === "reconciliation_in_progress" || execution.status === "reconciliation_resolved";
    if (terminal) {
      const projection = execution.status === "completed" ? "open" : "failed";
      await this.settleExpiredQueueRow(tx, lease, projection, null);
      return "terminal";
    }
    if (hasRemoteHistory || !["execution_started", "queued", "failed"].includes(execution.status)) {
      if (execution.status !== "manual_review_required") {
        await transitionToManualReview(tx, execution, execution.stage ?? "execution", "ambiguous_remote_operation", this.auditWriter);
      }
      await this.settleExpiredQueueRow(tx, lease, "failed", "Execution requires manual review after an expired lease.");
      return "manual_review";
    }

    if (execution.status !== "failed") {
      const changed = await tx.$executeRaw`
        UPDATE remediation_executions SET status = 'failed', stage = 'execution', failure_stage = 'execution',
          failure_code = 'lease_lost', lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
          version = version + 1, updated_at = clock_timestamp()
        WHERE id = ${execution.id}::uuid AND version = ${execution.version}
          AND lease_token_hash = ${hash(lease.leaseToken)} AND lease_expires_at <= clock_timestamp()
      `;
      if (changed !== 1) return "terminal";
      await appendEvent(tx, execution, "execution_failed", "execution", null, null, null, null, null, null, null,
        undefined, null, "lease_lost");
      await this.auditWriter(tx, auditFor(execution, "REMEDIATION_EXECUTION_LEASE_EXPIRED", {
        attemptNumber: execution.attemptNumber, code: "lease_lost"
      }));
    }

    const shouldRetry = lease.retriesLeft > 0;
    const nextRetries = shouldRetry ? lease.retriesLeft - 1 : 0;
    const delayMs = shouldRetry ? REMEDIATION_RETRY_DELAYS_MS[
      Math.min(REMEDIATION_RETRY_DELAYS_MS.length - 1, Math.max(0, 3 - lease.retriesLeft))
    ]! : 0;
    await this.settleExpiredQueueRow(tx, lease, shouldRetry ? "pending" : "failed",
      shouldRetry ? "Worker lease expired before any remote mutation." : "Worker lease expired before completion.",
      nextRetries, delayMs);
    await this.auditWriter(tx, auditFor(execution, shouldRetry ? "REMEDIATION_EXECUTION_RETRY_QUEUED" :
      "REMEDIATION_EXECUTION_FAILED", { attemptNumber: execution.attemptNumber, retriesLeft: nextRetries, delayMs }));
    return shouldRetry ? "requeued" : "failed";
  }

  private async settleExpiredQueueRow(tx: Tx, lease: ExpiredRemediationClaim, status: "pending" | "failed" | "open",
    message: string | null, retriesLeft = 0, delayMs = 0): Promise<void> {
    const changed = await tx.$executeRaw`
      UPDATE remediations SET status = ${status}, retries_left = ${retriesLeft},
        next_attempt_at = CASE WHEN ${status} = 'pending' THEN clock_timestamp() + (${delayMs} * INTERVAL '1 millisecond') ELSE NULL END,
        error_message = ${message}, worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL,
        lease_expires_at = NULL, lease_token = NULL, updated_at = clock_timestamp()
      WHERE id = ${lease.id} AND tenant_id = ${lease.tenantId} AND project_id = ${lease.projectId}
        AND status = 'running' AND worker_id = ${lease.workerId} AND lease_token = ${lease.leaseToken}::uuid
        AND lease_expires_at <= clock_timestamp()
    `;
    if (changed !== 1) throw new RemediationExecutionPersistenceError("execution_conflict");
  }

  async beginReconciliation(input: { executionId: string; actorIdentityUserId: string }): Promise<ReconciliationLease | null> {
    const token = randomUUID();
    const tokenHash = hash(token);
    return this.prisma.$transaction(async (tx) => {
      const scope = await tx.$queryRaw<Array<{ organizationId: string }>>`
        SELECT organization_id AS "organizationId" FROM remediation_executions
        WHERE id = ${input.executionId}::uuid AND status = 'manual_review_required'
          AND (reconciliation_status = 'required' OR
            (reconciliation_status = 'in_progress' AND reconciliation_lease_until <= clock_timestamp()))
      `;
      if (scope.length !== 1) return null;
      const actorRole = await lockActiveActorForUpdate(tx, scope[0]!.organizationId, input.actorIdentityUserId);
      if (!actorRole || !hasOrganizationPermission(actorRole, "remediation:approve")) return null;
      const rows = await tx.$queryRaw<ExecutionRow[]>`
        SELECT e.id, e.tenant_id AS "tenantId", e.organization_id AS "organizationId", e.project_id AS "projectId",
          e.remediation_id AS "remediationId", e.repository_binding_id AS "repositoryBindingId",
          e.installation_record_id AS "installationRecordId", e.github_repository_id AS "githubRepositoryId",
          e.artifact_hash AS "artifactHash", e.base_ref AS "baseRef", e.base_commit_sha AS "baseCommitSha",
          e.status, e.stage, e.attempt_number AS "attemptNumber", e.version, e.lease_token_hash AS "leaseTokenHash",
          e.lease_expires_at AS "leaseExpiresAt", e.commit_sha AS "commitSha", e.branch_name AS "branchName",
          e.pull_request_number AS "pullRequestNumber", e.pull_request_url AS "pullRequestUrl",
          e.reconciliation_status AS "reconciliationStatus"
        FROM remediation_executions e
        WHERE e.id = ${input.executionId}::uuid AND e.status = 'manual_review_required'
          AND (e.reconciliation_status = 'required' OR
            (e.reconciliation_status = 'in_progress' AND e.reconciliation_lease_until <= clock_timestamp()))
        FOR UPDATE OF e
      `;
      const execution = rows[0];
      if (!execution) return null;
      const updated = await tx.$queryRaw<Array<{ expiresAt: Date }>>`
        UPDATE remediation_executions SET status = 'reconciliation_in_progress', reconciliation_status = 'in_progress',
          reconciliation_started_at = COALESCE(reconciliation_started_at, clock_timestamp()),
          reconciliation_actor_id = ${input.actorIdentityUserId}::uuid,
          reconciliation_lease_hash = ${tokenHash},
          reconciliation_lease_until = clock_timestamp() + INTERVAL '5 minutes',
          version = version + 1, updated_at = clock_timestamp()
        WHERE id = ${input.executionId}::uuid AND version = ${execution.version}
        RETURNING reconciliation_lease_until AS "expiresAt"
      `;
      if (updated.length !== 1) return null;
      const next = { ...execution, status: "reconciliation_in_progress" as const, reconciliationStatus: "in_progress" };
      await appendEvent(tx, next, "reconciliation_started", "reconciliation", null, null, null, null, null, null, null, input.actorIdentityUserId);
      await this.auditWriter(tx, auditFor(next, "REMEDIATION_EXECUTION_RECONCILIATION_STARTED", {}, input.actorIdentityUserId));
      return Object.freeze({ executionId: input.executionId, organizationId: execution.organizationId,
        actorIdentityUserId: input.actorIdentityUserId, leaseToken: token,
        expiresAt: updated[0]!.expiresAt.toISOString() });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  /** Persists a PR-close request before a future reconciler performs that mutation. */
  async recordReconciliationIntent(lease: ReconciliationLease, input: ExecutionMutationIdentity): Promise<void> {
    validateMutationIdentity(input);
    if (input.stage !== "pull_request_close") throw new RemediationExecutionPersistenceError("invalid_input");
    await this.prisma.$transaction(async (tx) => {
      const row = await lockReconciliationExecution(tx, lease);
      if (input.operation || input.expected) {
        if (!input.operation || !input.expected ||
            input.operationKey !== `pull_request_close:${mutationRequestHash("pull_request_close",
              mutationScopeForRow(row), input.operation, input.expected)}` ||
            input.requestHash !== mutationRequestHash("pull_request_close", mutationScopeForRow(row), input.operation, input.expected)) {
          throw new RemediationExecutionPersistenceError("invalid_input");
        }
      }
      const prior = await tx.$queryRaw<Array<{ requestHash: string; stage: string }>>`
        SELECT request_hash AS "requestHash", stage FROM remediation_execution_events
        WHERE execution_id = ${row.id}::uuid AND attempt_number = ${row.attemptNumber}
          AND operation_key = ${input.operationKey} AND event_type = 'request_intent'
      `;
      // A prior intent is ambiguous by definition; never report it as permission to repeat the close.
      if (prior.length) throw new RemediationExecutionPersistenceError("intent_conflict");
      const updated = await tx.$executeRaw`
        UPDATE remediation_executions SET stage = 'pull_request_close', version = version + 1,
          updated_at = clock_timestamp()
        WHERE id = ${row.id}::uuid AND version = ${row.version}
          AND reconciliation_lease_hash = ${hash(lease.leaseToken)}
          AND reconciliation_lease_until > clock_timestamp()
      `;
      if (updated !== 1) throw new RemediationExecutionPersistenceError("execution_conflict");
      await appendEvent(tx, row, "request_intent", "pull_request_close", input.operationKey, input.requestHash,
        null, null, row.branchName, row.commitSha, row.pullRequestNumber, lease.actorIdentityUserId, row.pullRequestUrl,
        null, intentDescriptorMetadata(input));
      await this.auditWriter(tx, auditFor(row, "REMEDIATION_EXECUTION_RECONCILIATION_INTENT",
        { stage: "pull_request_close", operationKey: input.operationKey, requestHash: input.requestHash }, lease.actorIdentityUserId));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  /** Persists only a publisher-branded read-back proving the intended draft was closed. */
  async recordReconciliationVerifiedClose(lease: ReconciliationLease, input: {
    readonly operationKey: string; readonly capability: AuthorizedArtifactGitHubCapability;
    readonly result: VerifiedArtifactOnlyPullRequestCloseResult;
  }): Promise<void> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.operationKey) ||
        !isAuthorizedArtifactGitHubCapability(input.capability) ||
        !isVerifiedArtifactOnlyPullRequestCloseResult(input.result, input.capability)) {
      throw new RemediationExecutionPersistenceError("invalid_input");
    }
    await this.prisma.$transaction(async (tx) => {
      const row = await lockReconciliationExecution(tx, lease);
      const result = input.result;
      if (!capabilityMatchesExecution(input.capability, row) || result.artifactHash !== row.artifactHash ||
          (row.commitSha !== null && result.commitSha !== row.commitSha) ||
          (row.branchName !== null && result.branchName !== row.branchName) ||
          (row.pullRequestNumber !== null && result.pullRequestNumber !== row.pullRequestNumber) ||
          (row.pullRequestUrl !== null && result.pullRequestUrl !== row.pullRequestUrl)) {
        throw new RemediationExecutionPersistenceError("invalid_input");
      }
      const intent = await tx.$queryRaw<Array<{ requestHash: string }>>`
        SELECT request_hash AS "requestHash" FROM remediation_execution_events
        WHERE execution_id = ${row.id}::uuid AND attempt_number = ${row.attemptNumber}
          AND operation_key = ${input.operationKey} AND event_type = 'request_intent' AND stage = 'pull_request_close'
      `;
      if (intent.length !== 1) throw new RemediationExecutionPersistenceError("invalid_transition");
      const updated = await tx.$executeRaw`
        UPDATE remediation_executions SET commit_sha = COALESCE(commit_sha, ${result.commitSha}),
          commit_verified_at = COALESCE(commit_verified_at, clock_timestamp()),
          branch_name = COALESCE(branch_name, ${result.branchName}),
          branch_verified_at = COALESCE(branch_verified_at, clock_timestamp()),
          pull_request_number = COALESCE(pull_request_number, ${result.pullRequestNumber}),
          pull_request_url = COALESCE(pull_request_url, ${result.pullRequestUrl}),
          pull_request_verified_at = COALESCE(pull_request_verified_at, clock_timestamp()),
          version = version + 1, updated_at = clock_timestamp()
        WHERE id = ${row.id}::uuid AND version = ${row.version}
          AND reconciliation_lease_hash = ${hash(lease.leaseToken)}
          AND reconciliation_lease_until > clock_timestamp()
      `;
      if (updated !== 1) throw new RemediationExecutionPersistenceError("execution_conflict");
      await appendEvent(tx, row, "remote_result_verified", "pull_request_close", input.operationKey,
        intent[0]!.requestHash, "pull_request_close", String(result.pullRequestNumber), result.branchName,
        result.commitSha, result.pullRequestNumber, lease.actorIdentityUserId, result.pullRequestUrl, result.code);
      await this.auditWriter(tx, auditFor(row, "REMEDIATION_EXECUTION_RECONCILIATION_RESULT_VERIFIED", {
        operationKey: input.operationKey, pullRequestNumber: result.pullRequestNumber,
        code: result.code, artifactHash: row.artifactHash
      }, lease.actorIdentityUserId));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async resolveReconciliation(input: { lease: ReconciliationLease; outcome: "completed" | "failed" | "manual_review_required";
    code?: string; completionEvidence?: { capability: AuthorizedArtifactGitHubCapability;
      result: VerifiedArtifactOnlyDraftPullRequestResult } }): Promise<boolean> {
    if (input.code !== undefined) validateCode(input.code);
    if (input.outcome === "completed" && !input.completionEvidence) return false;
    if (input.outcome !== "completed" && input.completionEvidence) return false;
    return this.prisma.$transaction(async (tx) => {
      const actorRole = await lockActiveActorForUpdate(tx, input.lease.organizationId, input.lease.actorIdentityUserId);
      if (actorRole !== "owner" && actorRole !== "admin") return false;
      const execution = await tx.$queryRaw<ExecutionRow[]>`
        SELECT e.id, e.tenant_id AS "tenantId", e.organization_id AS "organizationId", e.project_id AS "projectId",
          e.remediation_id AS "remediationId", e.repository_binding_id AS "repositoryBindingId",
          e.installation_record_id AS "installationRecordId", e.github_repository_id AS "githubRepositoryId",
          e.artifact_hash AS "artifactHash", e.base_ref AS "baseRef", e.base_commit_sha AS "baseCommitSha",
          e.status, e.stage, e.attempt_number AS "attemptNumber", e.version, e.lease_token_hash AS "leaseTokenHash",
          e.lease_expires_at AS "leaseExpiresAt", e.commit_sha AS "commitSha", e.branch_name AS "branchName",
          e.pull_request_number AS "pullRequestNumber", e.pull_request_url AS "pullRequestUrl",
          e.reconciliation_status AS "reconciliationStatus"
        FROM remediation_executions e
        WHERE e.id = ${input.lease.executionId}::uuid AND e.organization_id = ${input.lease.organizationId}::uuid
          AND e.status = 'reconciliation_in_progress' AND e.reconciliation_status = 'in_progress'
          AND e.reconciliation_actor_id = ${input.lease.actorIdentityUserId}::uuid
          AND e.reconciliation_lease_hash = ${hash(input.lease.leaseToken)}
          AND e.reconciliation_lease_until > clock_timestamp()
        FOR UPDATE OF e
      `;
      const row = execution[0];
      if (!row) return false;
      if (input.outcome === "completed") {
        const evidence = input.completionEvidence!;
        if (!isVerifiedArtifactOnlyDraftPullRequestResult(evidence.result, evidence.capability) ||
            !capabilityMatchesExecution(evidence.capability, row) || evidence.result.artifactHash !== row.artifactHash ||
            (row.commitSha !== null && evidence.result.commitSha !== row.commitSha) ||
            (row.branchName !== null && evidence.result.branchName !== row.branchName) ||
            (row.pullRequestNumber !== null && evidence.result.pullRequestNumber !== row.pullRequestNumber) ||
            (row.pullRequestUrl !== null && evidence.result.pullRequestUrl !== row.pullRequestUrl)) return false;
      }
      const status = input.outcome === "completed" ? "completed" :
        input.outcome === "manual_review_required" ? "manual_review_required" : "reconciliation_resolved";
      const updated = await tx.$executeRaw`
        UPDATE remediation_executions SET status = ${status}, reconciliation_status = 'resolved',
          reconciliation_outcome = ${input.outcome}, reconciled_at = clock_timestamp(),
          reconciliation_lease_hash = NULL, reconciliation_lease_until = NULL,
          commit_sha = CASE WHEN ${input.outcome} = 'completed' THEN ${input.completionEvidence?.result.commitSha ?? null} ELSE commit_sha END,
          commit_verified_at = CASE WHEN ${input.outcome} = 'completed' THEN COALESCE(commit_verified_at, clock_timestamp()) ELSE commit_verified_at END,
          branch_name = CASE WHEN ${input.outcome} = 'completed' THEN ${input.completionEvidence?.result.branchName ?? null} ELSE branch_name END,
          branch_verified_at = CASE WHEN ${input.outcome} = 'completed' THEN COALESCE(branch_verified_at, clock_timestamp()) ELSE branch_verified_at END,
          pull_request_number = CASE WHEN ${input.outcome} = 'completed' THEN ${input.completionEvidence?.result.pullRequestNumber ?? null} ELSE pull_request_number END,
          pull_request_url = CASE WHEN ${input.outcome} = 'completed' THEN ${input.completionEvidence?.result.pullRequestUrl ?? null} ELSE pull_request_url END,
          pull_request_verified_at = CASE WHEN ${input.outcome} = 'completed' THEN clock_timestamp() ELSE pull_request_verified_at END,
          completed_at = CASE WHEN ${input.outcome} = 'completed' THEN clock_timestamp() ELSE completed_at END,
          failure_code = ${input.outcome === "completed" ? null : input.code ?? null},
          failure_stage = CASE WHEN ${input.outcome} = 'manual_review_required' THEN 'reconciliation' ELSE NULL END,
          version = version + 1, updated_at = clock_timestamp()
        WHERE id = ${row.id}::uuid AND version = ${row.version} AND reconciliation_lease_hash = ${hash(input.lease.leaseToken)}
          AND reconciliation_lease_until > clock_timestamp()
      `;
      if (updated !== 1) return false;
      const next = { ...row, status: status as ExecutionStatus, reconciliationStatus: "resolved",
        ...(input.outcome === "completed" ? {
          commitSha: input.completionEvidence!.result.commitSha,
          branchName: input.completionEvidence!.result.branchName,
          pullRequestNumber: input.completionEvidence!.result.pullRequestNumber,
          pullRequestUrl: input.completionEvidence!.result.pullRequestUrl
        } : {}) };
      await appendEvent(tx, next, "reconciliation_resolved", "reconciliation", null, null,
        input.outcome, null, row.branchName, row.commitSha, row.pullRequestNumber, input.lease.actorIdentityUserId,
        row.pullRequestUrl, input.code ?? null);
      await this.auditWriter(tx, auditFor(next, "REMEDIATION_EXECUTION_RECONCILIATION_RESOLVED",
        { outcome: input.outcome, code: input.code ?? null }, input.lease.actorIdentityUserId));
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  /**
   * Atomically claims the system recovery lease on an execution that is in
   * manual_review_required / reconciliation_status=required state.
   * Only one concurrent automated recovery worker may hold this lease at a time.
   * An expired lease is taken over. Never grants human reconciliation authority.
   */
  async claimSystemRecoveryLease(input: {
    readonly executionId: string;
    readonly organizationId: string;
    readonly tenantId: string;
    readonly projectId: string;
    readonly recoveryOwnerId: string;
  }): Promise<SystemRecoveryLease | null> {
    const token = randomUUID();
    const tokenHash = hash(token);
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        id: string; version: bigint; tenantId: string; organizationId: string; projectId: string;
        status: string; reconciliationStatus: string;
        recoveryLeaseUntil: Date | null; recoveryLeaseHash: string | null;
      }>>`
        SELECT e.id, e.version, e.tenant_id AS "tenantId", e.organization_id AS "organizationId",
          e.project_id AS "projectId", e.status, e.reconciliation_status AS "reconciliationStatus",
          e.recovery_lease_until AS "recoveryLeaseUntil", e.recovery_lease_hash AS "recoveryLeaseHash"
        FROM remediation_executions e
        WHERE e.id = ${input.executionId}::uuid AND e.tenant_id = ${input.tenantId}
          AND e.organization_id = ${input.organizationId}::uuid AND e.project_id = ${input.projectId}
          AND e.status = 'manual_review_required' AND e.reconciliation_status = 'required'
        FOR UPDATE
      `;
      const row = rows[0];
      if (!row) return null;
      // Allow takeover if lease is absent or expired.
      if (row.recoveryLeaseUntil !== null && row.recoveryLeaseUntil > new Date()) return null;
      const updated = await tx.$queryRaw<Array<{ expiresAt: Date }>>`
        UPDATE remediation_executions
          SET recovery_lease_hash  = ${tokenHash},
              recovery_lease_until = clock_timestamp() + INTERVAL '10 minutes',
              recovery_lease_owner = ${input.recoveryOwnerId},
              version = version + 1, updated_at = clock_timestamp()
        WHERE id = ${input.executionId}::uuid AND version = ${row.version}
        RETURNING recovery_lease_until AS "expiresAt"
      `;
      if (updated.length !== 1) return null;
      await this.auditWriter(tx, {
        organizationId: input.organizationId, tenantId: input.tenantId, projectId: input.projectId,
        action: "REMEDIATION_EXECUTION_SYSTEM_RECOVERY_CLAIMED",
        targetId: input.executionId,
        metadata: { recoveryOwnerId: input.recoveryOwnerId }
      });
      return Object.freeze({
        executionId: input.executionId, organizationId: input.organizationId,
        tenantId: input.tenantId, projectId: input.projectId,
        leaseToken: token, expiresAt: updated[0]!.expiresAt.toISOString()
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  /** Renews the system recovery lease to prevent expiry during a long read-back operation. */
  async renewSystemRecoveryLease(lease: SystemRecoveryLease): Promise<boolean> {
    const tokenHash = hash(lease.leaseToken);
    const updated = await this.prisma.$executeRaw`
      UPDATE remediation_executions
        SET recovery_lease_until = clock_timestamp() + INTERVAL '10 minutes',
            updated_at = clock_timestamp()
      WHERE id = ${lease.executionId}::uuid AND tenant_id = ${lease.tenantId}
        AND organization_id = ${lease.organizationId}::uuid AND project_id = ${lease.projectId}
        AND recovery_lease_hash = ${tokenHash} AND recovery_lease_until > clock_timestamp()
    `;
    return updated === 1;
  }

  /**
   * Releases the system recovery lease (best-effort; called after recovery
   * succeeds, fails, or escalates to manual review).
   */
  async releaseSystemRecoveryLease(lease: SystemRecoveryLease): Promise<void> {
    const tokenHash = hash(lease.leaseToken);
    await this.prisma.$executeRaw`
      UPDATE remediation_executions
        SET recovery_lease_hash  = NULL,
            recovery_lease_until = NULL,
            recovery_lease_owner = NULL,
            version = version + 1, updated_at = clock_timestamp()
      WHERE id = ${lease.executionId}::uuid AND tenant_id = ${lease.tenantId}
        AND organization_id = ${lease.organizationId}::uuid AND project_id = ${lease.projectId}
        AND recovery_lease_hash = ${tokenHash}
    `;
  }

  /**
   * Fencing-token check: confirms the system recovery lease is still valid
   * before persisting a recovery outcome. Throws lease_guard_unavailable if expired.
   */
  async assertSystemRecoveryLeaseOwned(lease: SystemRecoveryLease): Promise<void> {
    const tokenHash = hash(lease.leaseToken);
    const rows = await this.prisma.$queryRaw<Array<{ valid: boolean }>>`
      SELECT recovery_lease_until > clock_timestamp() AS valid
      FROM remediation_executions
      WHERE id = ${lease.executionId}::uuid AND recovery_lease_hash = ${tokenHash}
    `;
    if (!rows[0]?.valid) throw new RemediationExecutionPersistenceError("lease_guard_unavailable");
  }

  private makeSession(lease: RemediationLease, initial: ExecutionRow): RemediationExecutionSession {
    const service = this;
    const session: RemediationExecutionSession = Object.freeze({
      executionId: initial.id,
      attemptNumber: initial.attemptNumber,
      recordIntent(input: ExecutionMutationIdentity) { return service.recordIntent(lease, initial.id, input); },
      recordVerified(input: VerifiedExecutionRemoteResult) {
        return service.recordVerified(lease, initial.id, initial.attemptNumber, input);
      },
      recordMutationVerified(input: Parameters<RemediationExecutionSession["recordMutationVerified"]>[0]) {
        return service.recordMutationVerified(lease, initial.id, initial.attemptNumber, input);
      },
      scheduleRateLimitRetry(evidence: GitHubMutationRejectionEvidence) {
        return service.scheduleRateLimitRetry(lease, initial.id, initial.attemptNumber, evidence);
      },
      recordFailure(stage: ExecutionStage, code: string) { return service.recordFailure(lease, initial.id, stage, code); },
      requireManualReview(stage: ExecutionStage, code: string, details?: Parameters<RemediationExecutionSession["requireManualReview"]>[2]) {
        return service.requireManualReview(lease, initial.id, stage, code, details);
      },
      complete() { return service.complete(lease, initial.id); }
    });
    sessions.add(session);
    return session;
  }

  private async recordIntent(lease: RemediationLease, executionId: string, input: ExecutionMutationIdentity): Promise<void> {
    validateMutationIdentity(input);
    await this.prisma.$transaction(async (tx) => {
      const row = await lockExecution(tx, lease, executionId);
      assertCanPerformStage(row, input.stage);
      if (input.operation !== undefined || input.expected !== undefined) {
        if (!input.operation || !input.expected ||
            input.operationKey !== `${input.stage}:${mutationRequestHash(input.stage, mutationScopeForRow(row), input.operation, input.expected)}` ||
            input.requestHash !== mutationRequestHash(input.stage, mutationScopeForRow(row), input.operation, input.expected)) {
          throw new RemediationExecutionPersistenceError("invalid_input");
        }
      }
      const prior = await tx.$queryRaw<Array<{ requestHash: string; stage: string }>>`
        SELECT request_hash AS "requestHash", stage FROM remediation_execution_events
        WHERE execution_id = ${executionId}::uuid AND attempt_number = ${row.attemptNumber}
          AND operation_key = ${input.operationKey} AND event_type = 'request_intent'
      `;
      if (prior.length) {
        if (prior[0]?.stage !== input.stage || prior[0]?.requestHash !== input.requestHash) {
          throw new RemediationExecutionPersistenceError("intent_conflict");
        }
        // A void result cannot distinguish a completed retry from permission to repeat a remote write.
        throw new RemediationExecutionPersistenceError("invalid_transition");
      }
      const updated = await tx.$executeRaw`
        UPDATE remediation_executions SET stage = ${input.stage}, version = version + 1, updated_at = clock_timestamp()
        WHERE id = ${executionId}::uuid AND version = ${row.version} AND lease_token_hash = ${hash(lease.leaseToken)}
          AND lease_expires_at > clock_timestamp()
      `;
      if (updated !== 1) throw new RemediationExecutionPersistenceError("execution_conflict");
      await appendEvent(tx, row, "request_intent", input.stage, input.operationKey, input.requestHash,
        null, null, null, null, null, undefined, null, null, intentDescriptorMetadata(input));
      await this.auditWriter(tx, auditFor(row, "REMEDIATION_EXECUTION_REQUEST_INTENT", {
        stage: input.stage, operationKey: input.operationKey, requestHash: input.requestHash
      }));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async recordMutationVerified(lease: RemediationLease, executionId: string, attempt: number,
    input: Parameters<RemediationExecutionSession["recordMutationVerified"]>[0]): Promise<void> {
    validateMutationIdentity(input.identity);
    if (!isAuthorizedArtifactGitHubCapability(input.capability) ||
        !/^[a-z_]{1,32}$/.test(input.resourceType) || !/^[A-Za-z0-9._:/-]{1,128}$/.test(input.resourceId)) {
      throw new RemediationExecutionPersistenceError("invalid_input");
    }
    const stage = input.identity.stage;
    const expectedReceipt = { resourceType: input.resourceType, resourceId: input.resourceId,
      commitSha: input.commitSha, branchName: input.branchName,
      pullRequestNumber: input.pullRequestNumber, pullRequestUrl: input.pullRequestUrl };
    if (!isVerifiedArtifactWriterMutationReceipt(input.verificationReceipt, input.capability, stage,
          input.identity.operationKey, input.identity.requestHash, expectedReceipt) &&
        !isVerifiedArtifactPublisherMutationReceipt(input.verificationReceipt, input.capability, stage,
          input.identity.operationKey, input.identity.requestHash, expectedReceipt)) {
      throw new RemediationExecutionPersistenceError("invalid_input");
    }
    if ((stage === "commit" && (!input.commitSha || !SHA1.test(input.commitSha))) ||
        (stage === "branch" && !input.branchName) ||
        (stage === "pull_request" && (!input.pullRequestNumber || !input.pullRequestUrl)) ||
        (stage === "pull_request_close" && (!input.pullRequestNumber || !input.pullRequestUrl))) {
      throw new RemediationExecutionPersistenceError("invalid_input");
    }
    await this.prisma.$transaction(async (tx) => {
      const row = await lockExecution(tx, lease, executionId);
      if (row.attemptNumber !== attempt || !capabilityMatchesExecution(input.capability, row)) {
        throw new RemediationExecutionPersistenceError("claim_not_authorized");
      }
      const intents = await tx.$queryRaw<Array<{ requestHash: string; stage: string }>>`
        SELECT request_hash AS "requestHash", stage FROM remediation_execution_events
        WHERE execution_id = ${executionId}::uuid AND attempt_number = ${attempt}
          AND operation_key = ${input.identity.operationKey} AND event_type = 'request_intent'
      `;
      if (intents.length !== 1 || intents[0]?.stage !== stage || intents[0]?.requestHash !== input.identity.requestHash) {
        throw new RemediationExecutionPersistenceError("intent_conflict");
      }
      const prior = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM remediation_execution_events WHERE execution_id = ${executionId}::uuid
          AND attempt_number = ${attempt} AND operation_key = ${input.identity.operationKey}
          AND event_type IN ('remote_result_verified', 'remote_mutation_rejected')
      `;
      if (prior.length) throw new RemediationExecutionPersistenceError("invalid_transition");
      let nextStatus: ExecutionStatus = row.status;
      if (stage === "commit") nextStatus = "commit_verified";
      else if (stage === "branch") nextStatus = "branch_verified";
      else if (stage === "pull_request") nextStatus = "draft_pr_verified";
      else if (stage === "pull_request_close") nextStatus = "manual_review_required";
      const changed = await tx.$executeRaw`
        UPDATE remediation_executions SET status = ${nextStatus}, stage = ${stage},
          commit_sha = COALESCE(${input.commitSha ?? null}, commit_sha),
          commit_verified_at = CASE WHEN ${stage} = 'commit' THEN clock_timestamp() ELSE commit_verified_at END,
          branch_name = COALESCE(${input.branchName ?? null}, branch_name),
          branch_verified_at = CASE WHEN ${stage} = 'branch' OR ${stage} = 'pull_request' THEN clock_timestamp() ELSE branch_verified_at END,
          pull_request_number = COALESCE(${input.pullRequestNumber ?? null}, pull_request_number),
          pull_request_url = COALESCE(${input.pullRequestUrl ?? null}, pull_request_url),
          pull_request_verified_at = CASE WHEN ${stage} = 'pull_request' THEN clock_timestamp() ELSE pull_request_verified_at END,
          reconciliation_status = CASE WHEN ${stage} = 'pull_request_close' THEN 'required' ELSE reconciliation_status END,
          lease_owner = CASE WHEN ${stage} = 'pull_request_close' THEN NULL ELSE lease_owner END,
          lease_token_hash = CASE WHEN ${stage} = 'pull_request_close' THEN NULL ELSE lease_token_hash END,
          lease_expires_at = CASE WHEN ${stage} = 'pull_request_close' THEN NULL ELSE lease_expires_at END,
          failure_stage = CASE WHEN ${stage} = 'pull_request_close' THEN ${stage} ELSE failure_stage END,
          failure_code = CASE WHEN ${stage} = 'pull_request_close' THEN 'base_moved_draft_closed' ELSE failure_code END,
          manual_review_at = CASE WHEN ${stage} = 'pull_request_close' THEN clock_timestamp() ELSE manual_review_at END,
          version = version + 1, updated_at = clock_timestamp()
        WHERE id = ${executionId}::uuid AND version = ${row.version}
          AND lease_token_hash = ${hash(lease.leaseToken)} AND lease_expires_at > clock_timestamp()
      `;
      if (changed !== 1) throw new RemediationExecutionPersistenceError("execution_conflict");
      const details = { branchName: input.branchName ?? row.branchName, commitSha: input.commitSha ?? row.commitSha,
        pullRequestNumber: input.pullRequestNumber ?? row.pullRequestNumber,
        pullRequestUrl: input.pullRequestUrl ?? row.pullRequestUrl };
      const next = { ...row, status: nextStatus, stage, ...details };
      await appendEvent(tx, next, "remote_result_verified", stage, input.identity.operationKey,
        input.identity.requestHash, input.resourceType, input.resourceId, details.branchName, details.commitSha,
        details.pullRequestNumber, undefined, details.pullRequestUrl);
      await this.auditWriter(tx, auditFor(next, "REMEDIATION_EXECUTION_REMOTE_RESULT_VERIFIED", {
        stage, resourceType: input.resourceType, resourceId: input.resourceId, artifactHash: row.artifactHash
      }));
      if (stage === "pull_request_close") await this.auditWriter(tx, auditFor(next,
        "REMEDIATION_EXECUTION_MANUAL_REVIEW_REQUIRED", { stage, code: "base_moved_draft_closed" }));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async recordVerified(lease: RemediationLease, executionId: string, attempt: number,
    input: VerifiedExecutionRemoteResult): Promise<void> {
    if (!input || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.operationKey) ||
        !isAuthorizedArtifactGitHubCapability(input.capability)) {
      throw new RemediationExecutionPersistenceError("invalid_input");
    }
    const fromWriter = isVerifiedArtifactOnlyGitHubWriteResult(input.result, input.capability);
    const fromPublisher = isVerifiedArtifactOnlyDraftPullRequestResult(input.result, input.capability);
    if (!fromWriter && !fromPublisher) throw new RemediationExecutionPersistenceError("invalid_input");
    const stage = fromWriter ? "commit" : "pull_request";
    const commitSha = input.result.commitSha;
    const branch = fromPublisher ? input.result.branchName : null;
    const prNumber = fromPublisher ? input.result.pullRequestNumber : null;
    const prUrl = fromPublisher ? input.result.pullRequestUrl : null;
    await this.prisma.$transaction(async (tx) => {
      const row = await lockExecution(tx, lease, executionId);
      if (row.attemptNumber !== attempt) throw new RemediationExecutionPersistenceError("execution_conflict");
      if (!capabilityMatchesExecution(input.capability, row)) throw new RemediationExecutionPersistenceError("invalid_input");
      assertCanPerformStage(row, stage);
      const intent = await tx.$queryRaw<Array<{ requestHash: string }>>`
        SELECT request_hash AS "requestHash" FROM remediation_execution_events
        WHERE execution_id = ${executionId}::uuid AND attempt_number = ${attempt}
          AND operation_key = ${input.operationKey} AND event_type = 'request_intent' AND stage = ${stage}
      `;
      if (intent.length !== 1) throw new RemediationExecutionPersistenceError("invalid_transition");
      const priorTerminal = await tx.$queryRaw<Array<{ eventType: string }>>`
        SELECT event_type AS "eventType" FROM remediation_execution_events
        WHERE execution_id = ${executionId}::uuid AND attempt_number = ${attempt}
          AND operation_key = ${input.operationKey}
          AND event_type IN ('remote_result_verified', 'remote_mutation_rejected')
      `;
      if (priorTerminal.length !== 0) throw new RemediationExecutionPersistenceError("invalid_transition");
      const nextStatus = stage === "commit" ? "commit_verified" : "draft_pr_verified";
      const updated = await tx.$executeRaw`
        UPDATE remediation_executions SET status = ${nextStatus},
          stage = ${stage},
          commit_sha = COALESCE(${commitSha}, commit_sha),
          commit_verified_at = COALESCE(commit_verified_at, clock_timestamp()),
          branch_name = COALESCE(${branch}, branch_name),
          branch_verified_at = CASE WHEN ${stage} = 'pull_request' THEN COALESCE(branch_verified_at, clock_timestamp()) ELSE branch_verified_at END,
          pull_request_number = COALESCE(${prNumber}, pull_request_number), pull_request_url = COALESCE(${prUrl}, pull_request_url),
          pull_request_verified_at = CASE WHEN ${stage} = 'pull_request' THEN clock_timestamp() ELSE pull_request_verified_at END,
          version = version + 1, updated_at = clock_timestamp()
        WHERE id = ${executionId}::uuid AND version = ${row.version} AND lease_token_hash = ${hash(lease.leaseToken)}
          AND lease_expires_at > clock_timestamp()
      `;
      if (updated !== 1) throw new RemediationExecutionPersistenceError("execution_conflict");
      const resourceType = stage;
      const resourceId = stage === "pull_request" ? String(prNumber) : commitSha;
      const updatedRow = { ...row, status: nextStatus as ExecutionStatus, stage,
        commitSha: commitSha ?? row.commitSha, branchName: branch ?? row.branchName,
        pullRequestNumber: prNumber ?? row.pullRequestNumber, pullRequestUrl: prUrl ?? row.pullRequestUrl };
      await appendEvent(tx, updatedRow, "remote_result_verified", stage, input.operationKey,
        intent[0]?.requestHash ?? null, resourceType, resourceId, branch, commitSha, prNumber, undefined, prUrl);
      await this.auditWriter(tx, auditFor(updatedRow, "REMEDIATION_EXECUTION_REMOTE_RESULT_VERIFIED", {
        stage, resourceType, resourceId, artifactHash: row.artifactHash
      }));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async scheduleRateLimitRetry(lease: RemediationLease, executionId: string, attempt: number,
    evidence: GitHubMutationRejectionEvidence): Promise<"scheduled" | "failed" | "manual_review"> {
    if (!isTrustedGitHubMutationRejectionEvidence(evidence, evidence)) {
      throw new RemediationExecutionPersistenceError("invalid_input");
    }
    return this.prisma.$transaction(async (tx) => {
      const row = await lockExecution(tx, lease, executionId);
      if (row.attemptNumber !== attempt || evidence.executionId !== executionId ||
          evidence.attempt !== attempt || !isMutationStage(evidence.stage)) {
        throw new RemediationExecutionPersistenceError("invalid_input");
      }
      assertCanPerformStage(row, evidence.stage);
      const intent = await tx.$queryRaw<Array<{ requestHash: string; stage: string; fingerprint: string | null }>>`
        SELECT request_hash AS "requestHash", stage, metadata #>> '{expected,requestFingerprint}' AS fingerprint
        FROM remediation_execution_events
        WHERE execution_id = ${executionId}::uuid AND attempt_number = ${attempt}
          AND operation_key = ${evidence.operationKey} AND event_type = 'request_intent'
      `;
      if (intent.length !== 1 || intent[0]?.stage !== evidence.stage ||
          intent[0]?.requestHash !== evidence.requestHash || intent[0]?.fingerprint !== evidence.requestFingerprint) {
        throw new RemediationExecutionPersistenceError("invalid_transition");
      }
      const terminal = await tx.$queryRaw<Array<{ eventType: string }>>`
        SELECT event_type AS "eventType" FROM remediation_execution_events
        WHERE execution_id = ${executionId}::uuid AND attempt_number = ${attempt}
          AND operation_key = ${evidence.operationKey}
          AND event_type IN ('remote_result_verified', 'remote_mutation_rejected')
      `;
      if (terminal.length !== 0) throw new RemediationExecutionPersistenceError("invalid_transition");
      const pendingCount = await pendingIntentCount(tx, row);
      const successfulMutations = await tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM remediation_execution_events
        WHERE execution_id = ${executionId}::uuid AND event_type = 'remote_result_verified'
      `;
      const scheduledRetries = await tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM remediation_execution_events
        WHERE execution_id = ${executionId}::uuid AND event_type = 'execution_retry_scheduled'
      `;
      const queueRows = await tx.$queryRaw<Array<{ retriesLeft: number }>>`
        SELECT retries_left AS "retriesLeft" FROM remediations
        WHERE id = ${lease.id} AND tenant_id = ${lease.tenantId} AND project_id = ${lease.projectId}
          AND status = 'running' AND worker_id = ${lease.workerId} AND lease_token = ${lease.leaseToken}::uuid
          AND lease_expires_at > clock_timestamp() FOR UPDATE
      `;
      const successfulCount = Number(successfulMutations[0]?.count ?? 0n);
      const retryCount = Number(scheduledRetries[0]?.count ?? 0n);
      const retriesLeft = queueRows[0]?.retriesLeft ?? 0;
      const retryIsSafe = pendingCount === 1 && successfulCount === 0 && retryCount < MAX_RATE_LIMIT_RETRIES &&
        attempt < MAX_EXECUTION_ATTEMPTS && retriesLeft > 0;
      const rejectionMetadata = {
        rejection: evidence.rejection,
        ...(evidence.retryAfterMs !== undefined ? { retryAfterMs: Math.min(evidence.retryAfterMs, 60_000) } : {}),
        requestFingerprint: evidence.requestFingerprint
      };
      await appendEvent(tx, row, "remote_mutation_rejected", evidence.stage, evidence.operationKey,
        evidence.requestHash, "github_mutation", null, null, null, null, undefined, null, "rate_limited", rejectionMetadata);
      await this.auditWriter(tx, auditFor(row, "REMEDIATION_EXECUTION_REMOTE_MUTATION_REJECTED", {
        stage: evidence.stage, operationKey: evidence.operationKey, requestHash: evidence.requestHash,
        rejection: evidence.rejection,
        ...(evidence.retryAfterMs !== undefined ? { retryAfterMs: Math.min(evidence.retryAfterMs, 60_000) } : {})
      }));

      if (pendingCount > 1 || successfulCount > 0) {
        await transitionToManualReview(tx, row, evidence.stage, "ambiguous_remote_operation", this.auditWriter);
        await settleRunningRemediation(tx, lease, "failed", "Execution requires review after an earlier remote mutation.");
        return "manual_review" as const;
      }

      if (!retryIsSafe) {
        const changed = await tx.$executeRaw`
          UPDATE remediation_executions SET status = 'failed', stage = ${evidence.stage},
            failure_stage = ${evidence.stage}, failure_code = 'rate_limited', retry_eligible_at = NULL,
            lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
            version = version + 1, updated_at = clock_timestamp()
          WHERE id = ${executionId}::uuid AND version = ${row.version}
            AND lease_token_hash = ${hash(lease.leaseToken)} AND lease_expires_at > clock_timestamp()
        `;
        if (changed !== 1) throw new RemediationExecutionPersistenceError("execution_conflict");
        const projected = await tx.$executeRaw`
          UPDATE remediations SET status = 'failed', retries_left = 0, next_attempt_at = NULL,
            error_message = 'rate_limited', worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL,
            lease_expires_at = NULL, lease_token = NULL, updated_at = clock_timestamp()
          WHERE id = ${lease.id} AND tenant_id = ${lease.tenantId} AND project_id = ${lease.projectId}
            AND status = 'running' AND worker_id = ${lease.workerId} AND lease_token = ${lease.leaseToken}::uuid
            AND lease_expires_at > clock_timestamp()
        `;
        if (projected !== 1) throw new RemediationExecutionPersistenceError("execution_conflict");
        await appendEvent(tx, row, "execution_failed", evidence.stage, null, null, null, null, null, null, null,
          undefined, undefined, "rate_limited");
        await this.auditWriter(tx, auditFor(row, "REMEDIATION_EXECUTION_FAILED", {
          stage: evidence.stage, code: "rate_limited", retryExhausted: "true"
        }));
        return "failed" as const;
      }

      const retryOrdinal = retryCount + 1;
      const delayMs = boundedRateLimitDelay(evidence.retryAfterMs, retryOrdinal);
      const scheduleRows = await tx.$queryRaw<Array<{ retryAt: Date }>>`
        SELECT clock_timestamp() + (${delayMs} * INTERVAL '1 millisecond') AS "retryAt"
      `;
      const retryAt = scheduleRows[0]?.retryAt;
      if (!(retryAt instanceof Date) || !Number.isFinite(retryAt.getTime())) {
        throw new RemediationExecutionPersistenceError("invalid_transition");
      }
      const changed = await tx.$executeRaw`
        UPDATE remediation_executions SET status = 'failed', stage = ${evidence.stage},
          failure_stage = ${evidence.stage}, failure_code = 'rate_limited', retry_eligible_at = ${retryAt},
          lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
          version = version + 1, updated_at = clock_timestamp()
        WHERE id = ${executionId}::uuid AND version = ${row.version}
          AND lease_token_hash = ${hash(lease.leaseToken)} AND lease_expires_at > clock_timestamp()
      `;
      if (changed !== 1) throw new RemediationExecutionPersistenceError("execution_conflict");
      const projected = await tx.$executeRaw`
        UPDATE remediations SET status = 'pending', retries_left = retries_left - 1,
          next_attempt_at = ${retryAt}, error_message = 'rate_limited', worker_id = NULL,
          claimed_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL, lease_token = NULL,
          updated_at = clock_timestamp()
        WHERE id = ${lease.id} AND tenant_id = ${lease.tenantId} AND project_id = ${lease.projectId}
          AND status = 'running' AND worker_id = ${lease.workerId} AND lease_token = ${lease.leaseToken}::uuid
          AND lease_expires_at > clock_timestamp() AND retries_left > 0
      `;
      if (projected !== 1) throw new RemediationExecutionPersistenceError("execution_conflict");
      await appendEvent(tx, row, "execution_retry_scheduled", evidence.stage, evidence.operationKey,
        evidence.requestHash, null, null, null, null, null, undefined, null, "rate_limited", {
          retryOrdinal, retryAfterMs: delayMs, retryAt: retryAt.toISOString()
        });
      await this.auditWriter(tx, auditFor(row, "REMEDIATION_EXECUTION_RETRY_SCHEDULED", {
        attemptNumber: attempt, retryOrdinal, retryAfterMs: delayMs, retryAt: retryAt.toISOString(),
        operationKey: evidence.operationKey, requestHash: evidence.requestHash
      }));
      return "scheduled" as const;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async recordFailure(lease: RemediationLease, executionId: string, stage: ExecutionStage,
    code: string): Promise<"failed" | "manual_review"> {
    validateCode(code);
    return this.prisma.$transaction(async (tx) => {
      const row = await lockExecution(tx, lease, executionId);
      const pending = await pendingIntentCount(tx, row);
      if (pending > 0) {
        await transitionToManualReview(tx, row, stage, "ambiguous_remote_operation", this.auditWriter);
        await settleRunningRemediation(tx, lease, "failed", "Execution requires manual review after an unresolved remote operation.");
        return "manual_review" as const;
      }
      const changed = await tx.$executeRaw`UPDATE remediation_executions SET status = 'failed', stage = ${stage},
        failure_stage = ${stage}, failure_code = ${code}, lease_owner = NULL, lease_token_hash = NULL,
        lease_expires_at = NULL, version = version + 1, updated_at = clock_timestamp()
        WHERE id = ${executionId}::uuid AND version = ${row.version} AND lease_token_hash = ${hash(lease.leaseToken)}
          AND lease_expires_at > clock_timestamp()`;
      if (changed !== 1) throw new RemediationExecutionPersistenceError("execution_conflict");
      await appendEvent(tx, row, "execution_failed", stage, null, null, null, null, null, null, null, undefined, undefined, code);
      await this.auditWriter(tx, auditFor(row, "REMEDIATION_EXECUTION_FAILED", { stage, code }));
      await settleRunningRemediation(tx, lease, "failed", code);
      return "failed" as const;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async requireManualReview(lease: RemediationLease, executionId: string, stage: ExecutionStage, code: string,
    details?: { readonly commitSha?: string; readonly branchName?: string;
      readonly pullRequestNumber?: number; readonly pullRequestUrl?: string }): Promise<void> {
    validateCode(code);
    validateOptionalDetails(details);
    await this.prisma.$transaction(async (tx) => {
      const row = await lockExecution(tx, lease, executionId);
      await transitionToManualReview(tx, row, stage, code, this.auditWriter, details);
      await settleRunningRemediation(tx, lease, "failed", code, details);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async complete(lease: RemediationLease, executionId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await lockExecution(tx, lease, executionId);
      if (row.status !== "draft_pr_verified" || !row.commitSha || !row.branchName ||
          !row.pullRequestNumber || !row.pullRequestUrl || row.reconciliationStatus !== "not_required") {
        throw new RemediationExecutionPersistenceError("invalid_transition");
      }
      const changed = await tx.$executeRaw`UPDATE remediation_executions SET status = 'completed', completed_at = clock_timestamp(),
        lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
        version = version + 1, updated_at = clock_timestamp()
        WHERE id = ${executionId}::uuid AND version = ${row.version} AND lease_token_hash = ${hash(lease.leaseToken)}
          AND lease_expires_at > clock_timestamp()`;
      if (changed !== 1) throw new RemediationExecutionPersistenceError("execution_conflict");
      await appendEvent(tx, row, "execution_completed", "pull_request", null, null,
        "pull_request", String(row.pullRequestNumber), row.branchName, row.commitSha, row.pullRequestNumber,
        undefined, row.pullRequestUrl);
      await this.auditWriter(tx, auditFor(row, "REMEDIATION_EXECUTION_COMPLETED", {
        artifactHash: row.artifactHash, commitSha: row.commitSha, branchName: row.branchName,
        pullRequestNumber: row.pullRequestNumber, pullRequestUrl: row.pullRequestUrl
      }));
      const projected = await tx.$executeRaw`
        UPDATE remediations SET status = 'open', branch_name = ${row.branchName}, pr_number = ${row.pullRequestNumber},
          pr_url = ${row.pullRequestUrl}, error_message = NULL, worker_id = NULL, claimed_at = NULL,
          heartbeat_at = NULL, lease_expires_at = NULL, lease_token = NULL, next_attempt_at = NULL,
          updated_at = clock_timestamp()
        WHERE id = ${lease.id} AND tenant_id = ${lease.tenantId} AND project_id = ${lease.projectId}
          AND status = 'running' AND worker_id = ${lease.workerId} AND lease_token = ${lease.leaseToken}::uuid
          AND lease_expires_at > clock_timestamp()
      `;
      if (projected !== 1) throw new RemediationExecutionPersistenceError("execution_conflict");
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}

async function lockAuthorizedRemediation(tx: Tx, lease: RemediationLease, context: TrustedClaimExecutionContext): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string; tenantId: string; organizationId: string; projectId: string;
    requestedByIdentityUserId: string; approvedByIdentityUserId: string; repositoryBindingId: string;
    installationRecordId: string; githubRepositoryId: bigint; artifactHash: string; baseRef: string; baseCommitSha: string }>>`
    SELECT r.id, r.tenant_id AS "tenantId", r.organization_id AS "organizationId", r.project_id AS "projectId",
      r.requested_by_identity_user_id AS "requestedByIdentityUserId",
      r.approved_by_identity_user_id AS "approvedByIdentityUserId",
      r.repository_binding_id AS "repositoryBindingId", r.github_repository_id AS "githubRepositoryId",
      (SELECT b.installation_record_id FROM project_github_repositories b
        WHERE b.id = r.repository_binding_id AND b.tenant_id = r.tenant_id
          AND b.organization_id = r.organization_id AND b.project_id = r.project_id) AS "installationRecordId",
      r.execution_artifact_hash AS "artifactHash", a.base_ref AS "baseRef", a.base_commit_sha AS "baseCommitSha"
    FROM remediations r
    JOIN LATERAL (SELECT r.execution_artifact->>'baseRef' AS base_ref, r.execution_artifact->>'baseCommitSha' AS base_commit_sha) a ON true
    WHERE r.id = ${lease.id} AND r.tenant_id = ${lease.tenantId} AND r.project_id = ${lease.projectId}
      AND r.organization_id = ${context.organizationId}::uuid AND r.status = 'running'
      AND r.worker_id = ${lease.workerId} AND r.lease_token = ${lease.leaseToken}::uuid
      AND r.lease_expires_at > clock_timestamp() AND r.approval_state = 'approved'
      AND r.execution_artifact_hash = r.approved_artifact_hash AND r.execution_artifact_hash = ${context.artifactHash}
      AND r.repository_binding_id = ${context.repositoryBindingId}::uuid
      AND r.github_repository_id = ${context.githubRepositoryId}::bigint
      AND a.base_ref = ${context.baseRef} AND a.base_commit_sha = ${context.baseCommitSha}
      AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = r.organization_id AND o.status = 'active')
      AND EXISTS (SELECT 1 FROM project_organization_adoptions a WHERE a.tenant_id = r.tenant_id
        AND a.organization_id = r.organization_id AND a.project_id = r.project_id AND a.status = 'approved')
      AND EXISTS (SELECT 1 FROM project_github_repositories b JOIN organization_github_installations i
        ON i.id = b.installation_record_id AND i.organization_id = b.organization_id AND i.status = 'active'
        WHERE b.id = r.repository_binding_id AND b.tenant_id = r.tenant_id AND b.organization_id = r.organization_id
          AND b.project_id = r.project_id AND b.github_repository_id = r.github_repository_id AND b.status = 'active')
    FOR UPDATE OF r
  `;
  const row = rows[0];
  if (!row || row.id !== context.remediationId || row.tenantId !== context.tenantId ||
      row.organizationId !== context.organizationId || row.projectId !== context.projectId ||
      row.repositoryBindingId !== context.repositoryBindingId || row.installationRecordId !== context.installationRecordId ||
      row.githubRepositoryId.toString() !== context.githubRepositoryId || row.artifactHash !== context.artifactHash ||
      row.baseRef !== context.baseRef || row.baseCommitSha !== context.baseCommitSha) return false;

  const authorizationLocks = await Promise.all([
    lockActiveOrganization(tx, context.organizationId),
    tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM projects WHERE id = ${context.projectId} AND tenant_id = ${context.tenantId} AND organization_id = ${context.organizationId}::uuid FOR SHARE`,
    tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM project_organization_adoptions WHERE tenant_id = ${context.tenantId}
      AND organization_id = ${context.organizationId}::uuid AND project_id = ${context.projectId} AND status = 'approved' FOR SHARE`,
    lockActiveBindingInstallation(tx, { tenantId: context.tenantId, organizationId: context.organizationId,
      projectId: context.projectId, bindingId: context.repositoryBindingId,
      installationId: context.installationRecordId, githubRepositoryId: context.githubRepositoryId }),
    tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM identity_users WHERE id = ${row.requestedByIdentityUserId}::uuid AND status = 'active' FOR SHARE`,
    lockActiveMember(tx, context.organizationId, row.approvedByIdentityUserId)
  ]);
  const approverRole = authorizationLocks[5];
  return authorizationLocks.slice(0, 5).every((result) => Array.isArray(result) ? result.length === 1 : result === true) &&
    (approverRole === "owner" || approverRole === "admin");
}

async function lockExecution(tx: Tx, lease: RemediationLease, executionId: string): Promise<ExecutionRow> {
  const rows = await tx.$queryRaw<ExecutionRow[]>`
    WITH locked_remediation AS MATERIALIZED (
      SELECT id FROM remediations
      WHERE id = ${lease.id} AND tenant_id = ${lease.tenantId} AND project_id = ${lease.projectId}
        AND status = 'running' AND worker_id = ${lease.workerId} AND lease_token = ${lease.leaseToken}::uuid
        AND lease_expires_at > clock_timestamp() AND approval_state = 'approved'
      FOR UPDATE
    )
    SELECT e.id, e.tenant_id AS "tenantId", e.organization_id AS "organizationId", e.project_id AS "projectId",
      e.remediation_id AS "remediationId", e.repository_binding_id AS "repositoryBindingId",
      e.installation_record_id AS "installationRecordId", e.github_repository_id AS "githubRepositoryId",
      e.artifact_hash AS "artifactHash", e.base_ref AS "baseRef", e.base_commit_sha AS "baseCommitSha",
      e.status, e.stage, e.attempt_number AS "attemptNumber", e.version, e.lease_token_hash AS "leaseTokenHash",
      e.lease_expires_at AS "leaseExpiresAt", e.commit_sha AS "commitSha", e.branch_name AS "branchName",
      e.pull_request_number AS "pullRequestNumber", e.pull_request_url AS "pullRequestUrl",
      e.reconciliation_status AS "reconciliationStatus"
    FROM remediation_executions e JOIN remediations r
      ON r.id = e.remediation_id AND r.tenant_id = e.tenant_id AND r.organization_id = e.organization_id
        AND r.project_id = e.project_id
    JOIN locked_remediation locked ON locked.id = r.id
    WHERE e.id = ${executionId}::uuid AND e.remediation_id = ${lease.id} AND e.tenant_id = ${lease.tenantId}
      AND e.project_id = ${lease.projectId} AND e.lease_token_hash = ${hash(lease.leaseToken)}
      AND e.lease_expires_at > clock_timestamp() AND r.status = 'running' AND r.worker_id = ${lease.workerId}
      AND r.lease_token = ${lease.leaseToken}::uuid AND r.lease_expires_at > clock_timestamp()
      AND r.approval_state = 'approved' AND r.repository_binding_id = e.repository_binding_id
      AND r.github_repository_id = e.github_repository_id AND r.execution_artifact_hash = e.artifact_hash
      AND r.approved_artifact_hash = e.artifact_hash
    FOR UPDATE OF e, r
  `;
  if (rows.length !== 1) throw new RemediationExecutionPersistenceError("claim_not_authorized");
  return rows[0]!;
}

async function lockReconciliationExecution(tx: Tx, lease: ReconciliationLease): Promise<ExecutionRow> {
  const actorRole = await lockActiveActorForUpdate(tx, lease.organizationId, lease.actorIdentityUserId);
  if (actorRole !== "owner" && actorRole !== "admin") {
    throw new RemediationExecutionPersistenceError("reconciliation_not_authorized");
  }
  const rows = await tx.$queryRaw<ExecutionRow[]>`
    SELECT e.id, e.tenant_id AS "tenantId", e.organization_id AS "organizationId", e.project_id AS "projectId",
      e.remediation_id AS "remediationId", e.repository_binding_id AS "repositoryBindingId",
      e.installation_record_id AS "installationRecordId", e.github_repository_id AS "githubRepositoryId",
      e.artifact_hash AS "artifactHash", e.base_ref AS "baseRef", e.base_commit_sha AS "baseCommitSha",
      e.status, e.stage, e.attempt_number AS "attemptNumber", e.version, e.lease_token_hash AS "leaseTokenHash",
      e.lease_expires_at AS "leaseExpiresAt", e.commit_sha AS "commitSha", e.branch_name AS "branchName",
      e.pull_request_number AS "pullRequestNumber", e.pull_request_url AS "pullRequestUrl",
      e.reconciliation_status AS "reconciliationStatus"
    FROM remediation_executions e
    WHERE e.id = ${lease.executionId}::uuid AND e.organization_id = ${lease.organizationId}::uuid
      AND e.status = 'reconciliation_in_progress' AND e.reconciliation_status = 'in_progress'
      AND e.reconciliation_actor_id = ${lease.actorIdentityUserId}::uuid
      AND e.reconciliation_lease_hash = ${hash(lease.leaseToken)}
      AND e.reconciliation_lease_until > clock_timestamp()
    FOR UPDATE OF e
  `;
  if (rows.length !== 1) throw new RemediationExecutionPersistenceError("reconciliation_not_authorized");
  return rows[0]!;
}

function capabilityMatchesExecution(capability: AuthorizedArtifactGitHubCapability, row: ExecutionRow): boolean {
  return isAuthorizedArtifactGitHubCapability(capability) && capability.proposalId === row.remediationId &&
    capability.tenantId === row.tenantId && capability.organizationId === row.organizationId &&
    capability.projectId === row.projectId &&
    capability.repositoryBindingId === row.repositoryBindingId && capability.installationRecordId === row.installationRecordId &&
    capability.repositoryId === row.githubRepositoryId.toString() && capability.artifactHash === row.artifactHash &&
    capability.baseRef === row.baseRef && capability.baseCommitSha === row.baseCommitSha &&
    capability.lease.remediationId === row.remediationId;
}

async function pendingIntentCount(tx: Tx, row: ExecutionRow): Promise<number> {
  const count = await tx.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) AS count FROM remediation_execution_events intent
    WHERE intent.execution_id = ${row.id}::uuid
      AND intent.event_type = 'request_intent'
      AND (
        (SELECT count(*) FROM remediation_execution_events terminal
          WHERE terminal.execution_id = intent.execution_id AND terminal.attempt_number = intent.attempt_number
            AND terminal.operation_key = intent.operation_key
            AND terminal.stage = intent.stage AND terminal.request_hash = intent.request_hash
            AND terminal.event_type IN ('remote_result_verified', 'remote_mutation_rejected')
            AND (terminal.event_type <> 'remote_mutation_rejected' OR
              terminal.metadata->>'requestFingerprint' = intent.metadata #>> '{expected,requestFingerprint}')) <> 1
        OR NOT EXISTS (SELECT 1 FROM remediation_execution_events terminal
          WHERE terminal.execution_id = intent.execution_id AND terminal.attempt_number = intent.attempt_number
            AND terminal.operation_key = intent.operation_key AND terminal.stage = intent.stage
            AND terminal.request_hash = intent.request_hash
            AND terminal.event_type IN ('remote_result_verified', 'remote_mutation_rejected')
            AND (terminal.event_type <> 'remote_mutation_rejected' OR
              terminal.metadata->>'requestFingerprint' = intent.metadata #>> '{expected,requestFingerprint}'))
      )
  `;
  return Number(count[0]?.count ?? 0n);
}

async function transitionToManualReview(tx: Tx, row: ExecutionRow, stage: ExecutionStage, code: string,
  auditWriter: ExecutionAuditWriter,
  details?: { readonly commitSha?: string; readonly branchName?: string;
    readonly pullRequestNumber?: number; readonly pullRequestUrl?: string },
  recoveryLease?: SystemRecoveryLease): Promise<boolean> {
  const tokenHash = recoveryLease ? hash(recoveryLease.leaseToken) : null;
  const changed = await tx.$executeRaw`
    UPDATE remediation_executions SET status = 'manual_review_required', stage = ${stage},
      failure_stage = ${stage}, failure_code = ${code}, manual_review_at = clock_timestamp(),
      reconciliation_status = 'required', lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
      commit_sha = COALESCE(${details?.commitSha ?? null}, commit_sha),
      branch_name = COALESCE(${details?.branchName ?? null}, branch_name),
      pull_request_number = COALESCE(${details?.pullRequestNumber ?? null}, pull_request_number),
      pull_request_url = COALESCE(${details?.pullRequestUrl ?? null}, pull_request_url),
      version = version + 1, updated_at = clock_timestamp()
    WHERE id = ${row.id}::uuid AND version = ${row.version}
      ${recoveryLease ? Prisma.sql`AND recovery_lease_hash = ${tokenHash} AND recovery_lease_until > clock_timestamp()` : Prisma.empty}
  `;
  if (changed !== 1) {
    if (recoveryLease) return false;
    throw new RemediationExecutionPersistenceError("execution_conflict");
  }
  await appendEvent(tx, row, "manual_review_required", stage, null, null, null, null,
    details?.branchName ?? row.branchName, details?.commitSha ?? row.commitSha,
    details?.pullRequestNumber ?? row.pullRequestNumber, undefined, details?.pullRequestUrl ?? row.pullRequestUrl, code);
  await auditWriter(tx, auditFor(row, "REMEDIATION_EXECUTION_MANUAL_REVIEW_REQUIRED", {
    stage, code, artifactHash: row.artifactHash,
    commitSha: details?.commitSha ?? row.commitSha,
    branchName: details?.branchName ?? row.branchName,
    pullRequestNumber: details?.pullRequestNumber ?? row.pullRequestNumber,
    pullRequestUrl: details?.pullRequestUrl ?? row.pullRequestUrl
  }));
  return true;
}

async function settleRunningRemediation(tx: Tx, lease: RemediationLease, status: "failed",
  message: string, details?: { readonly branchName?: string; readonly pullRequestNumber?: number;
    readonly pullRequestUrl?: string }): Promise<void> {
  const changed = await tx.$executeRaw`
    UPDATE remediations SET status = ${status}, error_message = ${message.slice(0, 512)},
      branch_name = COALESCE(${details?.branchName ?? null}, branch_name),
      pr_number = COALESCE(${details?.pullRequestNumber ?? null}, pr_number),
      pr_url = COALESCE(${details?.pullRequestUrl ?? null}, pr_url),
      worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL,
      lease_token = NULL, next_attempt_at = NULL, updated_at = clock_timestamp()
    WHERE id = ${lease.id} AND tenant_id = ${lease.tenantId} AND project_id = ${lease.projectId}
      AND status = 'running' AND worker_id = ${lease.workerId} AND lease_token = ${lease.leaseToken}::uuid
      AND lease_expires_at > clock_timestamp()
  `;
  if (changed !== 1) throw new RemediationExecutionPersistenceError("execution_conflict");
}

async function appendEvent(tx: Tx, row: Pick<ExecutionRow, "id" | "tenantId" | "organizationId" | "projectId" | "remediationId" | "attemptNumber">,
  eventType: string, stage: string, operationKey: string | null, requestHash: string | null,
  remoteResourceType: string | null, remoteResourceId: string | null, branchName: string | null,
  commitSha: string | null, pullRequestNumber: number | null, actorUserId?: string,
  pullRequestUrl: string | null = null, errorCode: string | null = null,
  extraMetadata: Readonly<Record<string, unknown>> = {}): Promise<void> {
  const seqRows = await tx.$queryRaw<Array<{ sequence: number }>>`
    SELECT COALESCE(MAX(sequence_number), 0) + 1 AS sequence FROM remediation_execution_events
    WHERE execution_id = ${row.id}::uuid AND attempt_number = ${row.attemptNumber}
  `;
  const metadata = { ...extraMetadata, ...Object.fromEntries(Object.entries({ branchName, commitSha, pullRequestNumber, pullRequestUrl, errorCode })
    .filter(([, value]) => value !== null && value !== undefined)) };
  await tx.$executeRaw`
    INSERT INTO remediation_execution_events (
      id, execution_id, tenant_id, organization_id, project_id, remediation_id, attempt_number, sequence_number,
      event_type, stage, operation_key, request_hash, remote_resource_type, remote_resource_id,
      commit_sha, branch_name, pull_request_number, pull_request_url, error_code, actor_type, actor_user_id,
      system_actor_id, metadata, created_at
    ) VALUES (
      ${randomUUID()}::uuid, ${row.id}::uuid, ${row.tenantId}, ${row.organizationId}::uuid, ${row.projectId},
      ${row.remediationId}, ${row.attemptNumber}, ${seqRows[0]?.sequence ?? 1}, ${eventType}, ${stage},
      ${operationKey}, ${requestHash}, ${remoteResourceType}, ${remoteResourceId}, ${commitSha}, ${branchName},
      ${pullRequestNumber}, ${pullRequestUrl}, ${errorCode}, ${actorUserId ? "user" : "system"},
      ${actorUserId ?? null}::uuid, ${actorUserId ? null : SYSTEM_ACTOR}, ${JSON.stringify(metadata)}::jsonb, clock_timestamp()
    )
  `;
}

async function writeOrganizationAudit(tx: Tx, input: AuditInput): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO organization_audit_events (
      id, organization_id, tenant_id, project_id, actor_type, actor_user_id, system_actor_id,
      action, target_type, target_id, metadata, created_at
    ) VALUES (
      ${randomUUID()}::uuid, ${input.organizationId}::uuid, ${input.tenantId}, ${input.projectId},
      ${input.actorIdentityUserId ? "user" : "system"}, ${input.actorIdentityUserId ?? null}::uuid,
      ${input.actorIdentityUserId ? null : SYSTEM_ACTOR}, ${input.action}, 'remediation_execution',
      ${input.targetId}, ${JSON.stringify(input.metadata)}::jsonb, clock_timestamp()
    )
  `;
}

function auditFor(row: Pick<ExecutionRow, "id" | "tenantId" | "organizationId" | "projectId">,
  action: string, metadata: AuditInput["metadata"], actorIdentityUserId?: string): AuditInput {
  return { organizationId: row.organizationId, tenantId: row.tenantId, projectId: row.projectId,
    action, targetId: row.id, metadata, ...(actorIdentityUserId ? { actorIdentityUserId } : {}) };
}

function assertCanPerformStage(row: ExecutionRow, stage: ExecutionMutationStage): void {
  const allowed = stage === "blob" || stage === "tree" ? row.status === "execution_started" :
    stage === "commit" ? row.status === "execution_started" : stage === "branch" ? row.status === "commit_verified" :
    stage === "pull_request" ? row.status === "commit_verified" || row.status === "branch_verified" :
    (row.status === "branch_verified" || row.status === "draft_pr_verified" ||
      row.status === "manual_review_required" || row.status === "reconciliation_in_progress");
  if (!allowed) throw new RemediationExecutionPersistenceError("invalid_transition");
}

function isMutationStage(stage: string): stage is ExecutionMutationStage {
  return ["blob", "tree", "commit", "branch", "pull_request", "pull_request_close"].includes(stage);
}

function boundedRateLimitDelay(retryAfterMs: number | undefined, retryOrdinal: number): number {
  const exponential = Math.min(60_000, DEFAULT_RATE_LIMIT_BACKOFF_MS * 2 ** Math.min(retryOrdinal - 1, 6));
  if (retryAfterMs === undefined) return exponential;
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) {
    throw new RemediationExecutionPersistenceError("invalid_input");
  }
  return Math.max(DEFAULT_RATE_LIMIT_BACKOFF_MS, Math.min(60_000, retryAfterMs));
}

function leaseMatchesContext(lease: RemediationLease, context: TrustedClaimExecutionContext): boolean {
  return !!lease && context.remediationId === lease.id && context.tenantId === lease.tenantId &&
    context.projectId === lease.projectId && context.lease.workerId === lease.workerId &&
    context.lease.leaseToken === lease.leaseToken;
}

function sameSnapshot(row: ExecutionRow, context: TrustedClaimExecutionContext): boolean {
  return row.tenantId === context.tenantId && row.organizationId === context.organizationId &&
    row.projectId === context.projectId && row.remediationId === context.remediationId &&
    row.repositoryBindingId === context.repositoryBindingId && row.installationRecordId === context.installationRecordId &&
    row.githubRepositoryId.toString() === context.githubRepositoryId && row.artifactHash === context.artifactHash &&
    row.baseRef === context.baseRef && row.baseCommitSha === context.baseCommitSha;
}

function validateMutationIdentity(input: ExecutionMutationIdentity): void {
  if (!input || !["blob", "tree", "commit", "branch", "pull_request", "pull_request_close"].includes(input.stage) ||
      typeof input.operationKey !== "string" || input.operationKey.length < 1 || input.operationKey.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(input.operationKey) || !SHA256.test(input.requestHash)) {
    throw new RemediationExecutionPersistenceError("invalid_input");
  }
  if ((input.operation !== undefined || input.expected !== undefined) &&
      (!input.operation || !input.expected || !validDescriptor(input.operation) || !validDescriptor(input.expected))) {
    throw new RemediationExecutionPersistenceError("invalid_input");
  }
}

function validDescriptor(value: Readonly<Record<string, string | number | boolean | null>>): boolean {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 32) return false;
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json, "utf8") > 4096) return false;
    return Object.entries(value).every(([key, item]) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) &&
      (item === null || typeof item === "string" && item.length <= 2048 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(item) ||
       typeof item === "number" && Number.isFinite(item) || typeof item === "boolean"));
  } catch { return false; }
}

function intentDescriptorMetadata(input: ExecutionMutationIdentity): Readonly<Record<string, unknown>> {
  return input.operation && input.expected ? { operation: input.operation, expected: input.expected } : {};
}

function mutationScopeForRow(row: ExecutionRow): MutationBoundaryScope {
  return { proposalId: row.remediationId, tenantId: row.tenantId, organizationId: row.organizationId,
    projectId: row.projectId, repositoryBindingId: row.repositoryBindingId,
    repositoryId: row.githubRepositoryId.toString(), installationRecordId: row.installationRecordId,
    artifactHash: row.artifactHash, baseRef: row.baseRef, baseCommitSha: row.baseCommitSha };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asScalarRecord(value: unknown): Readonly<Record<string, string | number | boolean | null>> | null {
  const record = asRecord(value);
  if (!record || Object.values(record).some((item) => item !== null && typeof item !== "string" &&
      typeof item !== "number" && typeof item !== "boolean")) return null;
  return Object.freeze({ ...record }) as Readonly<Record<string, string | number | boolean | null>>;
}

function canonicalDescriptorEqual(stored: unknown, expected: unknown): boolean {
  if (!expected) return stored === undefined;
  const canonical = (value: unknown): string => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
    const record = value as Record<string, unknown>;
    return JSON.stringify(Object.keys(record).sort().map((key) => [key, record[key]]));
  };
  try { return canonical(stored) === canonical(expected); } catch { return false; }
}

function validIdentityUserId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validateOptionalDetails(details?: { readonly commitSha?: string; readonly branchName?: string;
  readonly pullRequestNumber?: number; readonly pullRequestUrl?: string }): void {
  if (details?.commitSha !== undefined && !SHA1.test(details.commitSha)) throw new RemediationExecutionPersistenceError("invalid_input");
  if (details?.branchName !== undefined && !BRANCH.test(details.branchName)) throw new RemediationExecutionPersistenceError("invalid_input");
  if (details?.pullRequestNumber !== undefined && (!Number.isSafeInteger(details.pullRequestNumber) || details.pullRequestNumber < 1 ||
      typeof details.pullRequestUrl !== "string" || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*$/.test(details.pullRequestUrl))) {
    throw new RemediationExecutionPersistenceError("invalid_input");
  }
}

function validateCode(code: string): void {
  if (typeof code !== "string" || !CODE.test(code) || !SAFE_FAILURE_CODES.has(code)) {
    throw new RemediationExecutionPersistenceError("invalid_input");
  }
}
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
