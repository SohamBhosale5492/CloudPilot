import assert from "node:assert/strict";
import test from "node:test";
import type { AuthenticatedIdentity } from "../../../phase-06/src/auth/jwt-verifier.js";
import type { AuthenticatedRouteContext } from "../../../phase-06/src/api/server.js";
import { RemediationProposalApiRoutes } from "../../src/api/remediation-proposal-api.js";
import type { RemediationProposalStore } from "../../src/api/remediation-proposal-repo.js";

const issuer = "https://issuer.example.test/tenant/v2.0";
function identity(role: "admin" | "operator" | "viewer" = "operator"): AuthenticatedIdentity {
  return { userId: "verified-subject", tenantId: "verified-tenant", roles: [role] };
}
function context(method: string, url: string, user = identity(), body: unknown = { findingId: "22222222-2222-4222-8222-222222222222" }) {
  const response: { status?: number; body?: unknown } = {};
  const parsed = new URL(url, "http://localhost");
  const value = {
    req: {} as AuthenticatedRouteContext["req"], res: {} as AuthenticatedRouteContext["res"], method,
    pathname: parsed.pathname, url: parsed, identity: user,
    parseJsonBody: async () => body,
    sendJson: (status: number, data: unknown) => { response.status = status; response.body = data; }
  } as AuthenticatedRouteContext;
  return { value, response };
}

class ProposalStore implements RemediationProposalStore {
  calls: Array<{ method: string; input: unknown }> = [];
  async create(input: Parameters<RemediationProposalStore["create"]>[0]) {
    this.calls.push({ method: "create", input });
    return { replayed: false, proposal: { id: "proposal-1", approvalState: "pending", status: "pending_approval", planHash: "a".repeat(64) } };
  }
  async listByProject(input: Parameters<RemediationProposalStore["listByProject"]>[0]) {
    this.calls.push({ method: "listByProject", input });
    return {
      items: [{ id: "proposal-1", projectId: input.projectId, findingId: "22222222-2222-4222-8222-222222222222", approvalState: "pending", status: "pending_approval", planHash: "a".repeat(64), createdAt: "2026-01-01T00:00:00.000Z" }],
      hasMore: false
    };
  }
  async read(input: Parameters<RemediationProposalStore["read"]>[0]) {
    this.calls.push({ method: "read", input });
    return { id: input.remediationId, approvalState: "pending", planHash: "a".repeat(64) };
  }
  async decide(input: Parameters<RemediationProposalStore["decide"]>[0]): ReturnType<RemediationProposalStore["decide"]> {
    this.calls.push({ method: input.decision, input });
    return { kind: "decided" as const, approvalState: input.decision === "approve" ? "approved" as const : "rejected" as const, status: input.decision === "approve" ? "pending" : "pending_approval" };
  }
}

test("proposal creation resolves the verified issuer/subject to a local requester and requires legacy create permission", async () => {
  const store = new ProposalStore();
  const identityCalls: unknown[] = [];
  const identities = { async resolve(principal: unknown, provisioning: boolean) { identityCalls.push([principal, provisioning]); return { id: "local-user" }; } };
  const routes = new RemediationProposalApiRoutes(identities as never, store, { expectedIssuer: issuer });
  const request = context("POST", "/api/v1/projects/11111111-1111-4111-8111-111111111111/remediation-proposals");
  assert.equal(await routes.handle(request.value), true);
  assert.equal(request.response.status, 202);
  assert.deepEqual(identityCalls, [[{ issuer, subject: "verified-subject" }, false]]);
  assert.deepEqual(store.calls[0], {
    method: "create",
    input: {
      tenantId: "verified-tenant", projectId: "11111111-1111-4111-8111-111111111111",
      findingId: "22222222-2222-4222-8222-222222222222", requesterIdentityUserId: "local-user", actorSubject: "verified-subject"
    }
  });
  const viewer = context("POST", "/api/v1/projects/11111111-1111-4111-8111-111111111111/remediation-proposals", identity("viewer"));
  assert.equal(await routes.handle(viewer.value), true);
  assert.equal(viewer.response.status, 403);
  assert.equal(store.calls.length, 1);
});

