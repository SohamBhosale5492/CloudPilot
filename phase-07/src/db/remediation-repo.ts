/**
 * RemediationRepository — durable persistence for remediation lifecycle.
 *
 * Uses the phase-07 Prisma client (same DATABASE_URL as phase-06).
 * All queries are strictly tenant-scoped.
 */

import { PrismaClient, Remediation } from "@prisma/client";

export type RemediationStatus = "pending" | "open" | "merged" | "closed" | "failed";

export interface CreateRemediationInput {
  tenantId: string;
  projectId: string;
  scanId: string;
  findingId: string;
  idempotencyKey: string;
  patchSummary?: string;
}

export interface UpdateRemediationInput {
  status?: RemediationStatus;
  branchName?: string;
  prNumber?: number;
  prUrl?: string;
  errorMessage?: string | null;
  retriesLeft?: number;
}

export class InvalidCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCursorError";
  }
}

export { Remediation };

export class RemediationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Creates a remediation record in 'pending' status.
   * Returns existing record if idempotency key already exists (idempotent).
   */
  async createOrFetch(input: CreateRemediationInput): Promise<Remediation> {
    const existing = await this.prisma.remediation.findUnique({
      where: { idempotencyKey: input.idempotencyKey }
    });
    if (existing) return existing;

    try {
      return await this.prisma.remediation.create({
        data: {
          tenantId: input.tenantId,
          projectId: input.projectId,
          scanId: input.scanId,
          findingId: input.findingId,
          idempotencyKey: input.idempotencyKey,
          status: "pending",
          patchSummary: input.patchSummary ?? null
        }
      });
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: unknown }).code === "P2002"
      ) {
        const raced = await this.prisma.remediation.findUnique({
          where: { idempotencyKey: input.idempotencyKey }
        });
        if (raced) return raced;
      }
      throw err;
    }
  }

  async findByIdempotencyKey(key: string): Promise<Remediation | null> {
    return this.prisma.remediation.findUnique({
      where: { idempotencyKey: key }
    });
  }

  async findById(tenantId: string, id: string): Promise<Remediation | null> {
    return this.prisma.remediation.findFirst({
      where: { id, tenantId }
    });
  }

  async update(tenantId: string, id: string, input: UpdateRemediationInput): Promise<Remediation | null> {
    const existing = await this.findById(tenantId, id);
    if (!existing) return null;

    return this.prisma.remediation.update({
      where: { id },
      data: {
        ...(input.status !== undefined       ? { status: input.status }             : {}),
        ...(input.branchName !== undefined   ? { branchName: input.branchName }     : {}),
        ...(input.prNumber !== undefined     ? { prNumber: input.prNumber }         : {}),
        ...(input.prUrl !== undefined        ? { prUrl: input.prUrl }               : {}),
        ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
        ...(input.retriesLeft !== undefined  ? { retriesLeft: input.retriesLeft }   : {})
      }
    });
  }

  async listByProject(
    tenantId: string,
    projectId: string,
    options: { limit?: number; cursor?: string } = {}
  ): Promise<{ items: Remediation[]; nextCursor?: string; hasMore: boolean }> {
    const rawLimit = options.limit !== undefined && Number.isFinite(options.limit) ? options.limit : 20;
    const limit = Math.min(Math.max(rawLimit, 1), 100);

    if (options.cursor) {
      const cursorRecord = await this.prisma.remediation.findFirst({
        where: { id: options.cursor, tenantId, projectId }
      });
      if (!cursorRecord) {
        throw new InvalidCursorError(
          `Invalid cursor: remediation '${options.cursor}' not found for tenant '${tenantId}' and project '${projectId}'.`
        );
      }
    }

    const items = await this.prisma.remediation.findMany({
      where: { tenantId, projectId },
      take: limit + 1,
      skip: options.cursor ? 1 : 0,
      cursor: options.cursor ? { id: options.cursor } : undefined,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }]
    });

    const hasMore = items.length > limit;
    const resultItems = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? resultItems[resultItems.length - 1].id : undefined;
    return { items: resultItems, nextCursor, hasMore };
  }

  async listByScan(tenantId: string, scanId: string): Promise<Remediation[]> {
    return this.prisma.remediation.findMany({
      where: { tenantId, scanId },
      orderBy: [{ createdAt: "asc" }]
    });
  }
}
