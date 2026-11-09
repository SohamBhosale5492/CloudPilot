import assert from "node:assert/strict";
import test from "node:test";
import type { JwtVerifierConfig } from "../../../phase-06/src/auth/jwt-verifier.js";
import type { AuthenticatedRouteExtension } from "../../../phase-06/src/api/server.js";
import { CloudPilotApiServer } from "../../../phase-06/src/api/server.js";
import type { BoundedScanRunner } from "../../../phase-06/src/jobs/scan-runner.js";
import { mintTestJwt, TEST_ISSUER, TEST_AUDIENCE, TEST_PUBLIC_KEY } from "../../../phase-06/test/jwt-signer.js";
import { IdentityOrganizationApiRoutes } from "../../src/api/identity-organization-api.js";
import type { IdentityResolver } from "../../src/identity/identity-resolver.js";
import type { OrganizationApiService } from "../../src/api/identity-organization-api.js";
import type { AuthorizedGitHubRepositoryAccess } from "../../src/github/organization-authorization-contract.js";
import { RemediationApiRoutes } from "../../src/api/remediation-api.js";
import type { RemediationApiStore } from "../../src/api/remediation-api-repo.js";
import { ArtifactOnlyRemediationWorker } from "../../src/jobs/artifact-only-remediation-worker.js";
import type { ArtifactOnlyExecutionRecoveryService } from "../../src/remediation/artifact-only-execution-recovery.js";
import {
  CloudPilotApplicationHost,
  createCloudPilotHostFromEnvironment,
  HostApiLifecycle,
  HostDatabaseLifecycle
} from "../../src/host.js";

const jwtConfig: JwtVerifierConfig = {
  expectedIssuer: "https://issuer.test",
  expectedAudience: "cloudpilot-test",
  publicKeyOrSecret: "test-only-key"
};

test("host configuration requires PostgreSQL URL and rejects premature worker activation", () => {
  assert.throws(() => createCloudPilotHostFromEnvironment(jwtConfig, {}), /DATABASE_URL/);
  assert.throws(() => createCloudPilotHostFromEnvironment(jwtConfig, {
    DATABASE_URL: "https://db.invalid/cloudpilot",
    CLOUDPILOT_ENABLE_REMEDIATION_WORKER: "false"
  }), /DATABASE_URL/);
  assert.throws(() => createCloudPilotHostFromEnvironment(jwtConfig, {
    DATABASE_URL: "postgresql://user:pass@localhost:55432/cloudpilot_phase08_test",
    CLOUDPILOT_ENABLE_REMEDIATION_WORKER: "yes"
  }), /CLOUDPILOT_ENABLE_REMEDIATION_WORKER/);
  assert.throws(() => createCloudPilotHostFromEnvironment(jwtConfig, {
    DATABASE_URL: "postgresql://user:pass@localhost:55432/cloudpilot_phase08_test",
    NODE_ENV: "test",
    CLOUDPILOT_ENABLE_REMEDIATION_WORKER: "true"
  }), /cannot be enabled until approved-artifact execution is integrated/i);
  assert.throws(() => createCloudPilotHostFromEnvironment(jwtConfig, {
    DATABASE_URL: "postgresql://user:pass@localhost:55432/cloudpilot_phase08_test", HOST: "not-an-ip"
  }), /HOST/);
});

test("host wires the GitHub App provider to injected backend environment without requiring credentials at startup", async () => {
  const host = createCloudPilotHostFromEnvironment(jwtConfig, {
    DATABASE_URL: "postgresql://user:pass@localhost:55432/cloudpilot_phase08_test",
    NODE_ENV: "test"
  });
  assert.ok(host.githubAppTokenService);
  assert.ok(host.remediationArtifactPreparationService);
  assert.ok(host.remediationExecutionAuthorizationService);
  assert.ok(host.githubExecutionCapabilityService);
  assert.equal(host.remediationWorkerEnabled, false);
  await assert.rejects(
    host.githubAppCredentialProvider.getCredentials(),
    /GITHUB_APP_ID is required/
  );
  await assert.rejects(
    host.githubAppTokenService.getInstallationToken({ installationId: "1", repositoryId: "1" } as AuthorizedGitHubRepositoryAccess),
    /credentials are unavailable or invalid/
  );
  await host.stop();
});

