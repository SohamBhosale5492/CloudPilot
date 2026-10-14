import { PrismaClient, Project, Prisma } from "@prisma/client";

export class InvalidCursorError extends Error {
  readonly statusCode = 400;
  constructor(message = "Invalid pagination cursor.") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

export interface CreateProjectInput {
  name: string;
  repositoryUrl?: string;
  expectedModel?: unknown;
  targetConfig?: unknown;
}

export interface UpdateProjectInput {
  name?: string;
  repositoryUrl?: string;
  expectedModel?: unknown;
  targetConfig?: unknown;
}

export interface ListProjectsOptions {
  limit?: number;
  cursor?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
}

export class ProjectRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(tenantId: string, input: CreateProjectInput): Promise<Project> {
    return this.prisma.project.create({
      data: {
        tenantId,
        name: input.name,
        repositoryUrl: input.repositoryUrl ?? null,
        expectedModel: input.expectedModel as Prisma.InputJsonValue ?? Prisma.JsonNull,
        targetConfig: input.targetConfig as Prisma.InputJsonValue ?? Prisma.JsonNull
      }
    });
  }

  async findById(tenantId: string, projectId: string): Promise<Project | null> {
    return this.prisma.project.findFirst({
      where: {
        id: projectId,
        tenantId
      }
    });
  }

  async findByName(tenantId: string, name: string): Promise<Project | null> {
    return this.prisma.project.findUnique({
      where: {
        tenantId_name: {
          tenantId,
          name
        }
      }
    });
  }

  async list(tenantId: string, options: ListProjectsOptions = {}): Promise<PaginatedResult<Project>> {
    const rawLimit = options.limit !== undefined && Number.isFinite(options.limit) ? options.limit : 20;
    const limit = Math.min(Math.max(rawLimit, 1), 100);

    // If a cursor is supplied, verify it exists within this tenant
    // to prevent cross-tenant cursor traversal or invalid cursor crashes.
    if (options.cursor) {
      const cursorRecord = await this.prisma.project.findFirst({
        where: { id: options.cursor, tenantId }
      });
      if (!cursorRecord) {
        throw new InvalidCursorError(`Invalid cursor: project '${options.cursor}' not found in tenant.`);
      }
    }

    // Deterministic ordering: primary sort by createdAt desc, tie-breaker by id desc.
    // skip: 1 skips the cursor item itself so next page begins with the next record.
    const items = await this.prisma.project.findMany({
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

  async update(tenantId: string, projectId: string, input: UpdateProjectInput): Promise<Project | null> {
    const existing = await this.findById(tenantId, projectId);
    if (!existing) {
      return null;
    }

    return this.prisma.project.update({
      where: { id: projectId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.repositoryUrl !== undefined ? { repositoryUrl: input.repositoryUrl } : {}),
        ...(input.expectedModel !== undefined
          ? { expectedModel: input.expectedModel as Prisma.InputJsonValue ?? Prisma.JsonNull }
          : {}),
        ...(input.targetConfig !== undefined
          ? { targetConfig: input.targetConfig as Prisma.InputJsonValue ?? Prisma.JsonNull }
          : {})
      }
    });
  }

  async delete(tenantId: string, projectId: string): Promise<boolean> {
    const existing = await this.findById(tenantId, projectId);
    if (!existing) {
      return false;
    }

    await this.prisma.project.delete({
      where: { id: projectId }
    });
    return true;
  }
}
