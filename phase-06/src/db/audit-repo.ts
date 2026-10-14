import { PrismaClient, AuditEvent, Prisma } from "@prisma/client";
import { PaginatedResult, InvalidCursorError } from "./project-repo.js";

export interface RecordAuditInput {
  tenantId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  projectId?: string;
  metadata?: unknown;
}

export interface ListAuditOptions {
  limit?: number;
  cursor?: string;
}

export class AuditRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Appends an audit event. Audit records are strictly append-only.
   */
  async record(input: RecordAuditInput): Promise<AuditEvent> {
    return this.prisma.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorId: input.actorId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        projectId: input.projectId ?? null,
        metadataJson: input.metadata as Prisma.InputJsonValue ?? Prisma.JsonNull
      }
    });
  }

  async list(tenantId: string, options: ListAuditOptions = {}): Promise<PaginatedResult<AuditEvent>> {
    const rawLimit = options.limit !== undefined && Number.isFinite(options.limit) ? options.limit : 50;
    const limit = Math.min(Math.max(rawLimit, 1), 100);

    if (options.cursor) {
      const cursorRecord = await this.prisma.auditEvent.findFirst({
        where: { id: options.cursor, tenantId }
      });
      if (!cursorRecord) {
        throw new InvalidCursorError(`Invalid cursor: audit event '${options.cursor}' not found.`);
      }
    }

    const items = await this.prisma.auditEvent.findMany({
      where: { tenantId },
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
}