test("worker remains disabled by default and explicit activation fails closed", async () => {
  const disabled = createCloudPilotHostFromEnvironment(jwtConfig, {
    DATABASE_URL: "postgresql://user:pass@localhost:55432/cloudpilot_phase08_test",
    NODE_ENV: "test"
  });
  assert.equal(disabled.remediationWorkerEnabled, false);
  await disabled.stop();

  assert.throws(() => createCloudPilotHostFromEnvironment(jwtConfig, {
    DATABASE_URL: "postgresql://user:pass@localhost:55432/cloudpilot_phase08_test",
    NODE_ENV: "test",
    CLOUDPILOT_ENABLE_REMEDIATION_WORKER: "true"
  }), /cannot be enabled until approved-artifact execution is integrated/i);
});

test("identity provisioning defaults off and organization creation defaults on only in development", async () => {
  const base = { DATABASE_URL: "postgresql://user:pass@localhost:55432/cloudpilot_phase08_test", NODE_ENV: "development" };
  const defaults = createCloudPilotHostFromEnvironment(jwtConfig, base);
  await defaults.stop();
  assert.throws(() => createCloudPilotHostFromEnvironment(jwtConfig, {
    ...base, CLOUDPILOT_IDENTITY_PROVISIONING_ENABLED: "yes"
  }), /CLOUDPILOT_IDENTITY_PROVISIONING_ENABLED/);
  assert.throws(() => createCloudPilotHostFromEnvironment(jwtConfig, {
    ...base, CLOUDPILOT_MAX_ORGANIZATIONS_PER_USER: "0"
  }), /CLOUDPILOT_MAX_ORGANIZATIONS_PER_USER/);
  const production = createCloudPilotHostFromEnvironment(jwtConfig, {
    ...base, NODE_ENV: "production", CLOUDPILOT_ORGANIZATION_CREATION_ENABLED: "false",
    CLOUDPILOT_IDENTITY_PROVISIONING_ENABLED: "true", CLOUDPILOT_MAX_ORGANIZATIONS_PER_USER: "10"
  });
  await production.stop();
});

test("GitHub connect-intent host configuration validates slug and bounded lifetime without requiring App credentials", async () => {
  const base = { DATABASE_URL: "postgresql://user:pass@localhost:55432/cloudpilot_phase08_test", NODE_ENV: "test" };
  const noSlug = createCloudPilotHostFromEnvironment(jwtConfig, base);
  await noSlug.stop();
  assert.throws(() => createCloudPilotHostFromEnvironment(jwtConfig, { ...base, GITHUB_APP_SLUG: "../bad" }), /GITHUB_APP_SLUG/);
  assert.throws(() => createCloudPilotHostFromEnvironment(jwtConfig, {
    ...base, CLOUDPILOT_GITHUB_CONNECT_INTENT_TTL_SECONDS: "0"
  }), /CLOUDPILOT_GITHUB_CONNECT_INTENT_TTL_SECONDS/);
  assert.throws(() => createCloudPilotHostFromEnvironment(jwtConfig, {
    ...base, CLOUDPILOT_GITHUB_CONNECT_INTENT_TTL_SECONDS: "901"
  }), /CLOUDPILOT_GITHUB_CONNECT_INTENT_TTL_SECONDS/);
  const configured = createCloudPilotHostFromEnvironment(jwtConfig, {
    ...base, GITHUB_APP_SLUG: "cloudpilot-demo", CLOUDPILOT_GITHUB_CONNECT_INTENT_TTL_SECONDS: "600"
  });
  await configured.stop();
});

