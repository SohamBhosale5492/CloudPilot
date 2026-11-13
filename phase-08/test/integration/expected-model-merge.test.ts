import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { parsePhase08AcceptanceDatabase } from "./acceptance-database.js";
import type { AuthenticatedIdentity } from "../../../phase-06/src/auth/jwt-verifier.js";
import type { AuthenticatedRouteContext } from "../../../phase-06/src/api/server.js";
import { ArchitectureApiRoutes, PrismaArchitectureProjectStore } from "../../src/api/architecture-api.js";

const acceptanceDatabase = parsePhase08AcceptanceDatabase(process.env.CLOUDPILOT_PHASE08_ACCEPTANCE_TEST_DATABASE_URL);
const testUrl = acceptanceDatabase?.url ?? process.env.CLOUDPILOT_PHASE08_TEST_DATABASE_URL;
const expectedDatabase = acceptanceDatabase?.database ?? "cloudpilot_phase08_test";
const expectedUsername = acceptanceDatabase?.username ?? "cloudpilot_phase08_test";
const migrationNames = [
  "20261014000000_init", "20261023000000_durable_jobs", "20261023100000_remediation",
  "20261023110000_remediation_composite_fk", "20261030100000_remediation_worker_leases",
  "20261030110000_remediation_lease_token", "20261101120000_saas_identity_organizations",
  "20261101130000_phase06_scan_lease_token", "20261101140000_organization_project_ownership_foundation",
  "20261105120000_github_integration_persistence", "20261105150000_remediation_approval_foundation",
  "20261105160000_remediation_execution_artifact", "20261106120000_remediation_execution_persistence",
  "20261107130000_system_recovery_lease", "20261108120000_remote_mutation_rejected",
  "20261109120000_remediation_execution_retry",
  "20261110120000_allow_mutation_rejection_resource_type",
  "20261111120000_runtime_lock_helpers"
];

function validateTestUrl(value: string | undefined): asserts value is string {
  if (!value) throw new Error("CLOUDPILOT_PHASE08_TEST_DATABASE_URL is required.");
  if (acceptanceDatabase) {
    if (value !== acceptanceDatabase.url) throw new Error("Refusing a database URL different from the validated acceptance target.");
    return;
  }
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
      url.port !== "56432" || decodeURIComponent(url.pathname.slice(1)) !== "cloudpilot_phase08_test") {
    throw new Error("Refusing merge integration test outside loopback:56432/cloudpilot_phase08_test.");
  }
}

function context(method: string, pathname: string, identity: AuthenticatedIdentity, body: unknown) {
  const parsed = new URL(pathname, "http://localhost");
  const response: { status?: number; body?: unknown } = {};
  const value = {
    req: {} as AuthenticatedRouteContext["req"], res: {} as AuthenticatedRouteContext["res"],
    method, pathname: parsed.pathname, url: parsed, identity,
    parseJsonBody: async () => body,
    sendJson: (status: number, result: unknown) => { response.status = status; response.body = result; }
  } satisfies AuthenticatedRouteContext;
  return { context: value, response };
}

