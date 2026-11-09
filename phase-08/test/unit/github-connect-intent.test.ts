import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { CloudPilotApiServer } from "../../../phase-06/src/api/server.js";
import type { AuthenticatedRouteContext } from "../../../phase-06/src/api/server.js";
import { TEST_AUDIENCE, TEST_ISSUER, TEST_PUBLIC_KEY } from "../../../phase-06/test/jwt-signer.js";
import { GitHubConnectIntentApiRoutes } from "../../src/api/github-connect-intent-api.js";
import {
  GitHubConnectIntentService,
  PrismaGitHubConnectIntentStore,
  type GitHubConnectIntentRecord,
  type GitHubConnectIntentStore
} from "../../src/github/connect-intent.js";
import type { IdentityResolver } from "../../src/identity/identity-resolver.js";
import { IdentityResolutionError } from "../../src/identity/identity-resolver.js";
import { hasOrganizationPermission } from "../../src/organizations/permissions.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const identityUserId = "22222222-2222-4222-8222-222222222222";
const subject = "verified-subject";
const issuer = "https://issuer.example/tenant/v2.0";
const nowMs = Date.parse("2026-11-05T12:00:00.000Z");
const entropy = Buffer.alloc(32, 0xab);
const expectedState = entropy.toString("base64url");

function context(overrides: Partial<AuthenticatedRouteContext> = {}): AuthenticatedRouteContext {
  return {
    req: { headers: {} } as never,
    res: {} as never,
    method: "POST",
    pathname: `/api/v1/organizations/${organizationId}/github/installations/start`,
    url: new URL(`http://localhost/api/v1/organizations/${organizationId}/github/installations/start`),
    identity: { userId: subject, tenantId: "verified-tenant", roles: ["viewer"] },
    async parseJsonBody() { return {}; },
    sendJson(statusCode, data) { response.statusCode = statusCode; response.body = data; },
    ...overrides
  } as AuthenticatedRouteContext;
}

const response: { statusCode?: number; body?: unknown } = {};

function routeHarness(role: string | null, store: GitHubConnectIntentStore, options: { slug?: string; missingSlug?: boolean } = {}) {
  const identities: unknown[] = [];
  const authorizationCalls: unknown[] = [];
  let identityError: unknown;
  const identityResolver = {
    async resolve(principal: unknown, allowProvisioning: boolean) {
      identities.push([principal, allowProvisioning]);
      if (identityError) throw identityError;
      return { id: identityUserId, status: "active" };
    }
  } as unknown as IdentityResolver;
  const authorization = {
    async authorize(...args: unknown[]) {
      authorizationCalls.push(args);
      return role && hasOrganizationPermission(role, "organization:integrations:manage")
        ? { role, permission: "organization:integrations:manage" }
        : null;
    }
  } as never;
  const service = new GitHubConnectIntentService(store, {
    appSlug: options.missingSlug ? undefined : (options.slug ?? "cloudpilot-demo"),
    now: () => nowMs,
    randomBytes: (size) => { assert.equal(size, 32); return entropy; }
  });
  const routes = new GitHubConnectIntentApiRoutes(identityResolver, authorization, service, {
    expectedIssuer: issuer,
    allowFirstUseProvisioning: false
  });
  return { routes, identities, authorizationCalls, setIdentityError(error: unknown) { identityError = error; } };
}

function memoryStore(records: GitHubConnectIntentRecord[] = []): GitHubConnectIntentStore {
  return {
    async create(record) {
      records.push(record);
      return { id: "33333333-3333-4333-8333-333333333333" };
    }
  };
}