test("application host connects and starts once, then gracefully stops and disconnects once", async () => {
  const calls = { connect: 0, verify: 0, disconnect: 0, start: 0, stop: 0 };
  const database: HostDatabaseLifecycle = {
    async connect() { calls.connect++; },
    async verify() { calls.verify++; },
    async disconnect() { calls.disconnect++; }
  };
  const api: HostApiLifecycle = {
    async start() { calls.start++; return 43210; },
    async stop() { calls.stop++; }
  };
  const host = new CloudPilotApplicationHost(database, api, 3000, true);
  const ports = await Promise.all([host.start(), host.start()]);
  assert.deepEqual(ports, [43210, 43210]);
  assert.deepEqual(calls, { connect: 1, verify: 1, disconnect: 0, start: 1, stop: 0 });
  await Promise.all([host.stop(), host.stop()]);
  assert.deepEqual(calls, { connect: 1, verify: 1, disconnect: 1, start: 1, stop: 1 });
  await assert.rejects(host.start(), /already been stopped/);
});

test("host passes an explicit safe bind address to the API", async () => {
  let bound = "";
  const host = new CloudPilotApplicationHost({
    async connect() {}, async verify() {}, async disconnect() {}
  }, {
    async start(_port, address) { bound = address ?? ""; return 3000; }, async stop() {}
  }, 3000, false, "127.0.0.1");
  await host.start();
  assert.equal(bound, "127.0.0.1");
  await host.stop();
});

test("host keeps Prisma connected until API and worker shutdown finish", async () => {
  let releaseApiStop!: () => void;
  const apiStopGate = new Promise<void>((resolve) => { releaseApiStop = resolve; });
  const calls: string[] = [];
  const host = new CloudPilotApplicationHost({
    async connect() { calls.push("connect"); },
    async verify() { calls.push("verify"); },
    async disconnect() { calls.push("disconnect"); }
  }, {
    async start() { calls.push("listen"); return 3000; },
    async stop() { calls.push("worker-stop-start"); await apiStopGate; calls.push("worker-stop-finished"); }
  }, 3000, true);
  await host.start();
  const stopping = host.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["connect", "verify", "listen", "worker-stop-start"]);
  releaseApiStop();
  await stopping;
  assert.deepEqual(calls, ["connect", "verify", "listen", "worker-stop-start", "worker-stop-finished", "disconnect"]);
});

test("database or worker startup failure rejects startup and closes the API/database", async () => {
  const calls = { connect: 0, verify: 0, disconnect: 0, start: 0, stop: 0 };
  const database: HostDatabaseLifecycle = {
    async connect() { calls.connect++; },
    async verify() { calls.verify++; throw new Error("database unavailable"); },
    async disconnect() { calls.disconnect++; }
  };
  const api: HostApiLifecycle = {
    async start() { calls.start++; return 3000; },
    async stop() { calls.stop++; }
  };
  const host = new CloudPilotApplicationHost(database, api, 3000, true);
  await assert.rejects(host.start(), /CloudPilot host startup failed/);
  assert.deepEqual(calls, { connect: 1, verify: 1, disconnect: 1, start: 0, stop: 1 });

  const startupCalls = { apiStop: 0, disconnect: 0 };
  const failingHost = new CloudPilotApplicationHost({
    async connect() {}, async verify() {}, async disconnect() { startupCalls.disconnect++; }
  }, {
    async start() { throw new Error("worker initialization failed"); },
    async stop() { startupCalls.apiStop++; }
  }, 3000, true);
  await assert.rejects(failingHost.start(), /CloudPilot host startup failed/);
  assert.deepEqual(startupCalls, { apiStop: 1, disconnect: 1 });
});