test("expected-model merge persists atomically with audit and enforces stale-write and tenant boundaries", {
  skip: !testUrl ? "requires explicit CLOUDPILOT_PHASE08_TEST_DATABASE_URL" : false
}, async (t) => {
  validateTestUrl(testUrl);
  const prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
  await prisma.$connect();
  const identity = await prisma.$queryRaw<Array<{ name: string; user: string }>>`SELECT current_database() AS name, current_user AS user`;
  assert.equal(identity[0]?.name, expectedDatabase);
  assert.equal(identity[0]?.user, expectedUsername);
  const migrations = await prisma.$queryRaw<Array<{ migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null }>>`
    SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name
  `;
  assert.deepEqual(migrations.map((row) => row.migration_name), migrationNames);
  assert.ok(migrations.every((row) => row.finished_at && !row.rolled_back_at));
  for (const name of migrationNames) {
    const sql = await readFile(`prisma/migrations/${name}/migration.sql`);
    assert.equal(migrations.find((row) => row.migration_name === name)?.checksum, createHash("sha256").update(sql).digest("hex"));
  }

  const tenantId = randomUUID();
  const projectId = randomUUID();
  const userId = randomUUID();
  const baseModel = { schemaVersion: "cloudpilot.expected-observability.v1", serviceId: "demo-service", requirements: [
    { id: "existing-trace", signal: "trace", serviceName: "demo-service" }
  ] };
  await prisma.tenant.create({ data: { id: tenantId, name: `merge-fixture-${tenantId}` } });
  await prisma.project.create({ data: { id: projectId, tenantId, name: `merge-fixture-${projectId}`, expectedModel: baseModel } });
  t.after(async () => {
    const beforeCleanup = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    assert.equal(beforeCleanup[0]?.name, expectedDatabase);
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  const store = new PrismaArchitectureProjectStore(prisma);
  const routes = new ArchitectureApiRoutes(store);
  const identityFor = (tenant: string, role: "admin" | "viewer" = "admin"): AuthenticatedIdentity =>
    ({ tenantId: tenant, userId, roles: [role] });
  const path = `/api/v1/projects/${projectId}/expected-model/merge`;
  const added = { id: "request-rate", signal: "metric", metricName: "demo_http_server_requests_total", dimensions: ["route"] };
  const merged = { ...baseModel, requirements: [...baseModel.requirements, added] };

  const success = context("POST", path, identityFor(tenantId), { expectedCurrentModel: baseModel, expectedModel: merged });
  await routes.handle(success.context);
  assert.equal(success.response.status, 200);
  assert.deepEqual(await prisma.project.findFirstOrThrow({ where: { id: projectId, tenantId } }).then((row) => row.expectedModel), merged);
  assert.equal(await prisma.auditEvent.count({ where: { tenantId, projectId, action: "PROJECT_EXPECTED_MODEL_UPDATED" } }), 1);

  const stale = context("POST", path, identityFor(tenantId), { expectedCurrentModel: baseModel, expectedModel: baseModel });
  await routes.handle(stale.context);
  assert.equal(stale.response.status, 409);
  assert.deepEqual((await prisma.project.findFirstOrThrow({ where: { id: projectId, tenantId } })).expectedModel, merged);

  const concurrentModels = ["parallel-a", "parallel-b"].map((id) => ({
    ...merged, requirements: [...merged.requirements, { id, signal: "metric", metricName: `${id}_total`, dimensions: [] }]
  }));
  const concurrent = await Promise.all(concurrentModels.map(async (model) => {
    const req = context("POST", path, identityFor(tenantId), { expectedCurrentModel: merged, expectedModel: model });
    await routes.handle(req.context);
    return req.response.status;
  }));
  assert.deepEqual(concurrent.sort(), [200, 409]);
  assert.equal(await prisma.auditEvent.count({ where: { tenantId, projectId, action: "PROJECT_EXPECTED_MODEL_UPDATED" } }), 2);

  const foreign = context("POST", path, identityFor(randomUUID()), { expectedCurrentModel: merged, expectedModel: merged });
  await routes.handle(foreign.context);
  assert.equal(foreign.response.status, 404);
  const viewer = context("POST", path, identityFor(tenantId, "viewer"), { expectedCurrentModel: merged, expectedModel: merged });
  await routes.handle(viewer.context);
  assert.equal(viewer.response.status, 403);

  const beforeFailedAudit = await prisma.project.findFirstOrThrow({ where: { id: projectId, tenantId } });
  const failingClient = {
    $transaction: (operation: (tx: unknown) => Promise<unknown>) => prisma.$transaction((tx) => operation({
      $executeRaw: tx.$executeRaw.bind(tx),
      auditEvent: { create: async () => { throw new Error("injected audit failure"); } }
    }))
  } as unknown as PrismaClient;
  const failingStore = new PrismaArchitectureProjectStore(failingClient);
  const failedModel = { ...beforeFailedAudit.expectedModel as object, failedAudit: true };
  await assert.rejects(failingStore.mergeExpectedModel(tenantId, projectId, userId, beforeFailedAudit.expectedModel, failedModel as never), /injected audit failure/);
  assert.deepEqual((await prisma.project.findFirstOrThrow({ where: { id: projectId, tenantId } })).expectedModel, beforeFailedAudit.expectedModel);
  assert.equal(await prisma.auditEvent.count({ where: { tenantId, projectId, action: "PROJECT_EXPECTED_MODEL_UPDATED" } }), 2);
});
