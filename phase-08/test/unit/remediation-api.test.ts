import assert from "node:assert/strict";
import test from "node:test";
import type { Remediation } from "@prisma/client";
import type { AuthenticatedIdentity } from "../../../phase-06/src/auth/jwt-verifier.js";
import { hasPermission } from "../../../phase-06/src/rbac/guard.js";
import type { AuthenticatedRouteContext } from "../../../phase-06/src/api/server.js";
import {
  RemediationApiStore,
  RemediationApiRepository,
  RemediationApiError,
  CreateRemediationResult,
  RemediationPage
} from "../../src/api/remediation-api-repo.js";
import { RemediationApiRoutes } from "../../src/api/remediation-api.js";

function identity(role: "admin" | "operator" | "viewer" = "admin", tenantId = "tenant-a"): AuthenticatedIdentity {
  return { userId: `user-${role}`, tenantId, roles: [role], email: `${role}@test.invalid` };
}

function remediation(status = "pending"): Remediation {
  return {
    id: "remediation-1", tenantId: "tenant-a", organizationId: null, projectId: "project-1", scanId: "scan-1",
    findingId: "finding-1", idempotencyKey: "canonical", status, branchName: null, prNumber: null,
    requestedByIdentityUserId: null, repositoryBindingId: null, githubRepositoryId: null, planHash: null, planSnapshot: null,
    approvalState: null, approvedByIdentityUserId: null, approvedAt: null, rejectedByIdentityUserId: null, rejectedAt: null,
    invalidatedByIdentityUserId: null, invalidatedAt: null,
    executionArtifact: null, executionArtifactHash: null, approvedArtifactHash: null,
    prUrl: null, patchSummary: null, errorMessage: null, retriesLeft: 3, workerId: null,
    leaseToken: null, claimedAt: null, heartbeatAt: null, leaseExpiresAt: null, nextAttemptAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z")
  };
}

class FakeStore implements RemediationApiStore {
  calls: Array<{ method: string; args: unknown[] }> = [];
  result = remediation();
  createResult: CreateRemediationResult = { remediation: this.result, created: true };
  page: RemediationPage = { items: [this.result], hasMore: false };
  async createForFinding(...args: Parameters<RemediationApiStore["createForFinding"]>) {
    this.calls.push({ method: "create", args });
    return this.createResult;
  }
  async listByProject(...args: Parameters<RemediationApiStore["listByProject"]>) {
    this.calls.push({ method: "list", args });
    return this.page;
  }
  async getById(...args: Parameters<RemediationApiStore["getById"]>): Promise<Remediation | null> {
    this.calls.push({ method: "get", args });
    return this.result;
  }
  async retrigger(...args: Parameters<RemediationApiStore["retrigger"]>) {
    this.calls.push({ method: "retrigger", args });
    return this.result;
  }
}

function context(
  method: string,
  url: string,
  user = identity("admin"),
  body: unknown = {}
): { value: AuthenticatedRouteContext; response: { status?: number; data?: unknown } } {
  const response: { status?: number; data?: unknown } = {};
  const parsedUrl = new URL(url, "http://localhost");
  const value = {
    req: {} as AuthenticatedRouteContext["req"],
    res: {} as AuthenticatedRouteContext["res"],
    method,
    pathname: parsedUrl.pathname,
    url: parsedUrl,
    identity: user,
    parseJsonBody: async () => body,
    sendJson: (statusCode: number, data: unknown) => { response.status = statusCode; response.data = data; }
  };
  return { value, response };
}

test("remediation permissions follow admin/operator/viewer roles", () => {
  for (const role of ["admin", "operator"] as const) {
    assert.equal(hasPermission(identity(role), "remediation:create"), true);
    assert.equal(hasPermission(identity(role), "remediation:read"), true);
  }
  assert.equal(hasPermission(identity("viewer"), "remediation:create"), false);
  assert.equal(hasPermission(identity("viewer"), "remediation:read"), true);
});

test("create rejects viewers before touching the store", async () => {
  const store = new FakeStore();
  const routes = new RemediationApiRoutes(store, { triggerPoll() {} });
  const request = context("POST", "/api/v1/projects/project-1/remediations", identity("viewer"), { findingId: "finding-1" });
  assert.equal(await routes.handle(request.value), true);
  assert.equal(request.response.status, 403);
  assert.equal(store.calls.length, 0);
});

test("legacy creation is rejected without touching persistence or scheduling polling", async () => {
  const store = new FakeStore();
  let polls = 0;
  const routes = new RemediationApiRoutes(store, { triggerPoll() { polls++; } });
  for (const key of ["client-a", "client-b"]) {
    const request = context("POST", "/api/v1/projects/project-1/remediations", identity("operator"), {
      findingId: "finding-1", idempotencyKey: key
    });
    await routes.handle(request.value);
    assert.equal(request.response.status, 409);
    assert.match((request.response.data as { error: string }).error, /approve a remediation proposal/i);
  }
  assert.equal(store.calls.length, 0);
  assert.equal(polls, 0);
});