test("owners and admins can create a persisted connect intent using the verified local identity", async () => {
  for (const role of ["owner", "admin"]) {
    response.statusCode = undefined;
    response.body = undefined;
    const records: GitHubConnectIntentRecord[] = [];
    const harness = routeHarness(role, memoryStore(records));
    assert.equal(await harness.routes.handle(context()), true);
    assert.equal(response.statusCode, 201);
    assert.deepEqual(harness.identities, [[{ issuer, subject }, false]]);
    assert.deepEqual(harness.authorizationCalls, [[identityUserId, organizationId, "organization:integrations:manage"]]);
    const record = records[0];
    assert.equal(record.organizationId, organizationId);
    assert.equal(record.identityUserId, identityUserId);
    assert.equal(record.stateHash, createHash("sha256").update(expectedState, "utf8").digest("hex"));
    assert.notEqual(record.stateHash, expectedState);
    assert.equal(record.createdAt.toISOString(), "2026-11-05T12:00:00.000Z");
    assert.equal(record.expiresAt.toISOString(), "2026-11-05T12:10:00.000Z");
    assert.deepEqual(response.body, {
      intentId: "33333333-3333-4333-8333-333333333333",
      state: expectedState,
      installationUrl: `https://github.com/apps/cloudpilot-demo/installations/new?state=${expectedState}`,
      expiresAt: "2026-11-05T12:10:00.000Z"
    });
    assert.match(expectedState, /^[A-Za-z0-9_-]+$/);
    assert.equal(Buffer.from(expectedState, "base64url").byteLength, 32);
  }
});

test("operators, viewers, and users without active membership cannot start installation", async () => {
  for (const role of ["operator", "viewer", null]) {
    response.statusCode = undefined;
    let creates = 0;
    const store: GitHubConnectIntentStore = { async create() { creates += 1; return { id: "intent" }; } };
    const harness = routeHarness(role, store);
    assert.equal(await harness.routes.handle(context()), true);
    assert.equal(response.statusCode, 404);
    assert.equal(creates, 0);
  }
});

test("inactive identity is rejected and no intent is created", async () => {
  const harness = routeHarness("admin", memoryStore());
  harness.setIdentityError(new IdentityResolutionError(403, "CloudPilot account is suspended."));
  response.statusCode = undefined;
  assert.equal(await harness.routes.handle(context()), true);
  assert.equal(response.statusCode, 403);
});

test("client-supplied state or redirect values are rejected", async () => {
  let creates = 0;
  const harness = routeHarness("owner", { async create() { creates += 1; return { id: "intent" }; } });
  response.statusCode = undefined;
  await harness.routes.handle(context({ async parseJsonBody() { return { state: "attacker-state", redirectUrl: "https://evil.invalid" }; } }));
  assert.equal(response.statusCode, 400);
  assert.equal(creates, 0);
});

test("missing or invalid app slug fails safely before persistence", async () => {
  let creates = 0;
  const store: GitHubConnectIntentStore = { async create() { creates += 1; return { id: "intent" }; } };
  const harness = routeHarness("owner", store, { missingSlug: true });
  response.statusCode = undefined;
  await harness.routes.handle(context());
  assert.equal(response.statusCode, 503);
  assert.match(JSON.stringify(response.body), /Set GITHUB_APP_SLUG on the backend/);
  assert.throws(() => new GitHubConnectIntentService(store, { appSlug: "../untrusted", now: () => nowMs }), /valid GitHub App slug/);
  assert.equal(creates, 0);
});

test("invalid lifetime configuration is rejected and valid lifetime is bounded", () => {
  const store = memoryStore();
  assert.throws(() => new GitHubConnectIntentService(store, { appSlug: "cloudpilot", lifetimeSeconds: 59 }), /lifetime configuration is invalid/);
  assert.throws(() => new GitHubConnectIntentService(store, { appSlug: "cloudpilot", lifetimeSeconds: 901 }), /lifetime configuration is invalid/);
  assert.doesNotThrow(() => new GitHubConnectIntentService(store, { appSlug: "cloudpilot", lifetimeSeconds: 900 }));
});