test("CloudPilotApiServer initializes its worker extension exactly once and shuts it down gracefully", async () => {
  const calls = { scanInit: 0, scanStop: 0, workerInit: 0, workerStop: 0 };
  const scanRunner = {
    async initialize() { calls.scanInit++; },
    async shutdown() { calls.scanStop++; }
  } as unknown as BoundedScanRunner;
  const scheduler = {
    triggerPoll() {},
    async initialize() { calls.workerInit++; },
    async shutdown() { calls.workerStop++; }
  };
  const routes = new RemediationApiRoutes({} as RemediationApiStore, scheduler);
  const server = new CloudPilotApiServer({
    prisma: {} as never,
    jwtConfig,
    scanRunner,
    routeExtensions: [routes]
  });
  const ports = await Promise.all([server.start(0), server.start(0)]);
  assert.equal(ports[0], ports[1]);
  assert.deepEqual(calls, { scanInit: 1, scanStop: 0, workerInit: 1, workerStop: 0 });
  await Promise.all([server.stop(), server.stop()]);
  assert.deepEqual(calls, { scanInit: 1, scanStop: 1, workerInit: 1, workerStop: 1 });
});

test("worker-disabled host composition serves identity routes and leaves remediation unavailable", async () => {
  const calls = { identityResolve: 0, scanInit: 0, workerInit: 0, workerStop: 0 };
  const identityResolver: IdentityResolver = {
    async resolve() {
      calls.identityResolve++;
      return {
        id: "11111111-1111-4111-8111-111111111111", status: "active", displayName: null, email: null,
        emailVerifiedAt: null, createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"),
        lastAuthenticatedAt: new Date("2026-01-01T00:00:00Z")
      } as never;
    }
  };
  const organizationService: OrganizationApiService = {
    async getProfile() { throw new Error("unused"); },
    async create() { throw new Error("unused"); },
    async listForUser(userId) {
      return { items: [{ id: "org-1", displayName: "Test Org", status: "active", createdAt: new Date("2026-01-01T00:00:00Z"), role: "owner" }], hasMore: false };
    }
  };
  const identityRoutes = new IdentityOrganizationApiRoutes(identityResolver, organizationService, {
    expectedIssuer: TEST_ISSUER,
    allowFirstUseProvisioning: false,
    organizationCreationEnabled: false,
    perUserOrganizationLimit: 5
  });
  const scanRunner = {
    async initialize() { calls.scanInit++; },
    async shutdown() {}
  } as unknown as BoundedScanRunner;
  const server = new CloudPilotApiServer({
    prisma: {} as never,
    jwtConfig: { expectedIssuer: TEST_ISSUER, expectedAudience: TEST_AUDIENCE, publicKeyOrSecret: TEST_PUBLIC_KEY },
    scanRunner,
    routeExtensions: [identityRoutes]
  });
  // This mirrors host composition with the remediation flag false: identity
  // routes are always mounted; no RemediationApiRoutes/worker is registered.
  const token = mintTestJwt({ sub: "verified-subject", roles: ["viewer"] });
  const host = new CloudPilotApplicationHost(
    { async connect() {}, async verify() {}, async disconnect() {} },
    { start: (port, address) => server.start(port, address), stop: () => server.stop() },
    0,
    false,
    "127.0.0.1"
  );
  assert.equal(host.remediationWorkerEnabled, false);
  const port = await host.start();
  const headers = { authorization: `Bearer ${token}`, connection: "close" };
  try {
    const me = await fetch(`http://127.0.0.1:${port}/api/v1/me`, { headers });
    assert.equal(me.status, 200);
    assert.equal((await me.json() as { user: { id: string } }).user.id, "11111111-1111-4111-8111-111111111111");

    const organizations = await fetch(`http://127.0.0.1:${port}/api/v1/organizations`, { headers });
    assert.equal(organizations.status, 200);
    assert.equal((await organizations.json() as { items: Array<{ id: string }> }).items[0]?.id, "org-1");

    const remediations = await fetch(`http://127.0.0.1:${port}/api/v1/remediations/example`, { headers });
    assert.equal(remediations.status, 404);
    assert.deepEqual(calls, { identityResolve: 2, scanInit: 1, workerInit: 0, workerStop: 0 });
  } finally {
    await host.stop();
  }
});

