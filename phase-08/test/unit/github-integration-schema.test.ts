import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const schemaPath = path.join(process.cwd(), "prisma", "schema.prisma");
const migrationPath = path.join(process.cwd(), "prisma", "migrations", "20261105120000_github_integration_persistence", "migration.sql");

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function checkExpression(sql: string, name: string): string {
  const marker = `CONSTRAINT "${name}" CHECK (`;
  const at = sql.indexOf(marker);
  assert.notEqual(at, -1, `missing CHECK ${name}`);
  const start = at + marker.length - 1;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = start; index < sql.length; index += 1) {
    const char = sql[index];
    if (quote) {
      if (char === quote) {
        if (sql[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return sql.slice(start + 1, index);
  }
  assert.fail(`unterminated CHECK ${name}`);
}

test("GitHub persistence models use immutable IDs and relate through organization-owned projects/installations", async () => {
  const schema = await readFile(schemaPath, "utf8");
  for (const model of ["OrganizationGitHubInstallation", "ProjectGitHubRepository", "GitHubConnectIntent", "GitHubWebhookDelivery"]) {
    assert.match(schema, new RegExp(`model\\s+${model}\\s*\\{`));
  }
  assert.match(schema, /githubInstallationId\s+BigInt\s+@unique/);
  assert.match(schema, /githubRepositoryId\s+BigInt/);
  assert.match(schema, /installationRecordId\s+String\s+@map\("installation_record_id"\)/);
  assert.match(schema, /fields: \[tenantId, organizationId, projectId\], references: \[tenantId, organizationId, id\]/);
  assert.match(schema, /fields: \[organizationId, installationRecordId\], references: \[organizationId, id\]/);
  for (const constraint of [
    "organization_github_installations_organization_id_fkey",
    "organization_github_installations_connected_by_fkey",
    "project_github_repositories_project_fkey",
    "project_github_repositories_installation_fkey",
    "project_github_repositories_connected_by_fkey",
    "github_connect_intents_organization_fkey",
    "github_connect_intents_user_fkey",
    "github_webhook_deliveries_organization_fkey"
  ]) assert.ok(schema.includes(`map: "${constraint}"`), `schema relation must map ${constraint}`);
  assert.match(schema, /stateHash\s+String\s+@unique/);
  assert.match(schema, /githubDeliveryId\s+String\s+@unique/);
  assert.doesNotMatch(schema, /model\s+OrganizationGitHubInstallation\s*\{[^}]*\b(privateKey|webhookSecret|accessToken|appJwt)\b/i);
  assert.doesNotMatch(schema, /model\s+GitHubWebhookDelivery\s*\{[^}]*\b(rawBody|payloadJson)\b/i);
});

test("migration-managed partial unique indexes retain exact names, columns, and active predicates", async () => {
  const sql = await readFile(migrationPath, "utf8");
  const expected = [
    ["uq_project_github_repos_active_project", ["tenant_id", "organization_id", "project_id"]],
    ["uq_project_github_repos_active_repo", ["organization_id", "github_repository_id"]]
  ] as const;
  for (const [name, columns] of expected) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = [...sql.matchAll(new RegExp(`CREATE\\s+UNIQUE\\s+INDEX\\s+"${escaped}"\\s+ON\\s+"project_github_repositories"\\s*\\(([^)]+)\\)\\s+WHERE\\s+([^;]+);`, "g"))];
    assert.equal(matches.length, 1, `expected exactly one unique partial index ${name}`);
    assert.deepEqual(matches[0][1].split(",").map((column) => column.trim().replaceAll('"', "")), columns);
    assert.equal(normalizeSql(matches[0][2]), `"status" = 'active'`);
  }
});

test("migration-managed CHECK constraints retain their intended definitions", async () => {
  const sql = await readFile(migrationPath, "utf8");
  const expected = [
    ["ck_org_audit_actor_representation", `("actor_type" = 'user' AND "actor_user_id" IS NOT NULL AND "system_actor_id" IS NULL) OR ("actor_type" = 'system' AND "actor_user_id" IS NULL AND "system_actor_id" IS NOT NULL AND "system_actor_id" = btrim("system_actor_id") AND "system_actor_id" ~ '^[a-z][a-z0-9_.:-]{0,63}$')`],
    ["ck_github_installations_positive_ids", `"github_installation_id" > 0 AND "github_account_id" > 0`],
    ["ck_github_installations_metadata", `char_length(btrim("github_account_login")) > 0 AND char_length(btrim("github_account_type")) > 0 AND jsonb_typeof("verified_permissions") = 'object'`],
    ["ck_github_installations_status", `("status" IN ('active', 'suspended') AND "disconnected_at" IS NULL) OR ("status" IN ('revoked', 'disconnected') AND "disconnected_at" IS NOT NULL)`],
    ["ck_project_github_repositories_positive_id", `"github_repository_id" > 0`],
    ["ck_project_github_repositories_metadata", `char_length(btrim("owner_login")) > 0 AND char_length(btrim("repository_name")) > 0`],
    ["ck_project_github_repositories_status", `("status" = 'active' AND "disconnected_at" IS NULL) OR ("status" IN ('disconnected', 'revoked') AND "disconnected_at" IS NOT NULL)`],
    ["ck_github_connect_intents_state_hash", `"state_hash" ~ '^[0-9a-f]{64}$'`],
    ["ck_github_connect_intents_expiry", `"expires_at" > "created_at"`],
    ["ck_github_webhook_deliveries_metadata", `char_length(btrim("github_delivery_id")) > 0 AND char_length(btrim("event_name")) > 0 AND "payload_hash" ~ '^[0-9a-f]{64}$' AND ("github_installation_id" IS NULL OR "github_installation_id" > 0) AND ("github_repository_id" IS NULL OR "github_repository_id" > 0) AND "attempt_count" >= 0`],
    ["ck_github_webhook_deliveries_status", `"status" IN ('received', 'processing', 'processed', 'ignored', 'failed')`],
    ["ck_github_webhook_deliveries_error_code", `"safe_error_code" IS NULL OR "safe_error_code" ~ '^[a-z][a-z0-9_]{0,63}$'`],
    ["ck_github_webhook_deliveries_processed_at", `("status" IN ('processed', 'ignored') AND "processed_at" IS NOT NULL) OR ("status" NOT IN ('processed', 'ignored') AND "processed_at" IS NULL)`]
  ] as const;
  for (const [name, expression] of expected) assert.equal(normalizeSql(checkExpression(sql, name)), normalizeSql(expression), `${name} differs`);
});

test("GitHub migration enforces tenant/org/project and installation scope, active-binding uniqueness, and safe delivery metadata", async () => {
  const sql = await readFile(migrationPath, "utf8");
  for (const fragment of [
    'FOREIGN KEY ("tenant_id", "organization_id", "project_id")',
    'FOREIGN KEY ("organization_id", "installation_record_id")',
    'WHERE "status" = \'active\'',
    '"ck_github_installations_status"',
    '"ck_project_github_repositories_status"',
    '"ck_github_connect_intents_state_hash"',
    '"ck_github_webhook_deliveries_metadata"',
    '"uq_github_webhook_deliveries_delivery_id"'
  ]) assert.ok(sql.includes(fragment), `expected migration fragment: ${fragment}`);
  assert.doesNotMatch(sql, /\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE FROM)\b/i);
  assert.doesNotMatch(sql, /\b(raw_body|webhook_secret|private_key|access_token|app_jwt)\b/i);
});

test("organization audit actors are constrained to either a real user or a labeled system actor", async () => {
  const schema = await readFile(schemaPath, "utf8");
  const sql = await readFile(migrationPath, "utf8");
  const audit = schema.match(/model\s+OrganizationAuditEvent\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(audit, /actorType\s+String\s+@default\("user"\)/);
  assert.match(audit, /actorUserId\s+String\?/);
  assert.match(audit, /systemActorId\s+String\?/);
  assert.match(sql, /ALTER COLUMN "actor_user_id" DROP NOT NULL/);
  assert.match(sql, /"actor_type" = 'user' AND "actor_user_id" IS NOT NULL AND "system_actor_id" IS NULL/);
  assert.match(sql, /"actor_type" = 'system' AND "actor_user_id" IS NULL/);
  assert.match(sql, /"system_actor_id" ~ '\^\[a-z\]/);
});
