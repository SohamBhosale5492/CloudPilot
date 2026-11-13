import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  INTEGRATION_TEST_DATABASE,
  INTEGRATION_TEST_HOST,
  INTEGRATION_TEST_PORT,
  requireIntegrationDatabaseUrl,
  requireIntegrationFixtureDatabaseUrl
} from "../../../test-support/integration-database.js";

const validRuntimeUrl = "postgresql://cloudpilot_runtime:synthetic@127.0.0.1:56440/cloudpilot_runtime_role_test";

test("integration database validator accepts only the authorized loopback target and role", () => {
  assert.equal(INTEGRATION_TEST_HOST, "127.0.0.1");
  assert.equal(INTEGRATION_TEST_PORT, "56440");
  assert.equal(INTEGRATION_TEST_DATABASE, "cloudpilot_runtime_role_test");
  assert.equal(requireIntegrationDatabaseUrl(validRuntimeUrl, "TEST_DATABASE_URL", "cloudpilot_runtime"), validRuntimeUrl);
  assert.throws(() => requireIntegrationDatabaseUrl(undefined, "TEST_DATABASE_URL", "cloudpilot_runtime"), /required/);
  assert.throws(() => requireIntegrationDatabaseUrl("not-a-url", "TEST_DATABASE_URL", "cloudpilot_runtime"), /valid PostgreSQL URL/);
  assert.throws(() => requireIntegrationDatabaseUrl(validRuntimeUrl.replace(":56440/", ":5432/"), "TEST_DATABASE_URL", "cloudpilot_runtime"));
  assert.throws(() => requireIntegrationDatabaseUrl(validRuntimeUrl.replace(":56440/", ":55433/"), "TEST_DATABASE_URL", "cloudpilot_runtime"));
  for (let port = 56432; port <= 56439; port += 1) {
    assert.throws(() => requireIntegrationDatabaseUrl(validRuntimeUrl.replace(":56440/", `:${port}/`), "TEST_DATABASE_URL", "cloudpilot_runtime"));
  }
  assert.throws(() => requireIntegrationDatabaseUrl(validRuntimeUrl.replace("127.0.0.1", "db.example.invalid"), "TEST_DATABASE_URL", "cloudpilot_runtime"));
  assert.throws(() => requireIntegrationDatabaseUrl(validRuntimeUrl.replace("cloudpilot_runtime_role_test", "cloudpilot_test"), "TEST_DATABASE_URL", "cloudpilot_runtime"));
  assert.throws(() => requireIntegrationDatabaseUrl(validRuntimeUrl.replace("cloudpilot_runtime:", "cloudpilot_migrator:"), "TEST_DATABASE_URL", "cloudpilot_runtime"));
  assert.throws(() => requireIntegrationDatabaseUrl(`${validRuntimeUrl}?host=remote.example`, "TEST_DATABASE_URL", "cloudpilot_runtime"));
});

test("legacy fixture suites require an explicit CRUD-only test role without falling back to runtime", async () => {
  const fixtureUrl = "postgresql://cloudpilot_integration_test:synthetic@127.0.0.1:56440/cloudpilot_runtime_role_test";
  assert.equal(requireIntegrationFixtureDatabaseUrl(fixtureUrl), fixtureUrl);
  assert.throws(() => requireIntegrationFixtureDatabaseUrl(undefined), /CLOUDPILOT_FIXTURE_TEST_DATABASE_URL is required/);
  assert.throws(() => requireIntegrationFixtureDatabaseUrl(validRuntimeUrl), /must target cloudpilot_integration_test/);
  assert.throws(() => requireIntegrationFixtureDatabaseUrl(fixtureUrl.replace(":56440/", ":5432/")));
  assert.throws(() => requireIntegrationFixtureDatabaseUrl(fixtureUrl.replace("127.0.0.1", "db.example.invalid")));
  assert.throws(() => requireIntegrationFixtureDatabaseUrl(fixtureUrl.replace("cloudpilot_runtime_role_test", "cloudpilot_test")));
  const repoRoot = path.resolve(process.cwd(), "..");
  const grantSql = await readFile(path.join(repoRoot, "phase-08/scripts/grant-integration-fixture-role.sql"), "utf8");
  assert.match(grantSql, /current_database\(\) <> 'cloudpilot_runtime_role_test'/);
  assert.match(grantSql, /cloudpilot_integration_test/);
  assert.doesNotMatch(grantSql, /^\s*GRANT\s+.*\bcloudpilot_runtime\b/gim, "fixture grants must not broaden runtime permissions");
  assert.doesNotMatch(grantSql, /TRUNCATE|ALTER\s+TABLE|DISABLE\s+TRIGGER/i);
});

test("normal integration package commands do not invoke migration or database reset", async () => {
  const repoRoot = path.resolve(process.cwd(), "..");
  for (const phase of ["phase-06", "phase-07", "phase-08"]) {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, phase, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const integrationCommand = packageJson.scripts["test:integration"] ?? "";
    assert.doesNotMatch(integrationCommand, /migrate|db\s+push|reset|truncate/i, `${phase} integration script must not alter schema or reset data`);
  }
});

test("Phase 06 and 07 fixture cleanup is scoped to IDs created by each test run", async () => {
  const repoRoot = path.resolve(process.cwd(), "..");
  const phase06 = await readFile(path.join(repoRoot, "phase-06/test/integration/api.test.ts"), "utf8");
  const phase07 = await readFile(path.join(repoRoot, "phase-07/test/integration/remediation.test.ts"), "utf8");
  assert.match(phase06, /cleanupTestOwnedFixtures\(prisma, tenantIds\)/);
  assert.doesNotMatch(phase06, /deleteMany\(\s*\{\s*\}\s*\)/, "Phase 06 must not perform an unscoped deleteMany");
  assert.match(phase07, /if \(prisma && fixtureTenantIds\.length > 0\)/);
  assert.match(phase07, /tenantId:\s*\{\s*in:\s*ownedTenants\s*\}/);
  assert.doesNotMatch(phase07, /process\.env\.DATABASE_URL\s*\?\?/);
});