test("legacy create does not expose or schedule existing remediation statuses", async () => {
  for (const status of ["open", "merged"]) {
    const store = new FakeStore();
    store.createResult = { remediation: remediation(status), created: false };
    let polls = 0;
    const routes = new RemediationApiRoutes(store, { triggerPoll() { polls++; } });
    const request = context("POST", "/api/v1/projects/project-1/remediations", identity(), { findingId: "finding-1" });
    await routes.handle(request.value);
    assert.equal(request.response.status, 409);
    assert.equal(store.calls.length, 0);
    assert.equal(polls, 0);
  }
});

test("legacy create is rejected before inspecting failed or closed records", async () => {
  for (const status of ["failed", "closed"]) {
    const store = new FakeStore();
    store.createResult = { remediation: remediation(status), created: false };
    const routes = new RemediationApiRoutes(store, { triggerPoll() {} });
    const request = context("POST", "/api/v1/projects/project-1/remediations", identity(), { findingId: "finding-1" });
    await routes.handle(request.value);
    assert.equal(request.response.status, 409);
    assert.equal(store.calls.length, 0);
  }
});

test("list rejects invalid pagination and scopes valid pagination to tenant and project", async () => {
  const store = new FakeStore();
  const routes = new RemediationApiRoutes(store, { triggerPoll() {} });
  const bad = context("GET", "/api/v1/projects/project-1/remediations?limit=101", identity("viewer"));
  await routes.handle(bad.value);
  assert.equal(bad.response.status, 400);
  assert.equal(store.calls.length, 0);

  const good = context("GET", "/api/v1/projects/project-1/remediations?limit=10&cursor=cursor-1", identity("viewer"));
  await routes.handle(good.value);
  assert.equal(good.response.status, 200);
  assert.deepEqual(store.calls[0], {
    method: "list",
    args: ["tenant-a", "project-1", { limit: 10, cursor: "cursor-1" }]
  });
});

test("cross-tenant resource lookup returns 404", async () => {
  const store = new FakeStore();
  store.getById = async (tenantId, id) => {
    store.calls.push({ method: "get", args: [tenantId, id] });
    return null;
  };
  const routes = new RemediationApiRoutes(store, { triggerPoll() {} });
  const request = context("GET", "/api/v1/remediations/secret-id", identity("viewer", "tenant-b"));
  await routes.handle(request.value);
  assert.equal(request.response.status, 404);
  assert.deepEqual(store.calls[0].args, ["tenant-b", "secret-id"]);
});

test("legacy retrigger is rejected without resetting records or scheduling polling", async () => {
  const store = new FakeStore();
  store.result = remediation("failed");
  let polls = 0;
  const routes = new RemediationApiRoutes(store, { triggerPoll() { polls++; } });
  const request = context("POST", "/api/v1/remediations/remediation-1/retrigger", identity("operator"));
  await routes.handle(request.value);
  assert.equal(request.response.status, 409);
  assert.equal((request.response.data as { error: string }).error, "Legacy remediation retriggering is disabled. Create and approve a remediation proposal instead.");
  assert.equal(store.calls.length, 0);
  assert.equal(polls, 0);

  const viewer = context("POST", "/api/v1/remediations/remediation-1/retrigger", identity("viewer"));
  await routes.handle(viewer.value);
  assert.equal(viewer.response.status, 403);
  assert.equal(store.calls.length, 0);
  assert.equal(polls, 0);
});

test("legacy repository creation and retrigger methods fail before database access", async () => {
  let databaseCalls = 0;
  const prisma = new Proxy({}, { get() { databaseCalls++; throw new Error("unexpected database access"); } }) as never;
  const repository = new RemediationApiRepository(prisma);
  await assert.rejects(
    repository.createForFinding({ tenantId: "t", projectId: "p", findingId: "f", actorId: "u" }),
    (error: unknown) => error instanceof RemediationApiError && error.statusCode === 409
  );
  await assert.rejects(
    repository.retrigger("t", "r", "u"),
    (error: unknown) => error instanceof RemediationApiError && error.statusCode === 409
  );
  assert.equal(databaseCalls, 0);
});

test("legacy create does not call the repository even when it would reject the request", async () => {
  const store = new FakeStore();
  store.createForFinding = async () => { throw new RemediationApiError(422, "unsupported signal"); };
  const routes = new RemediationApiRoutes(store, { triggerPoll() {} });
  const request = context("POST", "/api/v1/projects/project-1/remediations", identity(), { findingId: "finding-1" });
  await routes.handle(request.value);
  assert.equal(request.response.status, 409);
  assert.equal(store.calls.length, 0);
});