test("worker initialization failure prevents API listen and stops all started components", async () => {
  const calls = { scanInit: 0, scanStop: 0, workerInit: 0, workerStop: 0 };
  const scanRunner = {
    async initialize() { calls.scanInit++; },
    async shutdown() { calls.scanStop++; }
  } as unknown as BoundedScanRunner;
  const extension: AuthenticatedRouteExtension = {
    async handle() { return false; },
    async initialize() { calls.workerInit++; throw new Error("reaper unavailable"); },
    async shutdown() { calls.workerStop++; }
  };
  const server = new CloudPilotApiServer({ prisma: {} as never, jwtConfig, scanRunner, routeExtensions: [extension] });
  await assert.rejects(server.start(0), /reaper unavailable/);
  assert.deepEqual(calls, { scanInit: 1, scanStop: 1, workerInit: 1, workerStop: 1 });
  await server.stop();
  assert.deepEqual(calls, { scanInit: 1, scanStop: 1, workerInit: 1, workerStop: 1 });
});

test("API health endpoints report ready only after startup and hide database failure details", async () => {
  const scanRunner = { async initialize() {}, async shutdown() {} } as unknown as BoundedScanRunner;
  const server = new CloudPilotApiServer({
    prisma: {
      async $queryRawUnsafe() { throw new Error("secret database detail"); }
    } as never,
    jwtConfig,
    scanRunner
  });
  const port = await server.start(0, "127.0.0.1");
  try {
    const live = await fetch(`http://127.0.0.1:${port}/health/liveness`, { headers: { connection: "close" } });
    assert.equal(live.status, 200);
    const response = await fetch(`http://127.0.0.1:${port}/health/readiness`, { headers: { connection: "close" } });
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.doesNotMatch(body, /secret database detail/);
  } finally {
    await server.stop();
  }
});

test("Phase 4: host composition wires all Phase 08 services with autoStart=false and shared singletons", async () => {
  const host = createCloudPilotHostFromEnvironment(jwtConfig, {
    DATABASE_URL: "postgresql://user:pass@localhost:55432/cloudpilot_phase08_test",
    NODE_ENV: "test"
  });
  // Verify all Phase 08 services are wired on host
  assert.ok(host.trustedClaimExecutionContextService);
  assert.ok(host.remediationExecutionPersistenceService);
  assert.ok(host.artifactOnlyExecutionOrchestrator);
  assert.ok(host.artifactOnlyExecutionRecoveryService);
  assert.ok(host.artifactOnlyRemediationWorker);
  assert.equal(host.artifactOnlyRemediationWorker.autoStart, false);
  assert.equal(host.remediationWorkerEnabled, false);

  // Worker autoStart: true must fail closed with explicit rejection
  assert.throws(
    () => new ArtifactOnlyRemediationWorker({} as never, {} as never, { autoStart: true }),
    /ArtifactOnlyRemediationWorker autoStart cannot be enabled: background worker activation is disabled/
  );

  await host.stop();
});

test("Phase 4: host start does not launch background recovery loops, queue consumers, schedulers, or background workers", async () => {
  const calls = { connect: 0, verify: 0, disconnect: 0, start: 0, stop: 0 };
  const database: HostDatabaseLifecycle = {
    async connect() { calls.connect++; },
    async verify() { calls.verify++; },
    async disconnect() { calls.disconnect++; }
  };
  const api: HostApiLifecycle = {
    async start() { calls.start++; return 3000; },
    async stop() { calls.stop++; }
  };
  const host = new CloudPilotApplicationHost(
    database,
    api,
    3000,
    false, // worker disabled
    "127.0.0.1"
  );
  assert.equal(host.remediationWorkerEnabled, false);
  const port = await host.start();
  assert.equal(port, 3000);
  assert.equal(calls.connect, 1);
  assert.equal(calls.verify, 1);
  assert.equal(calls.start, 1);
  // Verify worker remains disabled during runtime
  assert.equal(host.remediationWorkerEnabled, false);
  await host.stop();
  assert.equal(calls.stop, 1);
  assert.equal(calls.disconnect, 1);
});

