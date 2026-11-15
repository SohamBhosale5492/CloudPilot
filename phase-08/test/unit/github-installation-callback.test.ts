import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import test from "node:test";
import { CloudPilotApiServer } from "../../../phase-06/src/api/server.js";
import type { AuthenticatedRouteContext } from "../../../phase-06/src/api/server.js";
import { TEST_AUDIENCE, TEST_ISSUER, TEST_PUBLIC_KEY } from "../../../phase-06/test/jwt-signer.js";
import { GitHubInstallationCallbackApiRoutes } from "../../src/api/github-installation-callback-api.js";
import {
  GitHubInstallationCallbackError,
  GitHubInstallationCallbackService,
  PrismaGitHubInstallationCallbackStore,
  parseGitHubInstallationId,
  type GitHubInstallationCallbackStore,
  type GitHubInstallationVerifier
} from "../../src/github/installation-callback.js";
import { GitHubInstallationVerificationError, type VerifiedGitHubInstallation } from "../../src/github/installation-verifier.js";
import { IdentityResolutionError, type IdentityResolver } from "../../src/identity/identity-resolver.js";

const intentId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const initiatorId = "33333333-3333-4333-8333-333333333333";
const anotherUserId = "44444444-4444-4444-8444-444444444444";
const installationId = "12345678";
const now = new Date("2026-11-05T12:00:00.000Z");
const state = Buffer.alloc(32, 0x6a).toString("base64url");
const stateHash = createHash("sha256").update(state, "utf8").digest("hex");
const installation: VerifiedGitHubInstallation = {
  installationId: BigInt(installationId), accountId: 987654n,
  accountLogin: "cloudpilot-org", accountType: "Organization",
  permissions: { contents: "write", pull_requests: "write", metadata: "read" }
};

function intent(overrides: Partial<{ consumedAt: Date | null; expiresAt: Date; initiatedByIdentityUserId: string }> = {}) {
  return {
    id: intentId, organizationId, initiatedByIdentityUserId: initiatorId, stateHash,
    expiresAt: new Date(now.getTime() + 60_000), consumedAt: null, ...overrides
  };
}

function storeHarness(options: {
  snapshot?: ReturnType<typeof intent> | null;
  persist?: () => Promise<{ installationRecordId: string; alreadyConnected: boolean }>;
} = {}) {
  const lookups: string[] = [];
  const persisted: unknown[] = [];
  const store: GitHubInstallationCallbackStore = {
    async findIntent(hash) { lookups.push(hash); return options.snapshot === undefined ? intent() : options.snapshot; },
    async persistVerifiedInstallation(input) {
      persisted.push(input);
      return options.persist ? options.persist() : { installationRecordId: "55555555-5555-4555-8555-555555555555", alreadyConnected: false };
    }
  };
  return { store, lookups, persisted };
}

function serviceHarness(options: {
  snapshot?: ReturnType<typeof intent> | null;
  role?: boolean;
  verifier?: GitHubInstallationVerifier;
  persist?: () => Promise<{ installationRecordId: string; alreadyConnected: boolean }>;
  userId?: string;
} = {}) {
  const db = storeHarness({ snapshot: options.snapshot, persist: options.persist });
  const authorizationCalls: unknown[] = [];
  const authorization = {
    async authorize(...args: unknown[]) {
      authorizationCalls.push(args);
      return options.role === false ? null : { role: "admin", permission: "organization:integrations:manage" };
    }
  } as never;
  const verifierCalls: string[] = [];
  const verifier = options.verifier ?? {
    async verify(id: string) { verifierCalls.push(id); return installation; }
  };
  return {
    service: new GitHubInstallationCallbackService(db.store, authorization, verifier, () => new Date(now)),
    ...db, authorizationCalls, verifierCalls
  };
}

function callbackInput(overrides: Partial<{ identityUserId: string; installationId: string; state: string }> = {}) {
  return { identityUserId: initiatorId, installationId, state, ...overrides };
}

test("accepts only positive decimal PostgreSQL BIGINT installation IDs", () => {
  assert.equal(parseGitHubInstallationId("1"), "1");
  assert.equal(parseGitHubInstallationId("9223372036854775807"), "9223372036854775807");
  for (const value of ["0", "-1", "01", "1.0", "9223372036854775808", 12, "10000000000000000000"]) {
    assert.equal(parseGitHubInstallationId(value), null);
  }
});

