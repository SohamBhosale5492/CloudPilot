import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { CloudPilotApiServer } from "../../../phase-06/src/api/server.js";
import { BoundedScanRunner } from "../../../phase-06/src/jobs/scan-runner.js";
import { RemediationApiRoutes } from "../../src/api/remediation-api.js";
import { RemediationApiRepository } from "../../src/api/remediation-api-repo.js";
import { createCloudPilotHostFromEnvironment } from "../../src/host.js";
import { parsePhase08AcceptanceDatabase } from "./acceptance-database.js";
import { buildIdempotencyKey } from "../../../phase-07/src/remediation/planner.js";
import {
  mintTestJwt,
  TEST_ISSUER,
  TEST_AUDIENCE,
  TEST_PUBLIC_KEY
} from "../../../phase-06/test/jwt-signer.js";

const acceptanceDatabase = parsePhase08AcceptanceDatabase(process.env.CLOUDPILOT_PHASE08_ACCEPTANCE_TEST_DATABASE_URL);
const testUrl = acceptanceDatabase?.url ?? process.env.CLOUDPILOT_PHASE08_TEST_DATABASE_URL;
const expectedDatabase = acceptanceDatabase?.database ?? "cloudpilot_phase08_test";
const expectedUsername = acceptanceDatabase?.username ?? "cloudpilot_phase08_test";
function pointsToDedicatedDatabase(value: string | undefined): boolean {
  if (!value) return false;
  if (acceptanceDatabase) return value === acceptanceDatabase.url;
  try {
    const url = new URL(value);
    return ["postgres:", "postgresql:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost"].includes(url.hostname) && url.port === "56432" &&
      decodeURIComponent(url.username) === "cloudpilot_phase08_test" &&
      decodeURIComponent(url.pathname.replace(/^\//, "")) === "cloudpilot_phase08_test" && !url.hash &&
      ![...url.searchParams.keys()].some((key) => ["host", "hostaddr", "port", "dbname", "database", "user", "username"].includes(key.toLowerCase()));
  }
  catch { return false; }
}

const isolated = pointsToDedicatedDatabase(testUrl);
const CANONICAL_MIGRATIONS = [
  "20261014000000_init",
  "20261023000000_durable_jobs",
  "20261023100000_remediation",
  "20261023110000_remediation_composite_fk",
  "20261030100000_remediation_worker_leases",
  "20261030110000_remediation_lease_token",
  "20261101120000_saas_identity_organizations",
  "20261101130000_phase06_scan_lease_token",
  "20261101140000_organization_project_ownership_foundation",
  "20261105120000_github_integration_persistence",
  "20261105150000_remediation_approval_foundation",
  "20261105160000_remediation_execution_artifact",
  "20261106120000_remediation_execution_persistence",
  "20261107130000_system_recovery_lease",
  "20261108120000_remote_mutation_rejected",
  "20261109120000_remediation_execution_retry",
  "20261110120000_allow_mutation_rejection_resource_type",
  "20261111120000_runtime_lock_helpers"
];

test("Phase 08 remediation API legacy rejection, authorization, tenant scope and read behavior", {
  skip: isolated ? false : "requires CLOUDPILOT_PHASE08_TEST_DATABASE_URL for cloudpilot_phase08_test"
}, async (t) => {
  const prisma = new PrismaClient({ datasources: { db: { url: testUrl! } } });
  await prisma.$connect();
  const database = await prisma.$queryRaw<Array<{ name: string; user: string }>>`SELECT current_database() AS name, current_user AS user`;
  assert.equal(database[0]?.name, expectedDatabase);
  assert.equal(database[0]?.user, expectedUsername);
  const migrations = await prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>>`
    SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name
  `;
  assert.deepEqual(migrations.map((row) => row.migration_name), CANONICAL_MIGRATIONS);
  assert.ok(migrations.every((row) => row.finished_at !== null && row.rolled_back_at === null));

  const tenantIds: string[] = [];
  t.after(async () => {
    const beforeCleanup = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    assert.equal(beforeCleanup[0]?.name, expectedDatabase, "refuse fixture cleanup outside dedicated database");
    for (const tenantId of tenantIds) {
      await prisma.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
    }
    await prisma.$disconnect();
  });

  await t.test("host composes the approved-artifact worker only after explicit opt-in and serves normally while disabled", async () => {
    assert.equal(await prisma.remediation.count(), 0, "refuse to start the worker when unrelated jobs exist in the test database");
    const jwtConfig = {
      expectedIssuer: TEST_ISSUER,
      expectedAudience: TEST_AUDIENCE,
      publicKeyOrSecret: TEST_PUBLIC_KEY,
      allowedAlgorithms: ["RS256"]
    };
    const explicitlyEnabledHost = createCloudPilotHostFromEnvironment(jwtConfig, {
      DATABASE_URL: testUrl,
      NODE_ENV: "test",
      CLOUDPILOT_ENABLE_REMEDIATION_WORKER: "true",
      PORT: "0"
    });
    assert.equal(explicitlyEnabledHost.remediationWorkerEnabled, true);
    assert.ok(explicitlyEnabledHost.artifactOnlyRemediationWorker);
    await explicitlyEnabledHost.stop();
    const host = createCloudPilotHostFromEnvironment(jwtConfig, {
      DATABASE_URL: testUrl, NODE_ENV: "test", CLOUDPILOT_ENABLE_REMEDIATION_WORKER: "false", PORT: "0"
    });
    const ports = await Promise.all([host.start(), host.start()]);
    assert.equal(ports[0], ports[1], "concurrent startup requests share one server and worker initialization");
    try {
      const health = await fetch(`http://127.0.0.1:${ports[0]}/health/liveness`);
      assert.equal(health.status, 200);
    } finally {
      await Promise.all([host.stop(), host.stop()]);
    }
  });

  async function seedTenant(name: string, repositoryUrl: string | null) {
    const tenantId = randomUUID();
    const projectId = randomUUID();
    const scanId = randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.tenant.create({ data: { id: tenantId, name } });
      await tx.project.create({ data: { id: projectId, tenantId, name: `${name}-project`, repositoryUrl } });
      await tx.scan.create({ data: { id: scanId, tenantId, projectId, status: "completed" } });
    });
    tenantIds.push(tenantId);
    return { tenantId, projectId, scanId };
  }

  async function seedFinding(
    fixture: { tenantId: string; projectId: string; scanId: string },
    signal = "metric",
    outcome = "gap"
  ) {
    const id = randomUUID();
    const ruleId = `rule.${signal}.${id}`;
    const ruleVersion = "1.0.0";
    await prisma.finding.create({
      data: {
        id, tenantId: fixture.tenantId, projectId: fixture.projectId, scanId: fixture.scanId,
        requirementId: `req-${id}`, ruleId, ruleVersion, signal, outcome,
        expected: "expected", observed: "observed", reason: "test fixture", evidenceJson: {}
      }
    });
    return { id, ruleId, ruleVersion };
  }

  async function seedExisting(
    fixture: { tenantId: string; projectId: string; scanId: string },
    status: string,
    extras: Record<string, unknown> = {}
  ) {
    const finding = await seedFinding(fixture);
    const id = randomUUID();
    await prisma.remediation.create({
      data: {
        id, tenantId: fixture.tenantId, projectId: fixture.projectId, scanId: fixture.scanId,
        findingId: finding.id,
        idempotencyKey: buildIdempotencyKey(fixture.tenantId, finding.id, finding.ruleId, finding.ruleVersion),
        status, ...extras
      }
    });
    return { id, finding };
  }

  const alpha = await seedTenant("phase08-api-alpha", "https://github.com/example/remediation-test");
  const beta = await seedTenant("phase08-api-beta", "https://github.com/example/other-test");
  const primaryFinding = await seedFinding(alpha);
  const traceFinding = await seedFinding(alpha, "trace", "gap");
  const logFinding = await seedFinding(alpha, "log", "gap");
  const healthFinding = await seedFinding(alpha, "health", "gap");
  const alertFinding = await seedFinding(alpha, "alert", "gap");
  const passingFinding = await seedFinding(alpha, "metric", "pass");
  const invalidRepo = await seedTenant("phase08-api-invalid-repo", "http://github.com/example/repo");
  const invalidRepoFinding = await seedFinding(invalidRepo);

  const existingByStatus = new Map<string, { id: string; finding: { id: string } }>();
  for (const status of ["pending", "running", "open", "merged", "failed", "closed"]) {
    existingByStatus.set(status, await seedExisting(alpha, status));
  }
  const failedForRetrigger = await seedExisting(alpha, "failed", {
    retriesLeft: 0,
    errorMessage: "old failure",
    workerId: "stale-worker",
    leaseToken: randomUUID(),
    claimedAt: new Date(),
    heartbeatAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 60_000),
    nextAttemptAt: new Date(Date.now() + 60_000)
  });

  const apiRepository = new RemediationApiRepository(prisma);
  const schedulerCalls: number[] = [];
  const routes = new RemediationApiRoutes(apiRepository, { triggerPoll: () => schedulerCalls.push(Date.now()) });
  const server = new CloudPilotApiServer({
    prisma,
    jwtConfig: {
      expectedIssuer: TEST_ISSUER,
      expectedAudience: TEST_AUDIENCE,
      publicKeyOrSecret: TEST_PUBLIC_KEY,
      allowedAlgorithms: ["RS256"]
    },
    scanRunner: new BoundedScanRunner(prisma, { pollIntervalMs: 60_000, reaperIntervalMs: 60_000 }),
    routeExtensions: [routes]
  });
  const port = await server.start(0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = (tenantId: string, role: "admin" | "operator" | "viewer") => mintTestJwt({
    sub: `api-${role}-${tenantId}`, tenantId, roles: [role]
  });
  const headers = (jwt: string) => ({ Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" });

  try {
    await t.test("legacy creation is forbidden to viewers and rejected for authorized operators", async () => {
      const viewer = await fetch(`${baseUrl}/api/v1/projects/${alpha.projectId}/remediations`, {
        method: "POST", headers: headers(token(alpha.tenantId, "viewer")),
        body: JSON.stringify({ findingId: primaryFinding.id })
      });
      assert.equal(viewer.status, 403);

      for (const role of ["operator", "admin"] as const) {
        const response = await fetch(`${baseUrl}/api/v1/projects/${alpha.projectId}/remediations`, {
          method: "POST", headers: headers(token(alpha.tenantId, role)),
          body: JSON.stringify({ findingId: primaryFinding.id, idempotencyKey: `legacy-${role}` })
        });
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), {
          error: "Legacy remediation creation is disabled. Create and approve a remediation proposal instead."
        });
      }

      assert.equal(await prisma.remediation.count({
        where: { tenantId: alpha.tenantId, findingId: primaryFinding.id }
      }), 0, "rejected legacy requests must not create remediation rows");
      assert.equal(schedulerCalls.length, 0, "rejected legacy requests must not signal the scheduler");
    });

    await t.test("concurrent legacy creation requests are rejected without side effects", async () => {
      const responses = await Promise.all(["client-key-b", "client-key-c"].map((key) => fetch(
        `${baseUrl}/api/v1/projects/${alpha.projectId}/remediations`, {
          method: "POST", headers: headers(token(alpha.tenantId, "admin")),
          body: JSON.stringify({ findingId: primaryFinding.id, idempotencyKey: key })
        }
      )));

      assert.deepEqual(responses.map((response) => response.status), [409, 409]);
      for (const response of responses) {
        assert.deepEqual(await response.json(), {
          error: "Legacy remediation creation is disabled. Create and approve a remediation proposal instead."
        });
      }
      assert.equal(await prisma.remediation.count({
        where: { tenantId: alpha.tenantId, findingId: primaryFinding.id }
      }), 0);
      assert.equal(await prisma.remediationExecution.count({ where: { tenantId: alpha.tenantId } }), 0,
        "legacy creation must not fabricate authoritative executions");
      assert.equal(schedulerCalls.length, 0);
    });

    await t.test("legacy creation rejects every existing remediation status without changing records", async () => {
      for (const [status, fixture] of existingByStatus) {
        const before = await prisma.remediation.findFirstOrThrow({ where: { id: fixture.id, tenantId: alpha.tenantId } });
        const response = await fetch(`${baseUrl}/api/v1/projects/${alpha.projectId}/remediations`, {
          method: "POST", headers: headers(token(alpha.tenantId, "operator")),
          body: JSON.stringify({ findingId: fixture.finding.id })
        });
        assert.equal(response.status, 409, `${status} status must not bypass the legacy-route rejection`);
        assert.deepEqual(await response.json(), {
          error: "Legacy remediation creation is disabled. Create and approve a remediation proposal instead."
        });
        const after = await prisma.remediation.findFirstOrThrow({ where: { id: fixture.id, tenantId: alpha.tenantId } });
        assert.deepEqual(after, before, `${status} remediation must remain unchanged`);
      }
      assert.equal(schedulerCalls.length, 0);
    });

    await t.test("legacy creation rejects requests regardless of finding eligibility or repository URL", async () => {
      const requests = [
        { projectId: alpha.projectId, findingId: traceFinding.id },
        { projectId: alpha.projectId, findingId: logFinding.id },
        { projectId: alpha.projectId, findingId: passingFinding.id },
        { projectId: invalidRepo.projectId, findingId: invalidRepoFinding.id, findingTenant: invalidRepo.tenantId },
        { projectId: alpha.projectId, findingId: healthFinding.id },
        { projectId: alpha.projectId, findingId: alertFinding.id }
      ];

      for (const item of requests) {
        const response = await fetch(`${baseUrl}/api/v1/projects/${item.projectId}/remediations`, {
          method: "POST",
          headers: headers(token((item as { findingTenant?: string }).findingTenant ?? alpha.tenantId, "admin")),
          body: JSON.stringify({ findingId: item.findingId })
        });
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), {
          error: "Legacy remediation creation is disabled. Create and approve a remediation proposal instead."
        });
      }

      for (const findingId of [traceFinding.id, logFinding.id, passingFinding.id, invalidRepoFinding.id, healthFinding.id, alertFinding.id]) {
        const count = await prisma.remediation.count({ where: { findingId } });
        assert.equal(count, 0, `legacy endpoint must not create a remediation for finding ${findingId}`);
      }
      assert.equal(schedulerCalls.length, 0);
    });

    await t.test("get and list enforce tenant scope and read roles", async () => {
      const pendingFixture = existingByStatus.get("pending")!;
      const record = await prisma.remediation.findFirstOrThrow({
        where: { id: pendingFixture.id, tenantId: alpha.tenantId }
      });
      const viewer = await fetch(`${baseUrl}/api/v1/remediations/${record.id}`, { headers: headers(token(alpha.tenantId, "viewer")) });
      assert.equal(viewer.status, 200);
      const crossTenant = await fetch(`${baseUrl}/api/v1/remediations/${record.id}`, { headers: headers(token(beta.tenantId, "admin")) });
      assert.equal(crossTenant.status, 404);
      const wrongProjectTenant = await fetch(`${baseUrl}/api/v1/projects/${alpha.projectId}/remediations`, { headers: headers(token(beta.tenantId, "admin")) });
      assert.equal(wrongProjectTenant.status, 404);

      const page = await fetch(`${baseUrl}/api/v1/projects/${alpha.projectId}/remediations?limit=2`, { headers: headers(token(alpha.tenantId, "viewer")) });
      assert.equal(page.status, 200);
      const pageBody = await page.json() as { items: unknown[]; nextCursor?: string; hasMore: boolean };
      assert.equal(pageBody.items.length, 2);
      assert.equal(pageBody.hasMore, true);
      assert.ok(pageBody.nextCursor);
      const next = await fetch(`${baseUrl}/api/v1/projects/${alpha.projectId}/remediations?limit=2&cursor=${pageBody.nextCursor}`, { headers: headers(token(alpha.tenantId, "admin")) });
      assert.equal(next.status, 200);
      assert.equal((await next.json() as { items: unknown[] }).items.length, 2);
      for (const query of ["limit=101", "limit=0", "cursor=missing-cursor", "limit=1&limit=2"]) {
        const invalid = await fetch(`${baseUrl}/api/v1/projects/${alpha.projectId}/remediations?${query}`, { headers: headers(token(alpha.tenantId, "admin")) });
        assert.equal(invalid.status, 400, query);
      }
    });

    await t.test("legacy retrigger requests are rejected without changing remediation state", async () => {
      const before = await prisma.remediation.findFirstOrThrow({
        where: { id: failedForRetrigger.id, tenantId: alpha.tenantId }
      });
      const url = `${baseUrl}/api/v1/remediations/${failedForRetrigger.id}/retrigger`;
      const viewer = await fetch(url, {
        method: "POST", headers: headers(token(alpha.tenantId, "viewer")), body: "{}"
      });
      assert.equal(viewer.status, 403, "viewers must not reach the legacy retrigger rejection path");

      const responses = await Promise.all(["admin", "operator"].map((role) => fetch(url, {
        method: "POST", headers: headers(token(alpha.tenantId, role as "admin" | "operator")), body: "{}"
      })));
      assert.deepEqual(responses.map((response) => response.status), [409, 409]);
      for (const response of responses) {
        assert.deepEqual(await response.json(), {
          error: "Legacy remediation retriggering is disabled. Create and approve a remediation proposal instead."
        });
      }

      const after = await prisma.remediation.findFirstOrThrow({
        where: { id: failedForRetrigger.id, tenantId: alpha.tenantId }
      });
      assert.deepEqual(after, before, "rejected retrigger requests must not mutate the remediation projection");
      assert.equal(await prisma.auditEvent.count({
        where: { tenantId: alpha.tenantId, resourceId: failedForRetrigger.id, action: "REMEDIATION_RETRIGGERED" }
      }), 0, "rejected retrigger requests must not write retrigger audit events");
      assert.equal(schedulerCalls.length, 0);
    });

    await t.test("legacy creation and retrigger never create jobs, executions, or scheduling signals", async () => {
      assert.equal(schedulerCalls.length, 0, "legacy endpoints must never signal scheduling");
      assert.equal(await prisma.remediation.count({
        where: { tenantId: alpha.tenantId, findingId: primaryFinding.id }
      }), 0, "legacy creation must not create a queue projection");
      assert.equal(await prisma.remediationExecution.count({ where: { tenantId: alpha.tenantId } }), 0,
        "legacy endpoints must not fabricate authoritative executions");
      assert.equal(await prisma.auditEvent.count({
        where: { tenantId: alpha.tenantId, action: { in: ["REMEDIATION_REQUESTED", "REMEDIATION_RETRIGGERED"] } }
      }), 0, "rejected legacy endpoints must not write creation or retrigger audit events");
    });
  } finally {
    await server.stop();
  }
});
