import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  RemediationJobRepository
} from "../../src/jobs/remediation-repo.js";

const explicitTestDatabaseUrl = process.env.CLOUDPILOT_PHASE08_TEST_DATABASE_URL;
function isDedicatedTestDatabase(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return ["postgres:", "postgresql:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost"].includes(url.hostname) && url.port === "56432" &&
      decodeURIComponent(url.username) === "cloudpilot_phase08_test" &&
      decodeURIComponent(url.pathname.replace(/^\//, "")) === "cloudpilot_phase08_test" && !url.hash &&
      ![...url.searchParams.keys()].some((key) => ["host", "hostaddr", "port", "dbname", "database", "user", "username"].includes(key.toLowerCase()));
  } catch {
    return false;
  }
}

const safeDatabaseConfigured = isDedicatedTestDatabase(explicitTestDatabaseUrl);
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
  "20261110120000_allow_mutation_rejection_resource_type"
];

async function seedTenant(prisma: PrismaClient): Promise<{ tenantId: string; projectId: string; scanId: string }> {
  const tenantId = randomUUID();
  const projectId = randomUUID();
  const scanId = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO tenants (id, name, created_at)
    VALUES (${tenantId}, 'phase08-worker-test', NOW());
  `;
  await prisma.$executeRaw`
    INSERT INTO projects (id, tenant_id, name, repository_url, created_at, updated_at)
    VALUES (${projectId}, ${tenantId}, ${`worker-test-${projectId}`}, 'https://github.com/example/repo', NOW(), NOW());
  `;
  await prisma.$executeRaw`
    INSERT INTO scans (id, tenant_id, project_id, status, created_at)
    VALUES (${scanId}, ${tenantId}, ${projectId}, 'completed', NOW());
  `;
  return { tenantId, projectId, scanId };
}

async function seedRemediation(
  prisma: PrismaClient,
  fixture: { tenantId: string; projectId: string; scanId: string },
  retriesLeft: number
): Promise<string> {
  const findingId = randomUUID();
  const remediationId = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO findings (
      id, tenant_id, project_id, scan_id, requirement_id, rule_id, rule_version,
      signal, outcome, expected, observed, reason, evidence_json, created_at
    ) VALUES (
      ${findingId}, ${fixture.tenantId}, ${fixture.projectId}, ${fixture.scanId},
      ${`requirement-${findingId}`}, 'rule.metric.present', '1.0.0',
      'metric', 'gap', 'metric exists', 'metric missing', 'test fixture', '{}'::jsonb, NOW()
    );
  `;
  await prisma.$executeRaw`
    INSERT INTO remediations (
      id, tenant_id, project_id, scan_id, finding_id, idempotency_key,
      status, retries_left, created_at, updated_at
    ) VALUES (
      ${remediationId}, ${fixture.tenantId}, ${fixture.projectId}, ${fixture.scanId},
      ${findingId}, ${`worker-test-${remediationId}`}, 'pending', ${retriesLeft}, NOW(), NOW()
    );
  `;
  return remediationId;
}

test("legacy PostgreSQL queue rows cannot be claimed without the durable execution lifecycle", {
  skip: safeDatabaseConfigured ? false : "requires CLOUDPILOT_PHASE08_TEST_DATABASE_URL pointing to cloudpilot_phase08_test"
}, async (t) => {
  const prisma = new PrismaClient({
    datasources: { db: { url: explicitTestDatabaseUrl! } }
  });
  await prisma.$connect();
  const repository = new RemediationJobRepository(prisma);
  const tenants: string[] = [];

  t.after(async () => {
    for (const tenantId of tenants) {
      await prisma.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId};`;
    }
    await prisma.$disconnect();
  });

  try {
    const database = await prisma.$queryRaw<Array<{ name: string; user: string }>>`SELECT current_database() AS name, current_user AS user;`;
    assert.equal(database[0]?.name, "cloudpilot_phase08_test");
    assert.equal(database[0]?.user, "cloudpilot_phase08_test");
    const migrations = await prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>>`
      SELECT migration_name, finished_at, rolled_back_at
      FROM "_prisma_migrations"
      ORDER BY migration_name;
    `;
    assert.deepEqual(migrations.map((row) => row.migration_name), CANONICAL_MIGRATIONS);
    assert.ok(migrations.every((row) => row.finished_at !== null && row.rolled_back_at === null));
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'remediations'
        AND column_name IN ('lease_token', 'worker_id', 'lease_expires_at', 'next_attempt_at');
    `;
    assert.deepEqual(
      new Set(columns.map((row) => row.column_name)),
      new Set(["lease_token", "worker_id", "lease_expires_at", "next_attempt_at"])
    );

    const fixtureA = await seedTenant(prisma);
    const fixtureB = await seedTenant(prisma);
    tenants.push(fixtureA.tenantId, fixtureB.tenantId);
    const legacyJobIds = [
      await seedRemediation(prisma, fixtureA, 3),
      await seedRemediation(prisma, fixtureA, 0),
      await seedRemediation(prisma, fixtureB, 3)
    ];

    await assert.rejects(repository.claimNextPending("legacy-integration-worker"),
      /Durable remediation execution lifecycle is required/,
      "the legacy queue repository must refuse to claim without the authoritative lifecycle");
    const rows = await prisma.remediation.findMany({
      where: { id: { in: legacyJobIds } },
      select: { id: true, tenantId: true, status: true, workerId: true, leaseToken: true, retriesLeft: true }
    });
    assert.equal(rows.length, legacyJobIds.length);
    assert.ok(rows.every((row) => row.status === "pending" && row.workerId === null && row.leaseToken === null),
      "a rejected legacy claim must not mutate queue state or acquire a lease");
    assert.equal(await prisma.remediationExecution.count({ where: { remediationId: { in: legacyJobIds } } }), 0,
      "legacy rows must not create authoritative execution aggregates implicitly");
  } finally {
    // The after hook removes only the UUID-scoped fixture tenants created here.
  }
});