test("raw state is not included in persisted records, audit metadata, or logs", async () => {
  const persisted: unknown[] = [];
  const audit: unknown[] = [];
  const prisma = {
    async $transaction<T>(callback: (tx: unknown) => Promise<T>) {
      return callback({
        gitHubConnectIntent: { async create(args: unknown) { persisted.push(args); return { id: "intent-id" }; } },
        organizationAuditEvent: { async create(args: unknown) { audit.push(args); } }
      });
    }
  } as unknown as PrismaClient;
  const store = new PrismaGitHubConnectIntentStore(prisma);
  const route = new GitHubConnectIntentApiRoutes(
    { async resolve() { return { id: identityUserId, status: "active" }; } } as never,
    { async authorize() { return { role: "owner", permission: "organization:integrations:manage" }; } } as never,
    new GitHubConnectIntentService(store, { appSlug: "cloudpilot", now: () => nowMs, randomBytes: () => entropy }),
    { expectedIssuer: issuer, allowFirstUseProvisioning: false }
  );
  const logs: unknown[] = [];
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { logs.push(["log", ...args]); };
  console.info = (...args: unknown[]) => { logs.push(["info", ...args]); };
  console.warn = (...args: unknown[]) => { logs.push(["warn", ...args]); };
  console.error = (...args: unknown[]) => { logs.push(["error", ...args]); };
  try {
    response.statusCode = undefined;
    await route.handle(context());
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
  }
  const output = JSON.stringify({ persisted, audit, logs });
  assert.equal(output.includes(expectedState), false);
  assert.equal(output.includes(createHash("sha256").update(expectedState).digest("hex")), true);
  assert.deepEqual((audit[0] as { data: { metadata: unknown } }).data.metadata, { intentId: "intent-id" });
  assert.deepEqual(logs, []);
});

test("database failure returns no installation URL or state", async () => {
  const harness = routeHarness("owner", { async create() { throw new Error("sensitive database failure detail"); } });
  response.statusCode = undefined;
  response.body = undefined;
  await harness.routes.handle(context());
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, {
    error: "Unable to create a GitHub installation request. Verify database availability and backend GitHub App configuration."
  });
  assert.equal(JSON.stringify(response.body).includes(expectedState), false);
});

test("Prisma intent and organization audit writes share one transaction", async () => {
  const calls: unknown[] = [];
  const prisma = {
    async $transaction<T>(callback: (tx: unknown) => Promise<T>) {
      calls.push("transaction-start");
      const result = await callback({
        gitHubConnectIntent: { async create(args: unknown) { calls.push(["intent", args]); return { id: "intent-id" }; } },
        organizationAuditEvent: { async create(args: unknown) { calls.push(["audit", args]); } }
      });
      calls.push("transaction-commit");
      return result;
    }
  } as unknown as PrismaClient;
  const store = new PrismaGitHubConnectIntentStore(prisma);
  const createdAt = new Date(nowMs);
  const expiresAt = new Date(nowMs + 600_000);
  assert.deepEqual(await store.create({ organizationId, identityUserId, stateHash: "a".repeat(64), createdAt, expiresAt }), { id: "intent-id" });
  assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), ["transaction-start", "intent", "audit", "transaction-commit"]);
  const auditData = (calls[2] as [string, { data: Record<string, unknown> }])[1].data;
  assert.deepEqual(auditData, {
    organizationId,
    actorUserId: identityUserId,
    action: "github.installation.connect_intent_created",
    targetType: "github_connect_intent",
    targetId: "intent-id",
    metadata: { intentId: "intent-id" }
  });
});

test("API authentication rejects an unauthenticated connect-intent request before extension execution", async () => {
  let extensionCalls = 0;
  const extension = { async handle() { extensionCalls += 1; return true; } };
  const api = new CloudPilotApiServer({
    prisma: {} as PrismaClient,
    jwtConfig: { expectedIssuer: TEST_ISSUER, expectedAudience: TEST_AUDIENCE, publicKeyOrSecret: TEST_PUBLIC_KEY },
    scanRunner: { async initialize() {}, async shutdown() {} } as never,
    routeExtensions: [extension]
  });
  const port = await api.start(0, "127.0.0.1");
  try {
    const result = await fetch(`http://127.0.0.1:${port}/api/v1/organizations/${organizationId}/github/installations/start`, { method: "POST" });
    assert.equal(result.status, 401);
    assert.equal(extensionCalls, 0);
  } finally {
    await api.stop();
  }
});
