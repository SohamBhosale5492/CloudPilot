import { PrismaClient, Remediation } from "@prisma/client";

export class RemediationApiError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "RemediationApiError";
  }
}

export interface CreateRemediationInput {
  tenantId: string;
  projectId: string;
  findingId: string;
  actorId: string;
}

export interface CreateRemediationResult {
  remediation: Remediation;
  created: boolean;
}

export interface RemediationListOptions {
  limit: number;
  cursor?: string;
}

export interface RemediationPage {
  items: Remediation[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface RemediationApiStore {
  createForFinding(input: CreateRemediationInput): Promise<CreateRemediationResult>;
  listByProject(tenantId: string, projectId: string, options: RemediationListOptions): Promise<RemediationPage>;
  getById(tenantId: string, remediationId: string): Promise<Remediation | null>;
  retrigger(tenantId: string, remediationId: string, actorId: string): Promise<Remediation | null>;
}

export class RemediationApiRepository implements RemediationApiStore {
  constructor(private readonly prisma: PrismaClient) {}

  async createForFinding(_input: CreateRemediationInput): Promise<CreateRemediationResult> {
    throw new RemediationApiError(409, "Legacy remediation creation is disabled; an approved proposal is required.");
  }
  async listByProject(
    tenantId: string,
    projectId: string,
    options: RemediationListOptions
  ): Promise<RemediationPage> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId },
      select: { id: true }
    });
    if (!project) throw new RemediationApiError(404, "Project not found.");

    if (options.cursor) {
      const cursorRecord = await this.prisma.remediation.findFirst({
        where: { id: options.cursor, tenantId, projectId },
        select: { id: true }
      });
      if (!cursorRecord) throw new RemediationApiError(400, "Invalid remediation cursor.");
    }

    const records = await this.prisma.remediation.findMany({
      where: { tenantId, projectId },
      take: options.limit + 1,
      skip: options.cursor ? 1 : 0,
      cursor: options.cursor ? { id: options.cursor } : undefined,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }]
    });
    const hasMore = records.length > options.limit;
    const items = hasMore ? records.slice(0, options.limit) : records;
    return { items, hasMore, nextCursor: hasMore ? items[items.length - 1]?.id : undefined };
  }

  getById(tenantId: string, remediationId: string): Promise<Remediation | null> {
    return this.prisma.remediation.findFirst({ where: { id: remediationId, tenantId } });
  }

  async retrigger(_tenantId: string, _remediationId: string, _actorId: string): Promise<Remediation | null> {
    throw new RemediationApiError(409, "Legacy remediation retriggering is disabled; an approved proposal is required.");
  }
}
