import { Prisma, PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import type { GitHubExecutionOutcome } from "../../../phase-07/src/remediation/github-executor.js";
import type { FindingSummary } from "../../../phase-07/src/remediation/planner.js";
import { verifyExecutionArtifact, type ArtifactScope } from "../remediation/execution-artifact.js";
import type { RemediationExecutionLifecycle } from "./remediation-execution-lifecycle.js";

export const REMEDIATION_LEASE_DURATION_MS = 60_000;
export const REMEDIATION_RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const;
export const MAX_RETRY_AFTER_MS = 60_000;
const REAPER_BATCH_SIZE = 100;
const MAX_CLAIM_INTEGRITY_CANDIDATES = 1_000;

export interface RemediationLease {
  id: string;
  tenantId: string;
  projectId: string;
  workerId: string;
  leaseToken: string;
  retriesLeft: number;
}

export interface RemediationWorkItem {
  id: string;
  tenantId: string;
  projectId: string;
  scanId: string;
  findingId: string;
  repositoryUrl: string | null;
  finding: FindingSummary;
}

export interface RemediationFailure {
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  errorCode: string;
}

export interface ReapExpiredResult {
  requeued: number;
  failed: number;
  manualReview: number;
}

export interface RemediationJobStore {
  claimNextPending(workerId: string, leaseDurationMs?: number): Promise<RemediationLease | null>;
  loadWorkItem(lease: RemediationLease): Promise<RemediationWorkItem | null>;
  renewLease(lease: RemediationLease, leaseDurationMs?: number): Promise<boolean>;
  completeLease(
    lease: RemediationLease,
    outcome: Exclude<GitHubExecutionOutcome, { kind: "failed" }>
  ): Promise<boolean>;
  failLease(lease: RemediationLease, failure: RemediationFailure): Promise<boolean>;
  reclaimExpiredLeases(): Promise<ReapExpiredResult>;
}

interface ClaimRow {
  id: string;
  tenantId: string;
  projectId: string;
  workerId: string;
  leaseToken: string;
  retriesLeft: number;
}

interface ClaimCandidateRow {
  id: string;
  tenantId: string;
  organizationId: string | null;
  projectId: string;
  repositoryBindingId: string | null;
  githubRepositoryId: string | null;
  installationRecordId: string | null;
  planHash: string | null;
  executionArtifact: unknown;
  executionArtifactHash: string | null;
  approvedArtifactHash: string | null;
}

interface ExpiredLeaseRow {
  id: string;
  tenantId: string;
  projectId: string;
  workerId: string;
  leaseToken: string;
  retriesLeft: number;
}

export interface ExpiredRemediationClaim extends ExpiredLeaseRow {}

interface WorkItemRow {
  id: string;
  tenantId: string;
  projectId: string;
  scanId: string;
  findingId: string;
  repositoryUrl: string | null;
  requirementId: string;
  ruleId: string;
  ruleVersion: string;
  signal: string;
  outcome: string;
  expected: string;
  observed: string;
  reason: string;
}

export function retryDelayMs(retriesLeft: number): number {
  if (retriesLeft <= 0) return 0;
  const index = Math.min(REMEDIATION_MAX_RETRY_INDEX, Math.max(0, 3 - retriesLeft));
  return REMEDIATION_RETRY_DELAYS_MS[index];
}

const REMEDIATION_MAX_RETRY_INDEX = REMEDIATION_RETRY_DELAYS_MS.length - 1;

function leaseDuration(leaseDurationMs: number): number {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error("Lease duration must be a positive safe integer in milliseconds.");
  }
  return leaseDurationMs;
}

function validRetryAfter(retryAfterMs: number | undefined): number {
  if (retryAfterMs === undefined || !Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) return 0;
  return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
}

export class RemediationJobRepository implements RemediationJobStore {
  constructor(private readonly prisma: PrismaClient, private readonly executionLifecycle?: RemediationExecutionLifecycle) {}

