import { PrismaClient, Finding, Prisma } from "@prisma/client";
import { PaginatedResult, InvalidCursorError } from "./project-repo.js";

export interface FindingInput {
  requirementId: string;
  ruleId: string;
  ruleVersion: string;
  signal: string;
  outcome: string;
  expected: string;
  observed: string;
  reason: string;
  evidenceJson: unknown;
}

export interface ListFindingsOptions {
  limit?: number;
  cursor?: string;
}

export class FindingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createMany(tenantId: string, projectId: string, scanId: string, findings: FindingInput[]): Promise<number> {
    if (findings.length === 0) {
      return 0;
    }

    const data = findings.map((f) => ({
      tenantId,
      projectId,
      scanId,
      requirementId: f.requirementId,
      ruleId: f.ruleId,
      ruleVersion: f.ruleVersion,
      signal: f.signal,
      outcome: f.outcome,
      expected: f.expected,
      observed: f.observed,
      reason: f.reason,
      evidenceJson: f.evidenceJson as Prisma.InputJsonValue ?? Prisma.JsonNull
    }));

    const result = await this.prisma.finding.createMany({
      data
    });

    return result.count;
  }

  async listByScan(tenantId: string, scanId: string, options: ListFindingsOptions = {}): Promise<PaginatedResult<Finding>> {
    const rawLimit = options.limit !== undefined && Number.isFinite(options.limit) ? options.limit : 50;
    const limit = Math.min(Math.max(rawLimit, 1), 100);

    if (options.cursor) {
      const cursorRecord = await this.prisma.finding.findFirst({
        where: { id: options.cursor, tenantId, scanId }
      });
      if (!cursorRecord) {
        throw new InvalidCursorError(`Invalid cursor: finding '${options.cursor}' not found.`);
      }
    }

    const items = await this.prisma.finding.findMany({
      where: {
        tenantId,
        scanId
      },
      take: limit + 1,
      skip: options.cursor ? 1 : 0,
      cursor: options.cursor ? { id: options.cursor } : undefined,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
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
