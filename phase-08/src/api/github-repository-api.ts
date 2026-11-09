import { Prisma, PrismaClient } from "@prisma/client";
import type { AuthenticatedRouteContext, AuthenticatedRouteExtension } from "../../../phase-06/src/api/server.js";
import { hasPermission } from "../../../phase-06/src/rbac/guard.js";

export interface GitHubRepositoryReference {
  owner: string;
  name: string;
  url: string;
}

export type RepositoryChangeResult = "saved" | "unchanged" | "not_found" | "conflict";

export interface GitHubRepositoryStore {
  setRepository(tenantId: string, projectId: string, actorId: string, repository: GitHubRepositoryReference): Promise<RepositoryChangeResult>;
  disconnectRepository(tenantId: string, projectId: string, actorId: string): Promise<RepositoryChangeResult>;
}

export function parseGitHubRepositoryReference(value: unknown): GitHubRepositoryReference | null {
  if (typeof value !== "string" || value.length > 512 || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port ||
        url.username || url.password || url.search || url.hash) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return null;
    const owner = parts[0];
    const name = parts[1].endsWith(".git") ? parts[1].slice(0, -4) : parts[1];
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(name) || name === "." || name === "..") return null;
    return { owner, name, url: `https://github.com/${owner}/${name}` };
  } catch {
    return null;
  }
}

/** Stores only a validated repository reference. It never verifies access or stores credentials. */
export class PrismaGitHubRepositoryStore implements GitHubRepositoryStore {
  constructor(private readonly prisma: PrismaClient) {}

  async setRepository(tenantId: string, projectId: string, actorId: string, repository: GitHubRepositoryReference): Promise<RepositoryChangeResult> {
    return this.prisma.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: projectId, tenantId }, select: { id: true, repositoryUrl: true }
      });
      if (!project) return "not_found";
      if (project.repositoryUrl === repository.url) return "unchanged";
      const result = await tx.project.updateMany({
        where: { id: projectId, tenantId, repositoryUrl: project.repositoryUrl },
        data: { repositoryUrl: repository.url }
      });
      if (result.count !== 1) return "conflict";
      await tx.auditEvent.create({ data: {
        tenantId, actorId, action: "PROJECT_GITHUB_REPOSITORY_CONFIGURED", resourceType: "project",
        resourceId: projectId, projectId,
        metadataJson: { owner: repository.owner, repository: repository.name, verified: false } as Prisma.InputJsonValue
      } });
      return "saved";
    });
  }

  async disconnectRepository(tenantId: string, projectId: string, actorId: string): Promise<RepositoryChangeResult> {
    return this.prisma.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: projectId, tenantId }, select: { id: true, repositoryUrl: true }
      });
      if (!project) return "not_found";
      if (project.repositoryUrl === null) return "unchanged";
      const result = await tx.project.updateMany({
        where: { id: projectId, tenantId, repositoryUrl: project.repositoryUrl },
        data: { repositoryUrl: null }
      });
      if (result.count !== 1) return "conflict";
      await tx.auditEvent.create({ data: {
        tenantId, actorId, action: "PROJECT_GITHUB_REPOSITORY_DISCONNECTED", resourceType: "project",
        resourceId: projectId, projectId, metadataJson: { verified: false }
      } });
      return "saved";
    });
  }
}

function decodeProjectId(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && decoded.length <= 128 && !decoded.includes("/") ? decoded : null;
  } catch { return null; }
}

/** Authenticated project-scoped setup for non-secret GitHub repository metadata. */
export class GitHubRepositoryApiRoutes implements AuthenticatedRouteExtension {
  constructor(private readonly store: GitHubRepositoryStore) {}

  async handle(context: AuthenticatedRouteContext): Promise<boolean> {
    const match = context.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/github-repository$/);
    if (!match || (context.method !== "PUT" && context.method !== "DELETE")) return false;
    const projectId = decodeProjectId(match[1]);
    if (!projectId) {
      context.sendJson(400, { error: "Invalid project ID." });
      return true;
    }
    if (!hasPermission(context.identity, "project:update")) {
      context.sendJson(403, { error: "Forbidden: insufficient permissions." });
      return true;
    }

    if (context.method === "PUT") {
      let body: unknown;
      try { body = await context.parseJsonBody(); }
      catch { context.sendJson(400, { error: "Invalid JSON request body." }); return true; }
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).length !== 1 || !Object.hasOwn(body, "repositoryUrl")) {
        context.sendJson(400, { error: "Request body must contain only repositoryUrl." });
        return true;
      }
      const repository = parseGitHubRepositoryReference((body as Record<string, unknown>).repositoryUrl);
      if (!repository) {
        context.sendJson(400, { error: "Enter a valid HTTPS GitHub repository URL without credentials, query, or fragment." });
        return true;
      }
      const result = await this.store.setRepository(context.identity.tenantId, projectId, context.identity.userId, repository);
      this.respond(context, projectId, result, repository);
      return true;
    }

    const result = await this.store.disconnectRepository(context.identity.tenantId, projectId, context.identity.userId);
    this.respond(context, projectId, result, null);
    return true;
  }

  private respond(context: AuthenticatedRouteContext, projectId: string, result: RepositoryChangeResult, repository: GitHubRepositoryReference | null): void {
    if (result === "not_found") { context.sendJson(404, { error: "Project not found." }); return; }
    if (result === "conflict") { context.sendJson(409, { error: "Project repository changed concurrently. Reload and try again." }); return; }
    context.sendJson(200, {
      projectId,
      configured: repository !== null,
      changed: result === "saved",
      repository: repository ? { owner: repository.owner, name: repository.name, url: repository.url, verified: false } : null
    });
  }
}