  async claimNextPending(
    workerId: string,
    leaseDurationMs = REMEDIATION_LEASE_DURATION_MS
  ): Promise<RemediationLease | null> {
    const lifecycle = this.executionLifecycle;
    if (!lifecycle) throw new Error("Durable remediation execution lifecycle is required to claim work.");
    if (typeof workerId !== "string" || workerId.trim().length === 0 || workerId.length > 200) {
      throw new Error("Worker ID must be a non-empty string of at most 200 characters.");
    }
    const duration = leaseDuration(leaseDurationMs);
    const token = randomUUID();

    return this.prisma.$transaction(async (tx) => {
      const rejectedCandidateIds: string[] = [];
      for (let inspected = 0; inspected < MAX_CLAIM_INTEGRITY_CANDIDATES; inspected++) {
        const exclusion = rejectedCandidateIds.length === 0
          ? Prisma.empty
          : Prisma.sql`AND r.id NOT IN (${Prisma.join(rejectedCandidateIds.map((id) => Prisma.sql`${id}`))})`;
        const candidates = await tx.$queryRaw<ClaimCandidateRow[]>`
          SELECT r.id,
                 r.tenant_id AS "tenantId",
                 r.organization_id AS "organizationId",
                 r.project_id AS "projectId",
                 r.repository_binding_id AS "repositoryBindingId",
                 r.github_repository_id::text AS "githubRepositoryId",
                 b.installation_record_id AS "installationRecordId",
                 r.plan_hash AS "planHash",
                 r.execution_artifact AS "executionArtifact",
                 r.execution_artifact_hash AS "executionArtifactHash",
                 r.approved_artifact_hash AS "approvedArtifactHash"
          FROM remediations AS r
          LEFT JOIN project_github_repositories AS b ON b.id = r.repository_binding_id
          WHERE r.status = 'pending'
            AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= clock_timestamp())
            AND r.approval_state = 'approved'
            AND r.execution_artifact IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM remediation_executions e
              WHERE e.tenant_id = r.tenant_id AND e.organization_id = r.organization_id
                AND e.project_id = r.project_id AND e.remediation_id = r.id
                AND (e.status NOT IN ('queued', 'failed')
                  OR (e.retry_eligible_at IS NOT NULL AND e.retry_eligible_at > clock_timestamp())
                  OR EXISTS (SELECT 1 FROM remediation_execution_events success
                    WHERE success.execution_id = e.id AND success.event_type = 'remote_result_verified')
                  OR EXISTS (SELECT 1 FROM remediation_execution_events intent
                    WHERE intent.execution_id = e.id AND intent.event_type = 'request_intent'
                      AND (SELECT count(*) FROM remediation_execution_events terminal
                        WHERE terminal.execution_id = intent.execution_id
                          AND terminal.attempt_number = intent.attempt_number
                          AND terminal.operation_key = intent.operation_key
                          AND terminal.stage = intent.stage AND terminal.request_hash = intent.request_hash
                          AND terminal.event_type IN ('remote_result_verified', 'remote_mutation_rejected')
                          AND (terminal.event_type <> 'remote_mutation_rejected' OR
                            terminal.metadata->>'requestFingerprint' = intent.metadata #>> '{expected,requestFingerprint}')) <> 1))
            )
            ${exclusion}
          ORDER BY r.created_at ASC, r.id ASC
          FOR UPDATE OF r SKIP LOCKED
          LIMIT 1;
        `;
        const candidate = candidates[0];
        if (!candidate) return null;

        const scope: ArtifactScope | null = candidate.organizationId && candidate.repositoryBindingId &&
          candidate.githubRepositoryId && candidate.installationRecordId && candidate.planHash
          ? {
              proposalId: candidate.id,
              tenantId: candidate.tenantId,
              organizationId: candidate.organizationId,
              projectId: candidate.projectId,
              repositoryBindingId: candidate.repositoryBindingId,
              githubRepositoryId: candidate.githubRepositoryId,
              installationRecordId: candidate.installationRecordId,
              planHash: candidate.planHash
            }
          : null;
        const validArtifact = !!scope && candidate.executionArtifactHash !== null &&
          candidate.approvedArtifactHash === candidate.executionArtifactHash &&
          verifyExecutionArtifact(candidate.executionArtifact, candidate.executionArtifactHash, scope);
        if (!validArtifact) {
          rejectedCandidateIds.push(candidate.id);
          continue;
        }

      const rows = await tx.$queryRaw<ClaimRow[]>`
        WITH candidate AS (
          SELECT id, tenant_id
          FROM remediations
          WHERE status = 'pending'
            AND id = ${candidate.id}
            AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp())
            -- A remediation row is both the proposal and job in the current model;
            -- its primary key is the persisted proposal identifier.
            AND id IS NOT NULL
            -- Legacy jobs have NULL approval/artifact fields and are never eligible.
            -- Keep every proposal and artifact condition inside the atomic claim.
            AND approval_state = 'approved'
            AND requested_by_identity_user_id IS NOT NULL
            AND approved_by_identity_user_id IS NOT NULL
            AND approved_at IS NOT NULL
            AND organization_id IS NOT NULL
            AND repository_binding_id IS NOT NULL
            AND github_repository_id IS NOT NULL
            AND github_repository_id > 0
            AND plan_hash ~ '^[0-9a-f]{64}$'
            AND plan_snapshot IS NOT NULL
            AND jsonb_typeof(plan_snapshot) = 'object'
            AND execution_artifact IS NOT NULL
            AND jsonb_typeof(execution_artifact) = 'object'
            AND execution_artifact_hash ~ '^[0-9a-f]{64}$'
            AND approved_artifact_hash IS NOT NULL
            AND approved_artifact_hash = execution_artifact_hash
            AND EXISTS (
              SELECT 1 FROM projects AS p
              WHERE p.id = remediations.project_id
                AND p.tenant_id = remediations.tenant_id
                AND p.organization_id = remediations.organization_id
            )
            AND EXISTS (
              SELECT 1 FROM organizations AS o
              WHERE o.id = remediations.organization_id
                AND o.status = 'active'
            )
            AND EXISTS (
              SELECT 1 FROM scans AS s
              WHERE s.id = remediations.scan_id
                AND s.tenant_id = remediations.tenant_id
                AND s.project_id = remediations.project_id
            )
            AND EXISTS (
              SELECT 1 FROM findings AS f
              WHERE f.id = remediations.finding_id
                AND f.tenant_id = remediations.tenant_id
                AND f.project_id = remediations.project_id
                AND f.scan_id = remediations.scan_id
            )
            AND EXISTS (
              SELECT 1 FROM project_github_repositories AS b
              WHERE b.id = remediations.repository_binding_id
                AND b.tenant_id = remediations.tenant_id
                AND b.organization_id = remediations.organization_id
                AND b.project_id = remediations.project_id
                AND b.github_repository_id = remediations.github_repository_id
                AND b.status = 'active'
            )
            AND EXISTS (
              SELECT 1 FROM organization_github_installations AS i
              WHERE i.id = (
                SELECT b.installation_record_id FROM project_github_repositories AS b
                WHERE b.id = remediations.repository_binding_id
                  AND b.tenant_id = remediations.tenant_id
                  AND b.organization_id = remediations.organization_id
                  AND b.project_id = remediations.project_id
                  AND b.github_repository_id = remediations.github_repository_id
              )
                AND i.organization_id = remediations.organization_id
                AND i.status = 'active'
            )
            AND EXISTS (
              SELECT 1 FROM project_organization_adoptions AS a
              WHERE a.tenant_id = remediations.tenant_id
                AND a.organization_id = remediations.organization_id
                AND a.project_id = remediations.project_id
                AND a.status = 'approved'
            )
            AND NOT EXISTS (
              SELECT 1 FROM remediation_executions AS e
              WHERE e.tenant_id = remediations.tenant_id AND e.organization_id = remediations.organization_id
                AND e.project_id = remediations.project_id AND e.remediation_id = remediations.id
                AND (e.status NOT IN ('queued', 'failed')
                  OR (e.retry_eligible_at IS NOT NULL AND e.retry_eligible_at > clock_timestamp())
                  OR EXISTS (SELECT 1 FROM remediation_execution_events AS success
                    WHERE success.execution_id = e.id AND success.event_type = 'remote_result_verified')
                  OR EXISTS (SELECT 1 FROM remediation_execution_events AS intent
                    WHERE intent.execution_id = e.id AND intent.event_type = 'request_intent'
                      AND (SELECT count(*) FROM remediation_execution_events AS terminal
                        WHERE terminal.execution_id = intent.execution_id
                          AND terminal.attempt_number = intent.attempt_number
                          AND terminal.operation_key = intent.operation_key
                          AND terminal.stage = intent.stage AND terminal.request_hash = intent.request_hash
                          AND terminal.event_type IN ('remote_result_verified', 'remote_mutation_rejected')
                          AND (terminal.event_type <> 'remote_mutation_rejected' OR
                            terminal.metadata->>'requestFingerprint' = intent.metadata #>> '{expected,requestFingerprint}')) <> 1))
            )
          ORDER BY created_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE remediations AS r
        SET status = 'running',
            worker_id = ${workerId},
            claimed_at = NOW(),
            heartbeat_at = NOW(),
            lease_expires_at = NOW() + (${duration} * INTERVAL '1 millisecond'),
            lease_token = ${token}::uuid,
            next_attempt_at = NULL,
            updated_at = NOW()
        FROM candidate AS c
        WHERE r.id = c.id
          AND r.tenant_id = c.tenant_id
          AND r.status = 'pending'
          AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= clock_timestamp())
        RETURNING r.id,
                  r.tenant_id AS "tenantId",
                  r.project_id AS "projectId",
                  r.worker_id AS "workerId",
                  r.lease_token::text AS "leaseToken",
                  r.retries_left AS "retriesLeft";
      `;
      const row = rows[0];
        if (!row) {
          rejectedCandidateIds.push(candidate.id);
          continue;
        }

      // Queue status, execution attempt, execution-started event and both audit
      // records commit together. Failure here rolls the lease update back.
      await lifecycle.startClaimed(tx, row);

      await tx.auditEvent.create({
        data: {
          tenantId: row.tenantId,
          projectId: row.projectId,
          actorId: "system",
          action: "REMEDIATION_WORKER_CLAIMED",
          resourceType: "remediation",
          resourceId: row.id,
          metadataJson: { workerId } as Prisma.InputJsonValue
        }
      });

      return row;
      }
      return null;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async loadWorkItem(lease: RemediationLease): Promise<RemediationWorkItem | null> {
    const rows = await this.prisma.$queryRaw<WorkItemRow[]>`
      SELECT r.id,
             r.tenant_id AS "tenantId",
             r.project_id AS "projectId",
             r.scan_id AS "scanId",
             r.finding_id AS "findingId",
             p.repository_url AS "repositoryUrl",
             f.requirement_id AS "requirementId",
             f.rule_id AS "ruleId",
             f.rule_version AS "ruleVersion",
             f.signal,
             f.outcome,
             f.expected,
             f.observed,
             f.reason
      FROM remediations AS r
      JOIN projects AS p
        ON p.id = r.project_id AND p.tenant_id = r.tenant_id
      JOIN findings AS f
        ON f.id = r.finding_id AND f.tenant_id = r.tenant_id
      WHERE r.id = ${lease.id}
        AND r.tenant_id = ${lease.tenantId}
        AND r.status = 'running'
        AND r.lease_token = ${lease.leaseToken}::uuid
        AND r.lease_expires_at > NOW();
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenantId,
      projectId: row.projectId,
      scanId: row.scanId,
      findingId: row.findingId,
      repositoryUrl: row.repositoryUrl,
      finding: {
        requirementId: row.requirementId,
        ruleId: row.ruleId,
        ruleVersion: row.ruleVersion,
        signal: row.signal,
        outcome: row.outcome,
        expected: row.expected,
        observed: row.observed,
        reason: row.reason
      }
    };
  }

  async renewLease(lease: RemediationLease, leaseDurationMs = REMEDIATION_LEASE_DURATION_MS): Promise<boolean> {
    const duration = leaseDuration(leaseDurationMs);
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM remediations WHERE id = ${lease.id} AND tenant_id = ${lease.tenantId}
          AND project_id = ${lease.projectId} AND status = 'running' AND worker_id = ${lease.workerId}
          AND lease_token = ${lease.leaseToken}::uuid AND lease_expires_at > clock_timestamp()
        FOR UPDATE
      `;
      if (locked.length !== 1) return false;
      const nextExpiry = await tx.$queryRaw<Array<{ leaseExpiresAt: Date }>>`
        UPDATE remediations SET heartbeat_at = clock_timestamp(),
          lease_expires_at = clock_timestamp() + (${duration} * INTERVAL '1 millisecond'), updated_at = clock_timestamp()
        WHERE id = ${lease.id} AND tenant_id = ${lease.tenantId} AND project_id = ${lease.projectId}
          AND status = 'running' AND worker_id = ${lease.workerId} AND lease_token = ${lease.leaseToken}::uuid
          AND lease_expires_at > clock_timestamp()
        RETURNING lease_expires_at AS "leaseExpiresAt"
      `;
      if (nextExpiry.length !== 1) return false;
      const execution = await tx.$executeRaw`
        UPDATE remediation_executions SET lease_expires_at = ${nextExpiry[0]!.leaseExpiresAt},
          version = version + 1, updated_at = clock_timestamp()
        WHERE remediation_id = ${lease.id} AND tenant_id = ${lease.tenantId} AND project_id = ${lease.projectId}
          AND lease_owner = ${lease.workerId} AND lease_token_hash = ${createHash("sha256").update(lease.leaseToken).digest("hex")}
          AND lease_expires_at > clock_timestamp() AND status NOT IN ('completed', 'failed', 'manual_review_required',
            'reconciliation_in_progress', 'reconciliation_resolved')
      `;
      if (execution !== 1) throw new Error("Durable execution lease renewal failed.");
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async completeLease(
    lease: RemediationLease,
    outcome: Exclude<GitHubExecutionOutcome, { kind: "failed" }>
  ): Promise<boolean> {
    let status: "open" | "merged" | "closed";
    let action: string;
    let errorMessage: string | null = null;
    if (outcome.kind === "pull-request") {
      status = "open";
      action = "REMEDIATION_PR_OPENED";
    } else if (outcome.kind === "already-completed") {
      status = "merged";
      action = "REMEDIATION_PR_RECONCILED_MERGED";
    } else {
      status = "closed";
      action = "REMEDIATION_PR_REQUIRES_MANUAL_REVIEW";
      errorMessage = outcome.message;
    }

    return this.prisma.$transaction(async (tx) => {
      const count = await tx.$executeRaw`
        UPDATE remediations
        SET status = ${status},
            branch_name = ${outcome.branchName},
            pr_number = ${outcome.prNumber},
            pr_url = ${outcome.prUrl},
            patch_summary = ${outcome.summary},
            error_message = ${errorMessage},
            worker_id = NULL,
            claimed_at = NULL,
            heartbeat_at = NULL,
            lease_expires_at = NULL,
            lease_token = NULL,
            updated_at = NOW()
        WHERE id = ${lease.id}
          AND tenant_id = ${lease.tenantId}
          AND status = 'running'
          AND lease_token = ${lease.leaseToken}::uuid
          AND lease_expires_at > NOW()
          AND EXISTS (SELECT 1 FROM remediation_executions e
            WHERE e.remediation_id = remediations.id AND e.tenant_id = remediations.tenant_id
              AND e.project_id = remediations.project_id AND e.status = 'completed');
      `;
      if (count !== 1) return false;

      await tx.auditEvent.create({
        data: {
          tenantId: lease.tenantId,
          projectId: lease.projectId,
          actorId: "system",
          action,
          resourceType: "remediation",
          resourceId: lease.id,
          metadataJson: {
            status,
            branchName: outcome.branchName,
            prNumber: outcome.prNumber,
            prUrl: outcome.prUrl
          } as Prisma.InputJsonValue
        }
      });
      return true;
    });
  }

  async failLease(lease: RemediationLease, failure: RemediationFailure): Promise<boolean> {
    const shouldRetry = failure.retryable && lease.retriesLeft > 0;
    const retriesLeft = shouldRetry ? lease.retriesLeft - 1 : 0;
    const delayMs = shouldRetry
      ? Math.max(retryDelayMs(lease.retriesLeft), validRetryAfter(failure.retryAfterMs))
      : 0;
    const status = shouldRetry ? "pending" : "failed";
    const action = shouldRetry ? "REMEDIATION_RETRY_SCHEDULED" : "REMEDIATION_FAILED";

    return this.prisma.$transaction(async (tx) => {
      const count = await tx.$executeRaw`
        UPDATE remediations
        SET status = ${status},
            retries_left = ${retriesLeft},
            next_attempt_at = CASE
              WHEN ${shouldRetry} THEN NOW() + (${delayMs} * INTERVAL '1 millisecond')
              ELSE NULL
            END,
            error_message = ${failure.message.slice(0, 512)},
            worker_id = NULL,
            claimed_at = NULL,
            heartbeat_at = NULL,
            lease_expires_at = NULL,
            lease_token = NULL,
            updated_at = NOW()
        WHERE id = ${lease.id}
          AND tenant_id = ${lease.tenantId}
          AND status = 'running'
          AND lease_token = ${lease.leaseToken}::uuid
          AND lease_expires_at > NOW()
          AND NOT EXISTS (SELECT 1 FROM remediation_executions e
            WHERE e.remediation_id = remediations.id AND e.tenant_id = remediations.tenant_id
              AND e.project_id = remediations.project_id);
      `;
      if (count !== 1) return false;

      await tx.auditEvent.create({
        data: {
          tenantId: lease.tenantId,
          projectId: lease.projectId,
          actorId: "system",
          action,
          resourceType: "remediation",
          resourceId: lease.id,
          metadataJson: {
            status,
            errorCode: failure.errorCode,
            retriesLeft,
            delayMs
          } as Prisma.InputJsonValue
        }
      });
      return true;
    });
  }

  async reclaimExpiredLeases(): Promise<ReapExpiredResult> {
    const lifecycle = this.executionLifecycle;
    if (!lifecycle) throw new Error("Durable remediation execution lifecycle is required to reclaim work.");
    return this.prisma.$transaction(async (tx) => {
      const expired = await tx.$queryRaw<ExpiredLeaseRow[]>`
        SELECT id,
               tenant_id AS "tenantId",
               project_id AS "projectId",
               worker_id AS "workerId",
               lease_token::text AS "leaseToken",
               retries_left AS "retriesLeft"
        FROM remediations
        WHERE status = 'running'
          AND lease_token IS NOT NULL
          AND lease_expires_at <= NOW()
        ORDER BY lease_expires_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${REAPER_BATCH_SIZE};
      `;
      let requeued = 0;
      let failed = 0;
      let manualReview = 0;

      for (const row of expired) {
        const outcome = await lifecycle.expireClaim(tx, row);
        if (outcome === "requeued") requeued++;
        else if (outcome === "failed") failed++;
        else if (outcome === "manual_review") manualReview++;
      }

      return { requeued, failed, manualReview };
    });
  }
}
