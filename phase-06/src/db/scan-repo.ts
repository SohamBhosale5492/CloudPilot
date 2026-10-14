import { PrismaClient, Scan } from "@prisma/client";
import { PaginatedResult, InvalidCursorError } from "./project-repo.js";

export type ScanStatus = "pending" | "running" | "completed" | "failed";

export interface CreateScanInput {
  tenantId: string;
  projectId: string;
  triggeredById?: string;
}

export interface UpdateScanStatusInput {
  status: ScanStatus;
  startedAt?: Date;
  completedAt?: Date;
  error?: string | null;
}

export interface ListScansOptions {
  limit?: number;
  cursor?: string;
}

export class ActiveScanConflictError extends Error {
  readonly statusCode = 409;
  constructor(projectId: string) {
    super(`An active scan is already pending or running for project ${projectId}.`);
    this.name = "ActiveScanConflictError";
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
          triggeredById: input.triggeredById ?? null
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
    const existing = await this.findById(tenantId, scanId);
    if (!existing) {
      return null;
    }

    return this.prisma.scan.update({
      where: { id: scanId },
      data: {
        status: input.status,
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
        ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
        ...(input.error !== undefined ? { error: input.error } : {})
      }
    });
  }

  /**
   * Recovers orphaned jobs left in "pending" or "running" state across restarts.
   */
  async recoverOrphanedScans(): Promise<number> {
    const result = await this.prisma.scan.updateMany({
      where: {
        status: { in: ["pending", "running"] }
      },
      data: {
        status: "failed",
        error: "Job abandoned due to server shutdown or restart.",
        completedAt: new Date()
      }
    });

    return result.count;
  }
}