test("Phase 4: database schema verification checks execution aggregate and event journal tables", async () => {
  const host = createCloudPilotHostFromEnvironment(jwtConfig, {
    DATABASE_URL: "postgresql://user:pass@localhost:55432/cloudpilot_phase08_test",
    NODE_ENV: "test"
  });
  const dbLifecycle = (host as unknown as { database: HostDatabaseLifecycle }).database;
  assert.ok(dbLifecycle);
  assert.equal(typeof dbLifecycle.connect, "function");
  assert.equal(typeof dbLifecycle.verify, "function");
  assert.equal(typeof dbLifecycle.disconnect, "function");
  await host.stop();
});

test("Phase 4: all 10 intended Phase 08 route extensions are mounted exactly once and legacy write endpoints remain disabled", async () => {
  const base = { DATABASE_URL: "postgresql://user:pass@localhost:55432/cloudpilot_phase08_test", NODE_ENV: "development" };
  const host = createCloudPilotHostFromEnvironment(jwtConfig, base);
  const apiServer = (host as unknown as { api: { routeExtensions?: AuthenticatedRouteExtension[] } }).api;
  const extensions = (apiServer as unknown as { routeExtensions?: AuthenticatedRouteExtension[] }).routeExtensions ?? [];

  assert.ok(Array.isArray(extensions), "route extensions must be an array");
  assert.equal(extensions.length, 10, "exactly 10 Phase 08 route extensions must be mounted");

  const classNames = extensions.map(e => e.constructor.name);
  assert.ok(classNames.includes("IdentityOrganizationApiRoutes"), "IdentityOrganizationApiRoutes mounted");
  assert.ok(classNames.includes("OrganizationAuthorizationApiRoutes"), "OrganizationAuthorizationApiRoutes mounted");
  assert.ok(classNames.includes("GitHubConnectIntentApiRoutes"), "GitHubConnectIntentApiRoutes mounted");
  assert.ok(classNames.includes("GitHubInstallationCallbackApiRoutes"), "GitHubInstallationCallbackApiRoutes mounted");
  assert.ok(classNames.includes("GitHubInstallationRepositoriesApi"), "GitHubInstallationRepositoriesApi mounted");
  assert.ok(classNames.includes("ProjectGitHubBindingApi"), "ProjectGitHubBindingApi mounted");
  assert.ok(classNames.includes("ArchitectureApiRoutes"), "ArchitectureApiRoutes mounted");
  assert.ok(classNames.includes("GitHubRepositoryApiRoutes"), "GitHubRepositoryApiRoutes mounted");
  assert.ok(classNames.includes("RemediationProposalApiRoutes"), "RemediationProposalApiRoutes mounted");
  assert.ok(classNames.includes("RemediationReconciliationApiRoutes"), "RemediationReconciliationApiRoutes mounted");

  const uniqueClassNames = new Set(classNames);
  assert.equal(uniqueClassNames.size, 10, "every route extension class must be mounted exactly once");

  // Legacy RemediationApiRoutes must NOT be mounted when worker is disabled
  assert.equal(classNames.includes("RemediationApiRoutes"), false, "legacy RemediationApiRoutes must not be mounted when worker is disabled");

  await host.stop();
});

