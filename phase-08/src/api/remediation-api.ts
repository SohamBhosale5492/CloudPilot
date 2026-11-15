import type { Remediation } from "@prisma/client";
import type {
  AuthenticatedRouteContext,
  AuthenticatedRouteExtension
} from "../../../phase-06/src/api/server.js";
import { hasPermission } from "../../../phase-06/src/rbac/guard.js";
import {
  RemediationApiError,
  RemediationApiStore
} from "./remediation-api-repo.js";

export interface RemediationWorkScheduler {
  triggerPoll(): void;
  initialize?(): Promise<void>;
  shutdown?(): Promise<void>;
}

function publicRecord(record: Remediation) {
  return {
    id: record.id,
    projectId: record.projectId,
    scanId: record.scanId,
    findingId: record.findingId,
    status: record.status,
    prDeliveryStatus: record.status === "merged" ? "pr_merged"
      : record.status === "closed" ? "pr_closed"
        : record.status === "open" ? "draft_pr_created"
          : record.status === "failed" ? "failed"
            : record.status === "running" ? "in_progress"
              : "not_started",
    branchName: record.branchName,
    prNumber: record.prNumber,
    prUrl: record.prUrl,
    patchSummary: record.patchSummary,
    errorMessage: record.errorMessage,
    retriesLeft: record.retriesLeft,
    nextAttemptAt: record.nextAttemptAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function decodePathPart(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && decoded.length <= 128 ? decoded : null;
  } catch {
    return null;
  }
}

function readPageOptions(context: AuthenticatedRouteContext): { limit: number; cursor?: string } | null {
  const limits = context.url.searchParams.getAll("limit");
  const cursors = context.url.searchParams.getAll("cursor");
  if (limits.length > 1 || cursors.length > 1) return null;

  let limit = 20;
  if (limits.length === 1) {
    if (!/^(?:[1-9]\d*)$/.test(limits[0])) return null;
    limit = Number(limits[0]);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return null;
  }

  let cursor: string | undefined;
  if (cursors.length === 1) {
    cursor = cursors[0];
    if (!cursor || cursor.length > 128) return null;
  }
  return { limit, ...(cursor ? { cursor } : {}) };
}

function sendProblem(context: AuthenticatedRouteContext, error: unknown): void {
  if (error instanceof RemediationApiError) {
    context.sendJson(error.statusCode, { error: error.message });
    return;
  }
  throw error;
}

/** Authenticated Phase 08 routes mounted by CloudPilotApiServer. */
export class RemediationApiRoutes implements AuthenticatedRouteExtension {
  constructor(
    private readonly store: RemediationApiStore,
    private readonly scheduler: RemediationWorkScheduler
  ) {}

  async initialize(): Promise<void> {
    await this.scheduler.initialize?.();
  }

  async shutdown(): Promise<void> {
    await this.scheduler.shutdown?.();
  }

  async handle(context: AuthenticatedRouteContext): Promise<boolean> {
    const projectMatch = context.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/remediations$/);
    if (projectMatch && (context.method === "POST" || context.method === "GET")) {
      const projectId = decodePathPart(projectMatch[1]);
      if (!projectId) {
        context.sendJson(400, { error: "Invalid project ID." });
        return true;
      }
      if (context.method === "POST") return this.create(context, projectId);
      return this.list(context, projectId);
    }

    const resourceMatch = context.pathname.match(/^\/api\/v1\/remediations\/([^/]+)(\/retrigger)?$/);
    if (resourceMatch && (context.method === "GET" || (context.method === "POST" && resourceMatch[2]))) {
      const remediationId = decodePathPart(resourceMatch[1]);
      if (!remediationId) {
        context.sendJson(404, { error: "Remediation not found." });
        return true;
      }
      if (context.method === "GET" && !resourceMatch[2]) return this.get(context, remediationId);
      if (context.method === "POST" && resourceMatch[2]) return this.retrigger(context, remediationId);
    }

    return false;
  }

  private async create(context: AuthenticatedRouteContext, _projectId: string): Promise<boolean> {
    if (!hasPermission(context.identity, "remediation:create")) {
      context.sendJson(403, { error: "Forbidden: insufficient permissions." });
      return true;
    }

    // This legacy endpoint creates jobs without a persisted, approved proposal
    // and immutable execution artifact. Never let it enqueue runnable work.
    context.sendJson(409, {
      error: "Legacy remediation creation is disabled. Create and approve a remediation proposal instead."
    });
    return true;
  }

  private async list(context: AuthenticatedRouteContext, projectId: string): Promise<boolean> {
    if (!hasPermission(context.identity, "remediation:read")) {
      context.sendJson(403, { error: "Forbidden: insufficient permissions." });
      return true;
    }
    const options = readPageOptions(context);
    if (!options) {
      context.sendJson(400, { error: "Invalid limit or cursor." });
      return true;
    }
    try {
      const page = await this.store.listByProject(context.identity.tenantId, projectId, options);
      context.sendJson(200, {
        items: page.items.map(publicRecord),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore
      });
    } catch (error) {
      sendProblem(context, error);
    }
    return true;
  }

  private async get(context: AuthenticatedRouteContext, remediationId: string): Promise<boolean> {
    if (!hasPermission(context.identity, "remediation:read")) {
      context.sendJson(403, { error: "Forbidden: insufficient permissions." });
      return true;
    }
    const remediation = await this.store.getById(context.identity.tenantId, remediationId);
    if (!remediation) {
      context.sendJson(404, { error: "Remediation not found." });
      return true;
    }
    context.sendJson(200, { remediation: publicRecord(remediation) });
    return true;
  }

  private async retrigger(context: AuthenticatedRouteContext, _remediationId: string): Promise<boolean> {
    if (!hasPermission(context.identity, "remediation:create")) {
      context.sendJson(403, { error: "Forbidden: insufficient permissions." });
      return true;
    }
    context.sendJson(409, {
      error: "Legacy remediation retriggering is disabled. Create and approve a remediation proposal instead."
    });
    return true;
  }
}
