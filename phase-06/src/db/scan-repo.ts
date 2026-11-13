import { PrismaClient, Scan, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PaginatedResult, InvalidCursorError } from "./project-repo.js";
import { FindingInput } from "./finding-repo.js";

export type ScanStatus = "pending" | "running" | "completed" | "failed";

export interface CreateScanInput {
  tenantId: string;
  projectId: string;
  triggeredById?: string;
  maxAttempts?: number;
  modelOverride?: unknown;
}

export interface UpdateScanStatusInput {
  status: ScanStatus;
  startedAt?: Date;
  completedAt?: Date;
  error?: string | null;
  workerId?: string | null;
  heartbeatAt?: Date;
  leaseExpiresAt?: Date;
  attemptCount?: number;
}

export interface ListScansOptions {
  limit?: number;
  cursor?: string;
}

export interface ReclaimResult {
  requeued: number;
  permanentlyFailed: number;
}

export interface ScanLease {
  tenantId: string;
  projectId: string;
  scanId: string;
  workerId: string;
  leaseToken: string;
}

export class ActiveScanConflictError extends Error {
  readonly statusCode = 409;
  constructor(projectId: string) {
    super(`An active scan is already pending or running for project ${projectId}.`);
    this.name = "ActiveScanConflictError";
  }
}

export class StaleWorkerError extends Error {
  readonly statusCode = 409;
  constructor(scanId: string, workerId: string) {
    super(`Worker ${workerId} lost active lease for scan ${scanId}; publication rejected.`);
    this.name = "StaleWorkerError";
  }
}