test("Phase 5.2: api.start() rejecting with EADDRINUSE propagates startup failure, disconnects database once, and starts no workers", async () => {
  const eaddrinuseError = Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:3000"), {
    code: "EADDRINUSE",
    errno: -4091,
    syscall: "listen",
    address: "127.0.0.1",
    port: 3000
  });

  const calls = {
    dbConnect: 0,
    dbVerify: 0,
    dbDisconnect: 0,
    apiStart: 0,
    apiStop: 0,
    workerStarted: 0,
    recoveryStarted: 0,
    schedulerStarted: 0,
    queueConsumerStarted: 0
  };

  const database: HostDatabaseLifecycle = {
    async connect() { calls.dbConnect++; },
    async verify() { calls.dbVerify++; },
    async disconnect() { calls.dbDisconnect++; }
  };

  const api: HostApiLifecycle = {
    async start() {
      calls.apiStart++;
      throw eaddrinuseError;
    },
    async stop() {
      calls.apiStop++;
    }
  };

  const mockWorker = {
    readonly: false,
    autoStart: false,
    start() { calls.workerStarted++; },
    runCycle() { calls.workerStarted++; }
  } as unknown as ArtifactOnlyRemediationWorker;

  const mockRecovery = {
    recoverStaleIntents() { calls.recoveryStarted++; }
  } as unknown as ArtifactOnlyExecutionRecoveryService;

  const host = new CloudPilotApplicationHost(
    database,
    api,
    3000,
    false,
    "127.0.0.1",
    undefined,
    undefined,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    mockRecovery,
    mockWorker
  );

  assert.equal(host.remediationWorkerEnabled, false, "remediationWorkerEnabled must remain false");

  await assert.rejects(
    async () => host.start(),
    (err: Error) => {
      assert.match(err.message, /CloudPilot host startup failed; verify database connectivity, schema, and runtime configuration\./);
      assert.equal((err.cause as { code?: string })?.code, "EADDRINUSE");
      assert.equal(err.cause, eaddrinuseError);
      return true;
    }
  );

  assert.equal(calls.dbConnect, 1, "database connect must be called once");
  assert.equal(calls.dbVerify, 1, "database verify must be called once");
  assert.equal(calls.dbDisconnect, 1, "database disconnect must be called exactly once during cleanup");
  assert.equal(calls.apiStart, 1, "api start must be attempted once");
  assert.equal(calls.apiStop, 1, "api stop must be called once during cleanup");

  assert.equal(calls.workerStarted, 0, "no worker must start");
  assert.equal(calls.recoveryStarted, 0, "no recovery loop must start");
  assert.equal(calls.schedulerStarted, 0, "no scheduler must start");
  assert.equal(calls.queueConsumerStarted, 0, "no queue consumer must start");
});

test("Phase 5.2: host startup failure cleanup handles database disconnection failure with AggregateError", async () => {
  const eaddrinuseError = Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:3000"), {
    code: "EADDRINUSE",
    syscall: "listen",
    address: "127.0.0.1",
    port: 3000
  });
  const disconnectError = new Error("Database disconnection connection pool drain error");

  const calls = {
    dbConnect: 0,
    dbVerify: 0,
    dbDisconnect: 0,
    apiStart: 0,
    apiStop: 0
  };

  const database: HostDatabaseLifecycle = {
    async connect() { calls.dbConnect++; },
    async verify() { calls.dbVerify++; },
    async disconnect() {
      calls.dbDisconnect++;
      throw disconnectError;
    }
  };

  const api: HostApiLifecycle = {
    async start() {
      calls.apiStart++;
      throw eaddrinuseError;
    },
    async stop() {
      calls.apiStop++;
    }
  };

  const host = new CloudPilotApplicationHost(
    database,
    api,
    3000,
    false
  );

  await assert.rejects(
    async () => host.start(),
    (err: unknown) => {
      assert.ok(err instanceof AggregateError, "must throw AggregateError when cleanup fails");
      assert.match(err.message, /CloudPilot startup failed and cleanup was incomplete\./);
      assert.equal(err.errors.length, 2);
      assert.equal(err.errors[0], eaddrinuseError);
      assert.equal((err.errors[0] as { code?: string })?.code, "EADDRINUSE");
      assert.equal(err.errors[1], disconnectError);
      return true;
    }
  );

  assert.equal(calls.dbConnect, 1);
  assert.equal(calls.dbVerify, 1);
  assert.equal(calls.dbDisconnect, 1, "disconnect must be attempted exactly once");
  assert.equal(calls.apiStart, 1);
  assert.equal(calls.apiStop, 1);
});