test("valid callback hashes exact state, authorizes the intent organization, verifies GitHub, then persists", async () => {
  const harness = serviceHarness();
  const result = await harness.service.complete(callbackInput());
  assert.deepEqual(harness.lookups, [stateHash]);
  assert.deepEqual(harness.authorizationCalls, [[initiatorId, organizationId, "organization:integrations:manage"]]);
  assert.deepEqual(harness.verifierCalls, [installationId]);
  assert.equal(harness.persisted.length, 1);
  const persisted = harness.persisted[0] as { intent: { organizationId: string }; identityUserId: string; installation: VerifiedGitHubInstallation };
  assert.equal(persisted.intent.organizationId, organizationId);
  assert.equal(persisted.identityUserId, initiatorId);
  assert.equal(persisted.installation.installationId, BigInt(installationId));
  assert.equal(JSON.stringify(harness.lookups).includes(state), false);
  assert.deepEqual(result, {
    installationRecordId: "55555555-5555-4555-8555-555555555555",
    organizationId,
    githubInstallationId: installationId,
    accountLogin: "cloudpilot-org",
    accountType: "Organization",
    status: "connected",
    alreadyConnected: false
  });
});

test("rejects invalid state, missing, expired, and already-consumed intents without GitHub calls", async () => {
  const invalidState = serviceHarness();
  await assert.rejects(invalidState.service.complete(callbackInput({ state: "bad" })), GitHubInstallationCallbackError);
  const missing = serviceHarness({ snapshot: null });
  await assert.rejects(missing.service.complete(callbackInput()), (error: unknown) => error instanceof GitHubInstallationCallbackError && error.code === "invalid_intent");
  const expired = serviceHarness({ snapshot: intent({ expiresAt: new Date(now.getTime() - 1) }) });
  await assert.rejects(expired.service.complete(callbackInput()), (error: unknown) => error instanceof GitHubInstallationCallbackError && error.code === "intent_expired_or_consumed");
  const consumed = serviceHarness({ snapshot: intent({ consumedAt: now }) });
  await assert.rejects(consumed.service.complete(callbackInput()), (error: unknown) => error instanceof GitHubInstallationCallbackError && error.code === "intent_expired_or_consumed");
  assert.equal(expired.verifierCalls.length + consumed.verifierCalls.length + missing.verifierCalls.length, 0);
});

test("rejects callback by a different user and revoked organization permission", async () => {
  const otherUser = serviceHarness();
  await assert.rejects(otherUser.service.complete(callbackInput({ identityUserId: anotherUserId })),
    (error: unknown) => error instanceof GitHubInstallationCallbackError && error.code === "initiator_mismatch");
  const revoked = serviceHarness({ role: false });
  await assert.rejects(revoked.service.complete(callbackInput()),
    (error: unknown) => error instanceof GitHubInstallationCallbackError && error.code === "organization_forbidden");
  assert.equal(revoked.verifierCalls.length, 0);
  assert.equal(revoked.persisted.length, 0);
});

test("verification failure leaves the intent unconsumed for a later safe retry", async () => {
  let calls = 0;
  const harness = serviceHarness({ verifier: { async verify() {
    calls += 1;
    if (calls === 1) throw new GitHubInstallationVerificationError("request_timeout");
    return installation;
  } } });
  await assert.rejects(harness.service.complete(callbackInput()),
    (error: unknown) => error instanceof GitHubInstallationVerificationError && error.code === "request_timeout");
  assert.equal(harness.persisted.length, 0);
  assert.equal((await harness.service.complete(callbackInput())).status, "connected");
  assert.equal(harness.persisted.length, 1);
});

