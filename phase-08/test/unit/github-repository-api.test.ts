import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import type { AuthenticatedIdentity } from "../../../phase-06/src/auth/jwt-verifier.js";
import type { AuthenticatedRouteContext } from "../../../phase-06/src/api/server.js";
import {
  GitHubRepositoryApiRoutes,
  parseGitHubRepositoryReference,
  PrismaGitHubRepositoryStore,
  type GitHubRepositoryStore
} from "../../src/api/github-repository-api.js";

const repository = { owner: "example", name: "service", url: "https://github.com/example/service" };
function identity(role: "admin" | "operator" | "viewer" = "admin", tenantId = "tenant-a"): AuthenticatedIdentity {
  return { userId: "entra-subject-1", tenantId, roles: [role] };
}
function request(method: string, url: string, user = identity(), body: unknown = {}) {
  const parsed = new URL(url, "http://localhost");
  const response: { status?: number; body?: unknown } = {};
  const context = {
    req: {} as AuthenticatedRouteContext["req"], res: {} as AuthenticatedRouteContext["res"],
    method, pathname: parsed.pathname, url: parsed, identity: user,
    parseJsonBody: async () => body,
    sendJson: (status: number, value: unknown) => { response.status = status; response.body = value; }
  } satisfies AuthenticatedRouteContext;
  return { context, response };
}
class FakeStore implements GitHubRepositoryStore {
  calls: unknown[][] = [];
  result: "saved" | "unchanged" | "not_found" | "conflict" = "saved";
  async setRepository(...args: Parameters<GitHubRepositoryStore["setRepository"]>) { this.calls.push(args); return this.result; }
  async disconnectRepository(...args: Parameters<GitHubRepositoryStore["disconnectRepository"]>) { this.calls.push(args); return this.result; }
}

test("repository URL validation accepts a canonical GitHub repository and rejects unsafe or credential-bearing URLs", () => {
  assert.deepEqual(parseGitHubRepositoryReference("https://github.com/example/service.git"), repository);
  for (const invalid of [
    "http://github.com/example/service", "https://github.com.evil.test/example/service",
    "https://user:secret@github.com/example/service", "https://github.com/example/service?token=secret",
    "https://github.com/example/service/tree/main", "https://github.com/example/../service", "not a URL"
  ]) assert.equal(parseGitHubRepositoryReference(invalid), null, invalid);
});

test("admin can configure a tenant-scoped reference and response contains no credentials or verification claim", async () => {
  const store = new FakeStore(); const routes = new GitHubRepositoryApiRoutes(store);
  const req = request("PUT", "/api/v1/projects/p1/github-repository", identity("admin"), { repositoryUrl: repository.url });
  assert.equal(await routes.handle(req.context), true);
  assert.deepEqual(store.calls[0], ["tenant-a", "p1", "entra-subject-1", repository]);
  assert.deepEqual(req.response.body, {
    projectId: "p1", configured: true, changed: true,
    repository: { owner: "example", name: "service", url: repository.url, verified: false }
  });
});

test("existing project:update RBAC is enforced and foreign tenant projects are non-enumerating", async () => {
  const store = new FakeStore(); const routes = new GitHubRepositoryApiRoutes(store);
  const operator = request("PUT", "/api/v1/projects/p1/github-repository", identity("operator"), { repositoryUrl: repository.url });
  await routes.handle(operator.context);
  assert.equal(operator.response.status, 403);
  assert.equal(store.calls.length, 0);

  store.result = "not_found";
  const foreign = request("DELETE", "/api/v1/projects/p1/github-repository", identity("admin", "tenant-b"));
  await routes.handle(foreign.context);
  assert.equal(foreign.response.status, 404);
  assert.deepEqual(store.calls[0]?.slice(0, 2), ["tenant-b", "p1"]);
  assert.doesNotMatch(JSON.stringify(foreign.response.body), /tenant-a|secret/i);
});

test("invalid body and repository URLs are rejected without echoing submitted secret material", async () => {
  const store = new FakeStore(); const routes = new GitHubRepositoryApiRoutes(store);
  const url = "https://user:secret@github.com/example/service";
  const invalid = request("PUT", "/api/v1/projects/p1/github-repository", identity(), { repositoryUrl: url });
  await routes.handle(invalid.context);
  assert.equal(invalid.response.status, 400);
  assert.doesNotMatch(JSON.stringify(invalid.response.body), /secret|user/i);
  const extra = request("PUT", "/api/v1/projects/p1/github-repository", identity(), { repositoryUrl: repository.url, token: "secret" });
  await routes.handle(extra.context);
  assert.equal(extra.response.status, 400);
  assert.equal(store.calls.length, 0);
});

test("disconnect is auditable through the store and concurrent updates return a safe conflict", async () => {
  const store = new FakeStore(); const routes = new GitHubRepositoryApiRoutes(store);
  const disconnected = request("DELETE", "/api/v1/projects/p1/github-repository");
  await routes.handle(disconnected.context);
  assert.equal(disconnected.response.status, 200);
  assert.deepEqual(disconnected.response.body, { projectId: "p1", configured: false, changed: true, repository: null });
  store.result = "conflict";
  const conflict = request("PUT", "/api/v1/projects/p1/github-repository", identity(), { repositoryUrl: repository.url });
  await routes.handle(conflict.context);
  assert.equal(conflict.response.status, 409);
  assert.doesNotMatch(JSON.stringify(conflict.response.body), /github\.com|token/i);
});

test("Prisma store updates only the tenant-owned project and appends audit atomically", async () => {
  const events: unknown[] = [];
  let storedUrl: string | null = null;
  const tx = {
    project: {
      async findFirst(args: unknown) {
        assert.deepEqual(args, { where: { id: "p1", tenantId: "tenant-a" }, select: { id: true, repositoryUrl: true } });
        return { id: "p1", repositoryUrl: storedUrl };
      },
      async updateMany(args: { where: { repositoryUrl: string | null; tenantId: string; id: string }; data: { repositoryUrl: string } }) {
        assert.deepEqual(args.where, { id: "p1", tenantId: "tenant-a", repositoryUrl: storedUrl });
        storedUrl = args.data.repositoryUrl;
        return { count: 1 };
      }
    },
    auditEvent: { async create(args: unknown) { events.push(args); } }
  };
  const prisma = { $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx) } as unknown as PrismaClient;
  const result = await new PrismaGitHubRepositoryStore(prisma).setRepository("tenant-a", "p1", "actor", repository);
  assert.equal(result, "saved");
  assert.equal(storedUrl, repository.url);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { data: {
    tenantId: "tenant-a", actorId: "actor", action: "PROJECT_GITHUB_REPOSITORY_CONFIGURED", resourceType: "project",
    resourceId: "p1", projectId: "p1", metadataJson: { owner: "example", repository: "service", verified: false }
  } });
  assert.doesNotMatch(JSON.stringify(events), /token|secret|password/i);
});

test("audit failure rejects repository update transaction instead of reporting success", async () => {
  let transactionCommitted = false;
  const tx = {
    project: {
      async findFirst() { return { id: "p1", repositoryUrl: null }; },
      async updateMany() { return { count: 1 }; }
    },
    auditEvent: { async create() { throw new Error("audit unavailable"); } }
  };
  const prisma = { $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => {
    try { const result = await callback(tx); transactionCommitted = true; return result; }
    catch (error) { throw error; }
  } } as unknown as PrismaClient;
  await assert.rejects(new PrismaGitHubRepositoryStore(prisma).setRepository("tenant-a", "p1", "actor", repository), /audit unavailable/);
  assert.equal(transactionCommitted, false);
});