test("review, approve and reject use tenant from verified context and do not invoke external execution", async () => {
  const store = new ProposalStore();
  let resolves = 0;
  const identities = { async resolve() { resolves++; return { id: "local-approver" }; } };
  const routes = new RemediationProposalApiRoutes(identities as never, store, { expectedIssuer: issuer });
  const review = context("GET", "/api/v1/remediation-proposals/77777777-7777-4777-8777-777777777777", identity("viewer"));
  assert.equal(await routes.handle(review.value), true);
  assert.equal(review.response.status, 200);
  const approve = context("POST", "/api/v1/remediation-proposals/77777777-7777-4777-8777-777777777777/approve", identity("viewer"), {});
  assert.equal(await routes.handle(approve.value), true);
  assert.equal(approve.response.status, 200);
  const reject = context("POST", "/api/v1/remediation-proposals/77777777-7777-4777-8777-777777777777/reject", identity("admin"), {});
  assert.equal(await routes.handle(reject.value), true);
  assert.equal(reject.response.status, 200);
  assert.equal(resolves, 3);
  assert.deepEqual(store.calls.map((call) => call.method), ["read", "approve", "reject"]);
  assert.ok(store.calls.every((call) => (call.input as { tenantId: string }).tenantId === "verified-tenant"));
});

test("proposal API surfaces stale plan/binding conflicts as 409", async () => {
  const store = new ProposalStore();
  store.decide = async () => ({ kind: "conflict", approvalState: "invalidated", message: "The proposal changed." });
  const routes = new RemediationProposalApiRoutes({ async resolve() { return { id: "local-user" }; } } as never, store, { expectedIssuer: issuer });
  const request = context("POST", "/api/v1/remediation-proposals/77777777-7777-4777-8777-777777777777/approve", identity("viewer"), {});
  await routes.handle(request.value);
  assert.equal(request.response.status, 409);
  assert.deepEqual(request.response.body, { error: "The proposal changed.", approvalState: "invalidated" });
});

test("artifact preparation route accepts persisted proposal identity only and requires create permission", async () => {
  const store = new ProposalStore();
  const prepared: unknown[] = [];
  const preparation = { async prepare(input: unknown) { prepared.push(input); return { artifactHash: "b".repeat(64), replayed: false }; } };
  const identities = { async resolve() { return { id: "local-user" }; } };
  const routes = new RemediationProposalApiRoutes(identities as never, store, { expectedIssuer: issuer }, preparation as never);
  const proposalId = "77777777-7777-4777-8777-777777777777";
  const request = context("POST", `/api/v1/remediation-proposals/${proposalId}/prepare-artifact`, identity("operator"), {});
  assert.equal(await routes.handle(request.value), true);
  assert.equal(request.response.status, 200);
  assert.deepEqual(request.response.body, { artifactHash: "b".repeat(64), replayed: false });
  assert.deepEqual(prepared, [{ tenantId: "verified-tenant", remediationId: proposalId,
    identity: { issuer, subject: "verified-subject" } }]);

  const viewer = context("POST", `/api/v1/remediation-proposals/${proposalId}/prepare-artifact`, identity("viewer"), {});
  assert.equal(await routes.handle(viewer.value), true);
  assert.equal(viewer.response.status, 403);
  assert.equal(prepared.length, 1);
});


test("project proposal list route enforces remediation:read, validates params, and preserves tenant isolation", async () => {
  const store = new ProposalStore();
  let resolves = 0;
  const identities = { async resolve() { resolves++; return { id: "local-reader" }; } };
  const routes = new RemediationProposalApiRoutes(identities as never, store, { expectedIssuer: issuer });
  const projectId = "11111111-1111-4111-8111-111111111111";
  const cursorId = "77777777-7777-4777-8777-777777777777";

  const allowed = context("GET", `/api/v1/projects/${projectId}/remediation-proposals?limit=10&cursor=${cursorId}`, identity("viewer"));
  assert.equal(await routes.handle(allowed.value), true);
  assert.equal(allowed.response.status, 200);
  assert.equal((allowed.response.body as { items: Array<{ status: string }> }).items[0]?.status, "pending_approval");
  assert.equal(resolves, 1);
  assert.deepEqual(store.calls[0], {
    method: "listByProject",
    input: { tenantId: "verified-tenant", projectId, identityUserId: "local-reader", limit: 10, cursor: cursorId }
  });

  const denied = context("GET", `/api/v1/projects/${projectId}/remediation-proposals`, { userId: "verified-subject", tenantId: "verified-tenant", roles: [] });
  assert.equal(await routes.handle(denied.value), true);
  assert.equal(denied.response.status, 403);

  const badProject = context("GET", "/api/v1/projects/not-a-uuid/remediation-proposals", identity("viewer"));
  assert.equal(await routes.handle(badProject.value), true);
  assert.equal(badProject.response.status, 400);

  const badCursor = context("GET", `/api/v1/projects/${projectId}/remediation-proposals?cursor=not-a-uuid`, identity("viewer"));
  assert.equal(await routes.handle(badCursor.value), true);
  assert.equal(badCursor.response.status, 400);

  const badLimit = context("GET", `/api/v1/projects/${projectId}/remediation-proposals?limit=500`, identity("viewer"));
  assert.equal(await routes.handle(badLimit.value), true);
  assert.equal(badLimit.response.status, 400);

  assert.equal(store.calls.length, 1);
});