export class ScanRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateScanInput): Promise<Scan> {
    try {
      return await this.prisma.scan.create({
        data: {
          tenantId: input.tenantId,
          projectId: input.projectId,
          status: "pending",
          triggeredById: input.triggeredById ?? null,
          maxAttempts: input.maxAttempts ?? 3,
          modelOverride: (input.modelOverride as Prisma.InputJsonValue) ?? Prisma.JsonNull
        }
      });
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: unknown }).code === "P2002"
      ) {
        throw new ActiveScanConflictError(input.projectId);
      }
      throw err;
    }
  }

  async findById(tenantId: string, scanId: string): Promise<Scan | null> {
    return this.prisma.scan.findFirst({
      where: {
        id: scanId,
        tenantId
      }
    });
  }

  async findActiveScanForProject(tenantId: string, projectId: string): Promise<Scan | null> {
    return this.prisma.scan.findFirst({
      where: {
        tenantId,
        projectId,
        status: { in: ["pending", "running"] }
      }
    });
  }

  async listByProject(tenantId: string, projectId: string, options: ListScansOptions = {}): Promise<PaginatedResult<Scan>> {
    const rawLimit = options.limit !== undefined && Number.isFinite(options.limit) ? options.limit : 20;
    const limit = Math.min(Math.max(rawLimit, 1), 100);

    if (options.cursor) {
      const cursorRecord = await this.prisma.scan.findFirst({
        where: { id: options.cursor, tenantId, projectId }
      });
      if (!cursorRecord) {
        throw new InvalidCursorError(`Invalid cursor: scan '${options.cursor}' not found.`);
      }
    }

    const items = await this.prisma.scan.findMany({
      where: {
        tenantId,
        projectId
      },
      take: limit + 1,
      skip: options.cursor ? 1 : 0,
      cursor: options.cursor ? { id: options.cursor } : undefined,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }]
    });

    const hasMore = items.length > limit;
    const resultItems = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? resultItems[resultItems.length - 1].id : undefined;

    return {
      items: resultItems,
      nextCursor,
      hasMore
    };
  }

  async updateStatus(tenantId: string, scanId: string, input: UpdateScanStatusInput): Promise<Scan | null> {
    // This compatibility path is used when enqueueing fails, before a worker
    // owns the pending scan. It must never mutate an active worker's lease.
    const result = await this.prisma.scan.updateMany({
      where: { id: scanId, tenantId, status: "pending", leaseToken: null },
      data: {
        status: input.status,
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
        ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.workerId !== undefined ? { workerId: input.workerId } : {}),
        ...(input.heartbeatAt !== undefined ? { heartbeatAt: input.heartbeatAt } : {}),
        ...(input.leaseExpiresAt !== undefined ? { leaseExpiresAt: input.leaseExpiresAt } : {}),
        ...(input.attemptCount !== undefined ? { attemptCount: input.attemptCount } : {})
      }
    });
    if (result.count === 0) return null;
    return this.findById(tenantId, scanId);
  }

  /**
   * Atomically claims the next pending scan using PostgreSQL FOR UPDATE SKIP LOCKED.
   * Increments attempt_count, assigns workerId, and sets initial lease duration.
   */
  async claimNextPendingScan(
    workerId: string,
    leaseDurationSeconds = 300
  ): Promise<(Scan & { organizationId: string | null }) | null> {
    const leaseToken = randomUUID();
    const claimedRows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      WITH claim AS (
        SELECT id
        FROM scans
        WHERE status = 'pending'
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE scans
      SET status = 'running',
          worker_id = ${workerId},
          started_at = COALESCE(scans.started_at, NOW()),
          claimed_at = NOW(),
          heartbeat_at = NOW(),
          lease_expires_at = NOW() + (${leaseDurationSeconds} * INTERVAL '1 second'),
          lease_token = ${leaseToken}::uuid,
          attempt_count = scans.attempt_count + 1
      FROM claim
      WHERE scans.id = claim.id
      RETURNING
        scans.id,
        scans.tenant_id AS "tenantId",
        scans.organization_id AS "organizationId",
        scans.project_id AS "projectId",
        scans.status,
        scans.triggered_by_id AS "triggeredById",
        scans.started_at AS "startedAt",
        scans.completed_at AS "completedAt",
        scans.error,
        scans.worker_id AS "workerId",
        scans.lease_token::text AS "leaseToken",
        scans.claimed_at AS "claimedAt",
        scans.heartbeat_at AS "heartbeatAt",
        scans.lease_expires_at AS "leaseExpiresAt",
        scans.attempt_count AS "attemptCount",
        scans.max_attempts AS "maxAttempts",
        scans.model_override AS "modelOverride",
        scans.created_at AS "createdAt";
    `;

    if (claimedRows.length === 0) {
      return null;
    }

    const row = claimedRows[0];
    return {
      id: row.id as string,
      tenantId: (row.tenantId ?? row.tenant_id) as string,
      organizationId: ((row.organizationId ?? row.organization_id) as string | null) ?? null,
      projectId: (row.projectId ?? row.project_id) as string,
      status: row.status as string,
      triggeredById: ((row.triggeredById ?? row.triggered_by_id) as string) ?? null,
      startedAt: ((row.startedAt ?? row.started_at) as Date) ?? null,
      completedAt: ((row.completedAt ?? row.completed_at) as Date) ?? null,
      error: ((row.error ?? row.error) as string) ?? null,
      workerId: ((row.workerId ?? row.worker_id) as string) ?? null,
      leaseToken: ((row.leaseToken ?? row.lease_token) as string) ?? null,
      claimedAt: ((row.claimedAt ?? row.claimed_at) as Date) ?? null,
      heartbeatAt: ((row.heartbeatAt ?? row.heartbeat_at) as Date) ?? null,
      leaseExpiresAt: ((row.leaseExpiresAt ?? row.lease_expires_at) as Date) ?? null,
      attemptCount: ((row.attemptCount ?? row.attempt_count) as number) ?? 0,
      maxAttempts: ((row.maxAttempts ?? row.max_attempts) as number) ?? 3,
      modelOverride: (row.modelOverride ?? row.model_override ?? null) as Prisma.JsonValue,
      createdAt: (row.createdAt ?? row.created_at) as Date
    } as Scan & { organizationId: string | null };
  }

  /**
   * Renews only the exact, unexpired per-claim lease using database time.
   * Returns false if the worker no longer owns the active lease.
   */
  async renewLease(lease: ScanLease, leaseDurationSeconds = 300): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE scans
      SET heartbeat_at = NOW(),
          lease_expires_at = NOW() + (${leaseDurationSeconds} * INTERVAL '1 second')
      WHERE id = ${lease.scanId}
        AND tenant_id = ${lease.tenantId}
        AND project_id = ${lease.projectId}
        AND worker_id = ${lease.workerId}
        AND lease_token = ${lease.leaseToken}::uuid
        AND status = 'running'
        AND lease_expires_at > NOW();
    `;

    return count > 0;
  }

  async recordRunningAudit(lease: ScanLease, actorId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const count = await tx.$executeRaw`
        UPDATE scans
        SET heartbeat_at = NOW()
        WHERE id = ${lease.scanId}
          AND tenant_id = ${lease.tenantId}
          AND project_id = ${lease.projectId}
          AND worker_id = ${lease.workerId}
          AND lease_token = ${lease.leaseToken}::uuid
          AND status = 'running'
          AND lease_expires_at > NOW();
      `;
      if (count === 0) return false;
      await tx.auditEvent.create({
        data: {
          tenantId: lease.tenantId,
          projectId: lease.projectId,
          actorId,
          action: "SCAN_RUNNING",
          resourceType: "scan",
          resourceId: lease.scanId
        }
      });
      return true;
    });
  }

  /**
   * Atomically publishes scan completion and findings inside a transaction.
   * Strictly enforces that the worker still holds the lease at time of publication.
   * Throws StaleWorkerError if lease was lost, rolling back findings.
   */
  async completeScanWithFindings(
    lease: ScanLease,
    findings: FindingInput[],
    actorId: string
  ): Promise<Scan> {
    return this.prisma.$transaction(async (tx) => {
      // 1. Conditionally update scan to completed, asserting valid active lease
      const updatedCount = await tx.$executeRaw`
        UPDATE scans
        SET status = 'completed',
            completed_at = NOW(),
            worker_id = NULL,
            lease_token = NULL,
            claimed_at = NULL,
            heartbeat_at = NULL,
            lease_expires_at = NULL
        WHERE id = ${lease.scanId}
          AND tenant_id = ${lease.tenantId}
          AND project_id = ${lease.projectId}
          AND worker_id = ${lease.workerId}
          AND lease_token = ${lease.leaseToken}::uuid
          AND status = 'running'
          AND lease_expires_at > NOW();
      `;

      if (updatedCount === 0) {
        throw new StaleWorkerError(lease.scanId, lease.workerId);
      }

      const scan = await tx.scan.findUniqueOrThrow({
        where: { id: lease.scanId, tenantId: lease.tenantId, projectId: lease.projectId }
      });
      const attemptNumber = scan.attemptCount;

      // 2. Remove any partial findings from prior attempts
      await tx.finding.deleteMany({
        where: { tenantId: lease.tenantId, scanId: lease.scanId, projectId: lease.projectId }
      });

      // 3. Atomically publish findings for the successful attempt
      if (findings.length > 0) {
        await tx.finding.createMany({
          data: findings.map((f) => ({
            tenantId: lease.tenantId,
            projectId: lease.projectId,
            scanId: lease.scanId,
            attemptNumber,
            requirementId: f.requirementId,
            ruleId: f.ruleId,
            ruleVersion: f.ruleVersion,
            signal: f.signal,
            outcome: f.outcome,
            expected: f.expected,
            observed: f.observed,
            reason: f.reason,
            evidenceJson: (f.evidenceJson as Prisma.InputJsonValue) ?? Prisma.JsonNull
          }))
        });
      }

      await tx.auditEvent.create({
        data: {
          tenantId: lease.tenantId,
          projectId: lease.projectId,
          actorId,
          action: "SCAN_COMPLETED",
          resourceType: "scan",
          resourceId: lease.scanId,
          metadataJson: { totalFindings: findings.length } as Prisma.InputJsonValue
        }
      });

      return scan;
    });
  }

  /**
   * Conditionally marks a scan as failed if the worker still holds the active lease.
   */
  async failScanWithLease(
    lease: ScanLease,
    errorMessage: string,
    actorId: string
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const updatedCount = await tx.$executeRaw`
        UPDATE scans
        SET status = 'failed',
            error = ${errorMessage},
            completed_at = NOW(),
            lease_token = NULL,
            worker_id = NULL,
            claimed_at = NULL,
            heartbeat_at = NULL,
            lease_expires_at = NULL
        WHERE id = ${lease.scanId}
          AND tenant_id = ${lease.tenantId}
          AND project_id = ${lease.projectId}
          AND worker_id = ${lease.workerId}
          AND lease_token = ${lease.leaseToken}::uuid
          AND status = 'running'
          AND lease_expires_at > NOW();
      `;
      if (updatedCount === 0) return false;
      await tx.auditEvent.create({
        data: {
          tenantId: lease.tenantId,
          projectId: lease.projectId,
          actorId,
          action: "SCAN_FAILED",
          resourceType: "scan",
          resourceId: lease.scanId,
          metadataJson: { error: errorMessage } as Prisma.InputJsonValue
        }
      });
      return true;
    });
  }

  /**
   * Reclaims expired leases.
   * Jobs with attempt_count < max_attempts are re-queued to 'pending'.
   * Jobs with attempt_count >= max_attempts transition to terminal 'failed'.
   */
  async reclaimExpiredLeases(): Promise<ReclaimResult> {
    return this.prisma.$transaction(async (tx) => {
      const requeued = await tx.$queryRaw<Array<{ id: string }>>`
        WITH expired AS (
          SELECT id, tenant_id, project_id, lease_token
          FROM scans
          WHERE status = 'running'
            AND lease_expires_at <= NOW()
            AND attempt_count < max_attempts
          ORDER BY lease_expires_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 100
        )
        UPDATE scans AS s
        SET status = 'pending',
            worker_id = NULL,
            lease_token = NULL,
            claimed_at = NULL,
            heartbeat_at = NULL,
            lease_expires_at = NULL,
            error = 'Worker lease expired; re-queued for retry.'
        FROM expired AS e
        WHERE s.id = e.id
          AND s.tenant_id = e.tenant_id
          AND s.project_id = e.project_id
          AND s.lease_token IS NOT DISTINCT FROM e.lease_token
          AND s.status = 'running'
          AND s.lease_expires_at <= NOW()
          AND s.attempt_count < s.max_attempts
        RETURNING s.id;
      `;
      const failed = await tx.$queryRaw<Array<{ id: string }>>`
        WITH expired AS (
          SELECT id, tenant_id, project_id, lease_token
          FROM scans
          WHERE status = 'running'
            AND lease_expires_at <= NOW()
            AND attempt_count >= max_attempts
          ORDER BY lease_expires_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 100
        )
        UPDATE scans AS s
        SET status = 'failed',
            completed_at = NOW(),
            worker_id = NULL,
            lease_token = NULL,
            claimed_at = NULL,
            heartbeat_at = NULL,
            lease_expires_at = NULL,
            error = 'Scan failed: worker lease expired and maximum retry attempts exceeded.'
        FROM expired AS e
        WHERE s.id = e.id
          AND s.tenant_id = e.tenant_id
          AND s.project_id = e.project_id
          AND s.lease_token IS NOT DISTINCT FROM e.lease_token
          AND s.status = 'running'
          AND s.lease_expires_at <= NOW()
          AND s.attempt_count >= s.max_attempts
        RETURNING s.id;
      `;
      return { requeued: requeued.length, permanentlyFailed: failed.length };
    });
  }

  /**
   * Deprecated compatibility helper: delegates to reclaimExpiredLeases().
   */
  async recoverOrphanedScans(): Promise<number> {
    const res = await this.reclaimExpiredLeases();
    return res.requeued + res.permanentlyFailed;
  }
}