test("concurrent callbacks for the same intent can persist only one result", async () => {
  let verified = 0;
  let release!: () => void;
  const bothVerified = new Promise<void>((resolve) => { release = resolve; });
  let consumed = false;
  const store: GitHubInstallationCallbackStore = {
    async findIntent() { return intent(); },
    async persistVerifiedInstallation() {
      if (!consumed) {
        consumed = true;
        return { installationRecordId: "record", alreadyConnected: false };
      }
      throw new GitHubInstallationCallbackError("intent_expired_or_consumed");
    }
  };
  const callback = new GitHubInstallationCallbackService(
    store,
    { async authorize() { return { role: "owner", permission: "organization:integrations:manage" }; } } as never,
    { async verify() { verified += 1; if (verified === 2) release(); await bothVerified; return installation; } },
    () => new Date(now)
  );
  const results = await Promise.allSettled([callback.complete(callbackInput()), callback.complete(callbackInput())]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

function prismaStoreHarness(options: {
  existing?: { id: string; organizationId: string; status: string } | null;
  consumeCount?: number;
  membership?: boolean;
  auditFailure?: boolean;
  createFailure?: unknown;
} = {}) {
  const writes: unknown[] = [];
  let consumedWhere: unknown;
  let createArgs: unknown;
  let auditArgs: unknown;
  const tx = {
    organizationMember: {},
    organizationGitHubInstallation: {
      async findUnique() { return options.existing ?? null; },
      async create(args: unknown) {
        writes.push("installation"); createArgs = args;
        if (options.createFailure) throw options.createFailure;
        return { id: "66666666-6666-4666-8666-666666666666" };
      }
    },
    gitHubConnectIntent: {
      async updateMany(args: unknown) { writes.push("consume"); consumedWhere = args; return { count: options.consumeCount ?? 1 }; }
    },
    organizationAuditEvent: {
      async create(args: unknown) { writes.push("audit"); auditArgs = args; if (options.auditFailure) throw new Error("audit write failure"); }
    }
  };
  const prisma = {
    gitHubConnectIntent: { async findUnique(args: unknown) { writes.push(["lookup", args]); return intent(); } },
    async $transaction<T>(callback: (value: typeof tx) => Promise<T>, transactionOptions: unknown) {
      writes.push(["transaction-options", transactionOptions]);
      try {
        const result = await callback(tx);
        writes.push("commit");
        return result;
      } catch (error) {
        writes.push("rollback");
        throw error;
      }
    }
  } as unknown as PrismaClient;
  const authorization = {
    async authorizeInTransaction(_tx: unknown, userId: string, orgId: string, permission: string) {
      writes.push(["membership", userId, orgId, permission]);
      return options.membership === false ? null : { role: "admin", permission };
    }
  } as never;
  return { store: new PrismaGitHubInstallationCallbackStore(prisma, authorization), writes, get consumedWhere() { return consumedWhere; }, get createArgs() { return createArgs; }, get auditArgs() { return auditArgs; } };
}

test("Prisma store conditionally consumes only the matching unconsumed, unexpired intent and audits atomically", async () => {
  const harness = prismaStoreHarness();
  const result = await harness.store.persistVerifiedInstallation({ intent: intent(), identityUserId: initiatorId, installation, consumedAt: now });
  assert.deepEqual(result, { installationRecordId: "66666666-6666-4666-8666-666666666666", alreadyConnected: false });
  assert.deepEqual(harness.consumedWhere, {
    where: {
      id: intentId, stateHash, initiatedByIdentityUserId: initiatorId, consumedAt: null,
      expiresAt: { gt: now }
    }, data: { consumedAt: now }
  });
  assert.deepEqual(harness.writes.map((call) => Array.isArray(call) ? call[0] : call), ["transaction-options", "membership", "consume", "installation", "audit", "commit"]);
  assert.deepEqual(harness.writes[0], ["transaction-options", { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }]);
  const installationData = (harness.createArgs as { data: Record<string, unknown> }).data;
  assert.equal(installationData.githubInstallationId, BigInt(installationId));
  assert.equal(installationData.githubAccountId, installation.accountId);
  assert.equal(installationData.organizationId, organizationId);
  const auditData = (harness.auditArgs as { data: Record<string, unknown> }).data;
  assert.deepEqual(auditData.metadata, {
    installationRecordId: "66666666-6666-4666-8666-666666666666",
    githubInstallationId: installationId,
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    verifiedPermissionNames: ["contents", "metadata", "pull_requests"]
  });
  assert.equal(JSON.stringify(auditData).includes(state), false);
  assert.equal("tenantId" in auditData, false);
});

test("transaction rechecks current membership and rolls back unsuccessful claims or audit writes", async () => {
  const revoked = prismaStoreHarness({ membership: false });
  await assert.rejects(revoked.store.persistVerifiedInstallation({ intent: intent(), identityUserId: initiatorId, installation, consumedAt: now }),
    (error: unknown) => error instanceof GitHubInstallationCallbackError && error.code === "organization_forbidden");
  assert.equal(revoked.writes.includes("consume"), false);
  const lostRace = prismaStoreHarness({ consumeCount: 0 });
  await assert.rejects(lostRace.store.persistVerifiedInstallation({ intent: intent(), identityUserId: initiatorId, installation, consumedAt: now }),
    (error: unknown) => error instanceof GitHubInstallationCallbackError && error.code === "intent_expired_or_consumed");
  assert.equal(lostRace.writes.includes("installation"), false);
  const auditFailure = prismaStoreHarness({ auditFailure: true });
  await assert.rejects(auditFailure.store.persistVerifiedInstallation({ intent: intent(), identityUserId: initiatorId, installation, consumedAt: now }), /audit write failure/);
  assert.deepEqual(auditFailure.writes.slice(-3), ["installation", "audit", "rollback"]);
  assert.equal(auditFailure.writes.includes("commit"), false);
});

test("same-org active installation is idempotent; other-org or disconnected records conflict without reactivation", async () => {
  const active = prismaStoreHarness({ existing: { id: "existing-record", organizationId, status: "active" } });
  assert.deepEqual(await active.store.persistVerifiedInstallation({ intent: intent(), identityUserId: initiatorId, installation, consumedAt: now }), {
    installationRecordId: "existing-record", alreadyConnected: true
  });
  assert.equal(active.writes.includes("installation"), false);
  assert.equal(active.writes.includes("audit"), false);

  for (const existing of [
    { id: "other-org", organizationId: "99999999-9999-4999-8999-999999999999", status: "active" },
    { id: "disconnected", organizationId, status: "disconnected" }
  ]) {
    const conflict = prismaStoreHarness({ existing });
    await assert.rejects(conflict.store.persistVerifiedInstallation({ intent: intent(), identityUserId: initiatorId, installation, consumedAt: now }),
      (error: unknown) => error instanceof GitHubInstallationCallbackError && error.code === "installation_conflict");
    assert.equal(conflict.writes.includes("consume"), false);
  }
});

test("maps concurrent unique or serialization conflicts to a safe callback conflict", async () => {
  const p2002 = new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "5.22.0" });
  const p2034 = new Prisma.PrismaClientKnownRequestError("serialization", { code: "P2034", clientVersion: "5.22.0" });
  for (const failure of [p2002, p2034]) {
    const base = prismaStoreHarness({ createFailure: failure });
    await assert.rejects(base.store.persistVerifiedInstallation({ intent: intent(), identityUserId: initiatorId, installation, consumedAt: now }),
      (error: unknown) => error instanceof GitHubInstallationCallbackError && error.code === "installation_conflict");
  }
});

test("callback API requires exact fields and resolves the verified principal before service invocation", async () => {
  const observed: unknown[] = [];
  const identityResolver = {
    async resolve(principal: unknown, allow: boolean) { observed.push([principal, allow]); return { id: initiatorId, status: "active" }; }
  } as unknown as IdentityResolver;
  const callback = {
    async complete(input: unknown) { observed.push(input); return { status: "connected", alreadyConnected: false }; }
  } as never;
  const routes = new GitHubInstallationCallbackApiRoutes(identityResolver, callback, { expectedIssuer: "https://issuer.test", allowFirstUseProvisioning: false });
  const result: { status?: number; body?: unknown } = {};
  const request = (body: unknown) => ({
    req: {} as never, res: {} as never, method: "POST", pathname: "/api/v1/github/installations/callback",
    url: new URL("http://localhost/api/v1/github/installations/callback"),
    identity: { userId: "verified-sub", tenantId: "verified-tenant", roles: ["admin"] },
    async parseJsonBody() { return body; }, sendJson(status: number, responseBody: unknown) { result.status = status; result.body = responseBody; }
  }) as unknown as AuthenticatedRouteContext;
  // Extra fields rejected for both setupAction values
  for (const setupAction of ["install", "update"] as const) {
    assert.equal(await routes.handle(request({ installationId, state, setupAction, organizationId })), true);
    assert.equal(result.status, 400);
    assert.equal(observed.length, 0);
  }

  // Unsupported setupAction rejected
  for (const badAction of ["reinstall", "delete", "request", "unknown", "", 123, null, undefined]) {
    assert.equal(await routes.handle(request({ installationId, state, setupAction: badAction })), true);
    assert.equal(result.status, 400);
    assert.equal(observed.length, 0);
  }

  // Malformed installationId rejected for both actions
  for (const setupAction of ["install", "update"] as const) {
    for (const badId of ["not-a-number", "0", "-1", "99999999999999999999999", ""]) {
      assert.equal(await routes.handle(request({ installationId: badId, state, setupAction })), true);
      assert.equal(result.status, 400);
      assert.equal(observed.length, 0);
    }
  }

  // Malformed state rejected for both actions
  for (const setupAction of ["install", "update"] as const) {
    for (const badState of ["short", "x".repeat(42), "x".repeat(44), "x".repeat(42) + "!", ""]) {
      assert.equal(await routes.handle(request({ installationId, state: badState, setupAction })), true);
      assert.equal(result.status, 400);
      assert.equal(observed.length, 0);
    }
  }

  // Valid payload accepted for both update and install
  for (const setupAction of ["update", "install"] as const) {
    observed.length = 0;
    assert.equal(await routes.handle(request({ installationId, state, setupAction })), true);
    assert.deepEqual(observed, [
      [{ issuer: "https://issuer.test", subject: "verified-sub" }, false],
      { identityUserId: initiatorId, installationId, state }
    ]);
    assert.equal(result.status, 201);
  }
});

test("callback API maps inactive identity and hides state or upstream details on persistence failure", async () => {
  const identityResolver = {
    async resolve() { throw new IdentityResolutionError(403, "CloudPilot account is suspended."); }
  } as unknown as IdentityResolver;
  const callback = { async complete() { throw new Error("db secret, state=" + state); } } as never;
  const routes = new GitHubInstallationCallbackApiRoutes(identityResolver, callback, { expectedIssuer: "https://issuer.test", allowFirstUseProvisioning: false });
  const result: { status?: number; body?: unknown } = {};
  const request = (resolve: () => Promise<unknown>) => ({
    req: {} as never, res: {} as never, method: "POST", pathname: "/api/v1/github/installations/callback",
    url: new URL("http://localhost/api/v1/github/installations/callback"),
    identity: { userId: "verified-sub", tenantId: "verified-tenant", roles: ["admin"] },
    parseJsonBody: resolve, sendJson(status: number, body: unknown) { result.status = status; result.body = body; }
  }) as unknown as AuthenticatedRouteContext;
  const activeResolver = { async resolve() { return { id: initiatorId, status: "active" }; } } as unknown as IdentityResolver;
  const failingRoutes = new GitHubInstallationCallbackApiRoutes(activeResolver, callback, { expectedIssuer: "https://issuer.test", allowFirstUseProvisioning: false });

  for (const setupAction of ["install", "update"] as const) {
    await routes.handle(request(async () => ({ installationId, state, setupAction })));
    assert.equal(result.status, 403);

    await failingRoutes.handle(request(async () => ({ installationId, state, setupAction })));
    assert.equal(result.status, 503);
    assert.equal(JSON.stringify(result.body).includes(state), false);
  }
});

test("API authentication rejects a callback without a valid CloudPilot JWT before route execution", async () => {
  let extensionCalls = 0;
  const api = new CloudPilotApiServer({
    prisma: {} as PrismaClient,
    jwtConfig: { expectedIssuer: TEST_ISSUER, expectedAudience: TEST_AUDIENCE, publicKeyOrSecret: TEST_PUBLIC_KEY },
    scanRunner: { async initialize() {}, async shutdown() {} } as never,
    routeExtensions: [{ async handle() { extensionCalls += 1; return true; } }]
  });
  const port = await api.start(0, "127.0.0.1");
  try {
    for (const setupAction of ["install", "update"] as const) {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/github/installations/callback`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ installationId, state, setupAction })
      });
      assert.equal(response.status, 401);
      assert.equal(extensionCalls, 0);
    }
  } finally {
    await api.stop();
  }
});
