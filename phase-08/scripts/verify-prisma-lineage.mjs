import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const phases = ["phase-06", "phase-07", "phase-08"];
const expectedMigrations = [
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
const canonicalSchemaPath = path.join(root, "phase-08", "prisma", "schema.prisma");
const canonicalMigrationPath = path.join(root, "phase-08", "prisma", "migrations");

function normalizeSql(value) {
  return value.replace(/\s+/g, " ").trim();
}

function extractCheckExpression(sql, constraintName) {
  const marker = `CONSTRAINT "${constraintName}" CHECK (`;
  const markerAt = sql.indexOf(marker);
  assert.notEqual(markerAt, -1, `missing CHECK constraint ${constraintName}`);
  assert.equal(sql.indexOf(marker, markerAt + marker.length), -1, `duplicate CHECK constraint ${constraintName}`);
  const start = markerAt + marker.length - 1;
  let depth = 0;
  let quote = null;
  for (let index = start; index < sql.length; index += 1) {
    const char = sql[index];
    if (quote) {
      if (char === quote) {
        if (sql[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")" && --depth === 0) return sql.slice(start + 1, index);
  }
  assert.fail(`unterminated CHECK constraint ${constraintName}`);
}

function assertCheck(sql, name, expectedExpression) {
  assert.equal(
    normalizeSql(extractCheckExpression(sql, name)),
    normalizeSql(expectedExpression),
    `CHECK constraint ${name} differs from its required expression`
  );
}

function extractFunctionBody(sql, functionName) {
  const declaration = new RegExp(`CREATE\\s+FUNCTION\\s+${functionName}\\s*\\([\\s\\S]*?AS\\s+(\\$[A-Za-z_0-9]*\\$)([\\s\\S]*?)\\1\\s*;`, "i");
  const match = sql.match(declaration);
  assert.ok(match, `missing or malformed function ${functionName}`);
  return match[2];
}

function normalizePlpgsqlBody(body) {
  return body.replace(/--[^\r\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ")
    .toLowerCase().replaceAll('"', "").replace(/\s+/g, "");
}

function assertPartialUniqueIndex(sql, { name, table, columns, predicate }) {
  const definitions = [...sql.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+"([^"]+)"\s+ON\s+"([^"]+)"\s*\(([^)]+)\)\s+WHERE\s+([^;]+);/gim)];
  const matches = definitions.filter((match) => match[2] === name);
  assert.equal(matches.length, 1, `expected exactly one SQL-managed partial index named ${name}`);
  const [, unique, , actualTable, rawColumns, rawPredicate] = matches[0];
  assert.ok(unique, `${name} must be unique`);
  assert.equal(actualTable, table, `${name} table differs`);
  assert.deepEqual(rawColumns.split(",").map((column) => column.trim().replaceAll('"', "")), columns, `${name} columns differ`);
  assert.equal(normalizeSql(rawPredicate), normalizeSql(predicate), `${name} predicate differs`);
}

function assertIndexDefinition(sql, { name, table, unique, columns, predicate = null, order = [] }) {
  const definitions = [...sql.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+"([^"]+)"\s+ON\s+"([^"]+)"\s*\(([^)]+)\)(?:\s+WHERE\s+([^;]+))?;/gim)];
  const matches = definitions.filter((match) => match[2] === name);
  assert.equal(matches.length, 1, `expected exactly one index named ${name}`);
  const [, uniqueClause, , actualTable, rawColumns, rawPredicate] = matches[0];
  assert.equal(Boolean(uniqueClause), unique, `${name} uniqueness differs`);
  assert.equal(actualTable, table, `${name} table differs`);
  const actualTerms = rawColumns.split(",").map((term) => {
    const parsed = term.trim().match(/^"?([A-Za-z_][A-Za-z0-9_]*)"?(?:\s+(ASC|DESC))?(?:\s+NULLS\s+(FIRST|LAST))?$/i);
    assert.ok(parsed, `${name} contains an unsupported or malformed indexed expression: ${term}`);
    return { column: parsed[1], direction: (parsed[2] ?? "ASC").toUpperCase(), nulls: (parsed[3] ?? "").toUpperCase() };
  });
  assert.deepEqual(actualTerms.map((term) => term.column), columns, `${name} ordered columns differ`);
  assert.deepEqual(actualTerms.map((term) => term.direction), order.length ? order : columns.map(() => "ASC"),
    `${name} sort direction differs`);
  assert.deepEqual(actualTerms.map((term) => term.nulls), columns.map(() => ""),
    `${name} NULL ordering must remain PostgreSQL's default`);
  assert.equal(rawPredicate === undefined ? null : normalizeSql(rawPredicate),
    predicate === null ? null : normalizeSql(predicate), `${name} predicate differs`);
}

function assertSchemaIndex(schemaText, { model, kind, name, fields }) {
  const body = schemaText.match(new RegExp(`model\\s+${model}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
  const expected = new RegExp(`^\\s*@@${kind}\\(\\[\\s*${fields.map(escapeRegExp).join("\\s*,\\s*")}\\s*\\],\\s*map:\\s*"${escapeRegExp(name)}"\\)\\s*$`, "m");
  assert.match(body, expected, `${model} must preserve ${kind} ${name} on ordered fields ${fields.join(", ")}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

const schema = await readFile(canonicalSchemaPath, "utf8");
for (const model of ["Tenant", "User", "Project", "Scan", "Finding", "AuditEvent", "Remediation", "IdentityUser", "ExternalIdentity", "Organization", "OrganizationMember", "OrganizationAuditEvent", "ProjectOrganizationAdoption", "OrganizationGitHubInstallation", "ProjectGitHubRepository", "GitHubConnectIntent", "GitHubWebhookDelivery", "RemediationExecution", "RemediationExecutionEvent"]) {
  assert.match(schema, new RegExp(`\\bmodel\\s+${model}\\s*\\{`), `canonical schema is missing model ${model}`);
}
for (const field of ["workerId", "leaseToken", "claimedAt", "heartbeatAt", "leaseExpiresAt", "nextAttemptAt"]) {
  assert.match(schema, new RegExp(`^\\s*${field}\\s+`, "m"), `canonical schema is missing ${field}`);
}
assert.match(schema, /model\s+Scan\s*\{[\s\S]*?leaseToken\s+String\?(?=[^\n]*@db\.Uuid)(?=[^\n]*@map\("lease_token"\))/,
  "canonical Scan model must include its nullable UUID lease token");
assert.match(schema, /@@index\(\[tenantId, projectId, createdAt\(sort: Desc\)\], map: "idx_remediations_tenant_project"\)/);
assert.match(schema, /@@index\(\[tenantId, scanId\], map: "idx_remediations_tenant_scan"\)/);
const remediationModel = schema.match(/model\s+Remediation\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
for (const field of ["requestedByIdentityUserId", "repositoryBindingId", "githubRepositoryId", "planHash", "planSnapshot", "executionArtifact", "executionArtifactHash", "approvedArtifactHash", "approvalState", "approvedByIdentityUserId", "rejectedByIdentityUserId", "invalidatedAt"]) {
  assert.match(remediationModel, new RegExp(`^\\s*${field}\\s+`, "m"), `canonical Remediation model is missing ${field}`);
}
// Prisma 5.22.0 cannot represent the partial indexes or CHECK constraints in this migration.
// They are SQL-managed contracts, so verify their exact definitions below rather than
// implying the Prisma schema alone preserves them.
for (const [model, relation, constraint] of [
  ["OrganizationGitHubInstallation", "organization", "organization_github_installations_organization_id_fkey"],
  ["OrganizationGitHubInstallation", "connectedBy", "organization_github_installations_connected_by_fkey"],
  ["ProjectGitHubRepository", "project", "project_github_repositories_project_fkey"],
  ["ProjectGitHubRepository", "installation", "project_github_repositories_installation_fkey"],
  ["ProjectGitHubRepository", "connectedBy", "project_github_repositories_connected_by_fkey"],
  ["Remediation", "requestedBy", "remediations_requester_fkey"],
  ["Remediation", "approvedBy", "remediations_approver_fkey"],
  ["Remediation", "rejectedBy", "remediations_rejector_fkey"],
  ["Remediation", "invalidatedBy", "remediations_invalidator_fkey"],
  ["Remediation", "repositoryBinding", "remediations_repository_binding_fkey"],
  ["GitHubConnectIntent", "organization", "github_connect_intents_organization_fkey"],
  ["GitHubConnectIntent", "initiatedBy", "github_connect_intents_user_fkey"],
  ["GitHubWebhookDelivery", "organization", "github_webhook_deliveries_organization_fkey"],
  ["RemediationExecution", "tenant", "remediation_executions_tenant_fkey"],
  ["RemediationExecution", "organization", "remediation_executions_organization_fkey"],
  ["RemediationExecution", "project", "remediation_executions_project_fkey"],
  ["RemediationExecution", "remediation", "remediation_executions_remediation_fkey"],
  ["RemediationExecution", "repositoryBinding", "remediation_executions_binding_fkey"],
  ["RemediationExecution", "installation", "remediation_executions_installation_fkey"],
  ["RemediationExecution", "reconciliationActor", "remediation_executions_reconcile_actor_fkey"],
  ["RemediationExecutionEvent", "execution", "remediation_execution_events_execution_fkey"],
  ["RemediationExecutionEvent", "actor", "remediation_execution_events_actor_fkey"]
]) {
  const modelBody = schema.match(new RegExp(`model\\s+${model}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
  assert.match(modelBody, new RegExp(`^\\s*${relation}\\s+[^\\n]+@relation\\([^\\n]*map: "${constraint}"\\)`, "m"),
    `${model}.${relation} must map to SQL foreign key ${constraint}`);
}
for (const model of ["Project", "Scan", "Finding", "Remediation", "AuditEvent"]) {
  const body = schema.match(new RegExp(`model\\s+${model}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
  assert.match(body, /^\s*organizationId\s+String\?\s/m, `${model} must have nullable organization ownership`);
}
const adoptionMigration = await readFile(path.join(canonicalMigrationPath, "20261101140000_organization_project_ownership_foundation", "migration.sql"), "utf8");
for (const required of [
  'CREATE TABLE "project_organization_adoptions"',
  '"uq_projects_tenant_org_id"',
  '"uq_scans_tenant_org_project_id"',
  '"uq_findings_tenant_org_project_scan_id"',
  '"remediations_tenant_id_organization_id_project_id_scan_id_finding_id_fkey"',
  '"uq_project_adoptions_one_pending"',
  '"org_audit_tenant_org_project_fkey"',
  '"org_audit_tenant_org_project_adoption_fkey"'
]) assert.ok(adoptionMigration.includes(required), `ownership migration is missing ${required}`);
assert.doesNotMatch(adoptionMigration, /\b(DROP|TRUNCATE|DELETE FROM)\b/i, "ownership migration must be additive");

const githubMigration = await readFile(path.join(canonicalMigrationPath, "20261105120000_github_integration_persistence", "migration.sql"), "utf8");
for (const required of [
  'CREATE TABLE "organization_github_installations"',
  'CREATE TABLE "project_github_repositories"',
  'CREATE TABLE "github_connect_intents"',
  'CREATE TABLE "github_webhook_deliveries"',
  '"uq_github_installations_github_id"',
  '"project_github_repositories_project_fkey"',
  '"project_github_repositories_installation_fkey"',
  '"uq_project_github_repos_active_project"',
  '"uq_project_github_repos_active_repo"',
  '"ck_org_audit_actor_representation"',
  '"ck_github_connect_intents_state_hash"',
  '"uq_github_webhook_deliveries_delivery_id"'
]) assert.ok(githubMigration.includes(required), `GitHub persistence migration is missing ${required}`);
assertPartialUniqueIndex(githubMigration, {
  name: "uq_project_github_repos_active_project",
  table: "project_github_repositories",
  columns: ["tenant_id", "organization_id", "project_id"],
  predicate: `"status" = 'active'`
});
assertPartialUniqueIndex(githubMigration, {
  name: "uq_project_github_repos_active_repo",
  table: "project_github_repositories",
  columns: ["organization_id", "github_repository_id"],
  predicate: `"status" = 'active'`
});
const requiredChecks = [
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
];
for (const [name, expression] of requiredChecks) assertCheck(githubMigration, name, expression);
assert.doesNotMatch(githubMigration, /\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE FROM)\b/i, "GitHub persistence migration must not remove data or schema objects");
assert.match(githubMigration, /ALTER COLUMN "actor_user_id" DROP NOT NULL/, "audit user actor must become optional for constrained system actors");
assert.doesNotMatch(githubMigration, /\b(raw_body|webhook_secret|private_key|access_token|app_jwt)\b/i, "GitHub persistence migration must not add raw payload or credential storage");

const approvalMigration = await readFile(path.join(canonicalMigrationPath, "20261105150000_remediation_approval_foundation", "migration.sql"), "utf8");
for (const required of [
  'ADD COLUMN "requested_by_identity_user_id" UUID',
  'ADD COLUMN "repository_binding_id" UUID',
  'ADD COLUMN "github_repository_id" BIGINT',
  'ADD COLUMN "plan_hash" VARCHAR(64)',
  'ADD COLUMN "plan_snapshot" JSONB',
  'ADD COLUMN "approval_state" VARCHAR(16)',
  '"remediations_repository_binding_fkey"',
  '"ck_remediations_approval_state"',
  '"ck_remediations_proposal_context"',
  '"ck_remediations_approval_timestamps"',
  '"idx_remediations_approval_inbox"'
]) assert.ok(approvalMigration.includes(required), `remediation approval migration is missing ${required}`);
assertCheck(approvalMigration, "ck_remediations_approval_state",
  `"approval_state" IS NULL OR "approval_state" IN ('pending', 'approved', 'rejected', 'invalidated')`);
assertCheck(approvalMigration, "ck_remediations_proposal_context",
  `("approval_state" IS NULL AND "requested_by_identity_user_id" IS NULL AND "repository_binding_id" IS NULL AND "github_repository_id" IS NULL AND "plan_hash" IS NULL AND "plan_snapshot" IS NULL AND "approved_by_identity_user_id" IS NULL AND "approved_at" IS NULL AND "rejected_by_identity_user_id" IS NULL AND "rejected_at" IS NULL AND "invalidated_by_identity_user_id" IS NULL AND "invalidated_at" IS NULL) OR ("approval_state" IS NOT NULL AND "organization_id" IS NOT NULL AND "requested_by_identity_user_id" IS NOT NULL AND "repository_binding_id" IS NOT NULL AND "github_repository_id" > 0 AND "plan_hash" IS NOT NULL AND "plan_hash" ~ '^[0-9a-f]{64}$' AND "plan_snapshot" IS NOT NULL AND jsonb_typeof("plan_snapshot") = 'object' AND octet_length("plan_snapshot"::text) <= 65536)`);
assertCheck(approvalMigration, "ck_remediations_approval_timestamps",
  `"approval_state" IS NULL OR ("approval_state" = 'pending' AND "approved_by_identity_user_id" IS NULL AND "approved_at" IS NULL AND "rejected_by_identity_user_id" IS NULL AND "rejected_at" IS NULL AND "invalidated_by_identity_user_id" IS NULL AND "invalidated_at" IS NULL) OR ("approval_state" = 'approved' AND "approved_by_identity_user_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "rejected_by_identity_user_id" IS NULL AND "rejected_at" IS NULL AND "invalidated_by_identity_user_id" IS NULL AND "invalidated_at" IS NULL) OR ("approval_state" = 'rejected' AND "approved_by_identity_user_id" IS NULL AND "approved_at" IS NULL AND "rejected_by_identity_user_id" IS NOT NULL AND "rejected_at" IS NOT NULL AND "invalidated_by_identity_user_id" IS NULL AND "invalidated_at" IS NULL) OR ("approval_state" = 'invalidated' AND "rejected_by_identity_user_id" IS NULL AND "rejected_at" IS NULL AND "invalidated_by_identity_user_id" IS NOT NULL AND "invalidated_at" IS NOT NULL AND (("approved_by_identity_user_id" IS NULL AND "approved_at" IS NULL) OR ("approved_by_identity_user_id" IS NOT NULL AND "approved_at" IS NOT NULL)))`);
assert.doesNotMatch(approvalMigration, /\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE FROM|UPDATE\s+"?remediations"?)\b/i,
  "remediation approval migration must preserve historical records without backfilling them");

const artifactMigration = await readFile(path.join(canonicalMigrationPath, "20261105160000_remediation_execution_artifact", "migration.sql"), "utf8");
for (const required of [
  'ADD COLUMN "execution_artifact" JSONB',
  'ADD COLUMN "execution_artifact_hash" VARCHAR(64)',
  'ADD COLUMN "approved_artifact_hash" VARCHAR(64)',
  '"ck_remediations_execution_artifact"'
]) assert.ok(artifactMigration.includes(required), "execution artifact migration is missing " + required);
assertCheck(artifactMigration, "ck_remediations_execution_artifact",
  `( "execution_artifact" IS NULL AND "execution_artifact_hash" IS NULL AND "approved_artifact_hash" IS NULL AND ("approval_state" IS NULL OR "approval_state" IN ('pending', 'rejected', 'invalidated')) ) OR ( "execution_artifact" IS NOT NULL AND "approval_state" IS NOT NULL AND jsonb_typeof("execution_artifact") = 'object' AND octet_length("execution_artifact"::text) <= 2097152 AND "execution_artifact_hash" IS NOT NULL AND "execution_artifact_hash" ~ '^[0-9a-f]{64}$' AND ( ("approval_state" = 'approved' AND "approved_artifact_hash" IS NOT NULL AND "approved_artifact_hash" = "execution_artifact_hash") OR ("approval_state" IN ('pending', 'rejected') AND "approved_artifact_hash" IS NULL) OR ("approval_state" = 'invalidated' AND ("approved_artifact_hash" IS NULL OR "approved_artifact_hash" = "execution_artifact_hash")) ) )`);
assertCheck(artifactMigration, "ck_remediations_approval_repository_id",
  `"approval_state" IS NULL OR "github_repository_id" IS NOT NULL`);
assert.match(artifactMigration, /CREATE TRIGGER "trg_remediations_execution_artifact_immutable"\s+BEFORE UPDATE OR DELETE ON "remediations"\s+FOR EACH ROW EXECUTE FUNCTION prevent_remediation_execution_artifact_replacement\(\);/i);
const immutableFunctionBody = normalizePlpgsqlBody(extractFunctionBody(artifactMigration, "prevent_remediation_execution_artifact_replacement"));
assert.equal(immutableFunctionBody,
  "beginiftg_opnotin('update','delete')thenraiseexception'unsupportedremediationexecutionartifactoperation';endif;iftg_op='delete'thenifold.execution_artifactisnotnullthenraiseexception'remediationexecutionartifactisimmutable';endif;returnold;endif;iftg_op='update'andold.execution_artifactisnotnulland(new.execution_artifactisdistinctfromold.execution_artifactornew.execution_artifact_hashisdistinctfromold.execution_artifact_hash)thenraiseexception'remediationexecutionartifactisimmutable';endif;returnnew;end;",
  "execution artifact trigger function must prevent persisted artifact DELETE and UPDATE replacement");
assert.match(artifactMigration, /ADD CONSTRAINT "ck_remediations_approval_repository_id" CHECK/);
assert.doesNotMatch(artifactMigration, /\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE FROM)\b/i,
  "execution artifact migration must be additive and leave historical rows untouched");

const executionPersistenceMigration = await readFile(path.join(canonicalMigrationPath, "20261106120000_remediation_execution_persistence", "migration.sql"), "utf8");
const remoteMutationRejectedMigration = await readFile(path.join(canonicalMigrationPath,
  "20261108120000_remote_mutation_rejected", "migration.sql"), "utf8");
const rateLimitRetryMigration = await readFile(path.join(canonicalMigrationPath,
  "20261109120000_remediation_execution_retry", "migration.sql"), "utf8");
const mutationResourceTypeMigration = await readFile(path.join(canonicalMigrationPath,
  "20261110120000_allow_mutation_rejection_resource_type", "migration.sql"), "utf8");
const executionPersistenceSource = await readFile(path.join(root, "phase-08", "src", "remediation", "remediation-execution-persistence.ts"), "utf8");
for (const required of [
  'CREATE TABLE "remediation_executions"',
  'CREATE TABLE "remediation_execution_events"',
  '"remediation_executions_project_fkey"',
  '"remediation_executions_remediation_fkey"',
  '"remediation_executions_binding_fkey"',
  '"remediation_executions_installation_fkey"',
  '"remediation_execution_events_execution_fkey"',
  '"uq_remediation_executions_proposal"',
  '"uq_remediation_execution_events_sequence"',
  '"uq_remediation_execution_events_operation"',
  '"trg_remediation_execution_events_append_only"',
  '"trg_remediation_execution_events_no_truncate"',
  '"remediation_execution_events_actor_org_fkey"',
  'prevent_remediation_execution_event_mutation'
]) assert.ok(executionPersistenceMigration.includes(required), `execution persistence migration is missing ${required}`);
const executionPersistenceIndexes = [
  { name: "uq_remediations_execution_scope", table: "remediations", unique: true,
    columns: ["tenant_id", "organization_id", "project_id", "id"] },
  { name: "uq_project_github_repo_installation_ref", table: "project_github_repositories", unique: true,
    columns: ["tenant_id", "organization_id", "project_id", "id", "github_repository_id", "installation_record_id"] },
  { name: "uq_remediation_executions_proposal", table: "remediation_executions", unique: true,
    columns: ["tenant_id", "organization_id", "project_id", "remediation_id"] },
  { name: "uq_remediation_executions_scope_ref", table: "remediation_executions", unique: true,
    columns: ["tenant_id", "organization_id", "project_id", "remediation_id", "id"] },
  { name: "uq_remediation_executions_github_pr", table: "remediation_executions", unique: true,
    columns: ["github_repository_id", "pull_request_number"] },
  { name: "idx_remediation_executions_status_updated", table: "remediation_executions", unique: false,
    columns: ["status", "updated_at"] },
  { name: "idx_remediation_executions_org_status", table: "remediation_executions", unique: false,
    columns: ["organization_id", "status", "updated_at"] },
  { name: "idx_remediation_executions_lease_expiry", table: "remediation_executions", unique: false,
    columns: ["lease_expires_at"] },
  { name: "uq_remediation_execution_events_sequence", table: "remediation_execution_events", unique: true,
    columns: ["execution_id", "attempt_number", "sequence_number"] },
  { name: "uq_remediation_execution_events_operation", table: "remediation_execution_events", unique: true,
    columns: ["execution_id", "attempt_number", "operation_key", "event_type"] },
  { name: "idx_remediation_execution_events_scope_time", table: "remediation_execution_events", unique: false,
    columns: ["tenant_id", "organization_id", "project_id", "remediation_id", "created_at"] }
];
assert.equal([...executionPersistenceMigration.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\b/gim)].length,
  executionPersistenceIndexes.length, "execution persistence migration has an unexpected explicit index count");
for (const index of executionPersistenceIndexes) {
  assertIndexDefinition(executionPersistenceMigration, index);
}
for (const index of [
  { model: "Remediation", kind: "unique", name: "uq_remediations_execution_scope",
    fields: ["tenantId", "organizationId", "projectId", "id"] },
  { model: "ProjectGitHubRepository", kind: "unique", name: "uq_project_github_repo_installation_ref",
    fields: ["tenantId", "organizationId", "projectId", "id", "githubRepositoryId", "installationRecordId"] },
  { model: "RemediationExecution", kind: "unique", name: "uq_remediation_executions_proposal",
    fields: ["tenantId", "organizationId", "projectId", "remediationId"] },
  { model: "RemediationExecution", kind: "unique", name: "uq_remediation_executions_scope_ref",
    fields: ["tenantId", "organizationId", "projectId", "remediationId", "id"] },
  { model: "RemediationExecution", kind: "unique", name: "uq_remediation_executions_github_pr",
    fields: ["githubRepositoryId", "pullRequestNumber"] },
  { model: "RemediationExecution", kind: "index", name: "idx_remediation_executions_status_updated",
    fields: ["status", "updatedAt"] },
  { model: "RemediationExecution", kind: "index", name: "idx_remediation_executions_org_status",
    fields: ["organizationId", "status", "updatedAt"] },
  { model: "RemediationExecution", kind: "index", name: "idx_remediation_executions_lease_expiry",
    fields: ["leaseExpiresAt"] },
  { model: "RemediationExecutionEvent", kind: "unique", name: "uq_remediation_execution_events_sequence",
    fields: ["executionId", "attemptNumber", "sequenceNumber"] },
  { model: "RemediationExecutionEvent", kind: "unique", name: "uq_remediation_execution_events_operation",
    fields: ["executionId", "attemptNumber", "operationKey", "eventType"] },
  { model: "RemediationExecutionEvent", kind: "index", name: "idx_remediation_execution_events_scope_time",
    fields: ["tenantId", "organizationId", "projectId", "remediationId", "createdAt"] }
]) assertSchemaIndex(schema, index);
for (const required of [
  `FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
  `FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
  `FOREIGN KEY ("tenant_id", "organization_id", "project_id") REFERENCES "projects"("tenant_id", "organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE`,
  `FOREIGN KEY ("tenant_id", "organization_id", "project_id", "remediation_id") REFERENCES "remediations"("tenant_id", "organization_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE`,
  `FOREIGN KEY ("tenant_id", "organization_id", "project_id", "repository_binding_id", "github_repository_id", "installation_record_id") REFERENCES "project_github_repositories"("tenant_id", "organization_id", "project_id", "id", "github_repository_id", "installation_record_id") ON DELETE RESTRICT ON UPDATE CASCADE`,
  `FOREIGN KEY ("organization_id", "installation_record_id") REFERENCES "organization_github_installations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE`,
  `FOREIGN KEY ("reconciliation_actor_id") REFERENCES "identity_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
  `FOREIGN KEY ("tenant_id", "organization_id", "project_id", "remediation_id", "execution_id") REFERENCES "remediation_executions"("tenant_id", "organization_id", "project_id", "remediation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE`
]) assert.ok(normalizeSql(executionPersistenceMigration).includes(normalizeSql(required)),
  `execution persistence migration has a missing or altered scoped foreign key: ${required}`);
assert.ok(normalizeSql(executionPersistenceMigration).includes(normalizeSql(
  `FOREIGN KEY ("actor_user_id") REFERENCES "identity_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE`)),
  "event actor must reference an identity user");
assert.ok(normalizeSql(executionPersistenceMigration).includes(normalizeSql(
  `FOREIGN KEY ("organization_id", "actor_user_id") REFERENCES "organization_members"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE`)),
  "user event actors must belong to the event organization");
assert.match(schema, /SQL-managed composite FK additionally requires user actors to belong to the event organization/,
  "Prisma schema must document the additional SQL-managed actor scope constraint");
assert.match(schema, /model\s+OrganizationMember\s*\{[\s\S]*?@@id\(\[organizationId, userId\]/,
  "event actor composite FK must reference the organization-membership primary key");
for (const constraint of [
  "ck_remediation_executions_status", "ck_remediation_executions_stage", "ck_remediation_executions_reconciliation",
  "ck_remediation_executions_failure", "ck_remediation_executions_branch", "ck_remediation_executions_identity",
  "ck_remediation_executions_lease", "ck_remediation_executions_reconciliation_lease",
  "ck_remediation_executions_pr_pair", "ck_remediation_executions_verified_state",
  "ck_remediation_execution_events_sequence", "ck_remediation_execution_events_type", "ck_remediation_execution_events_stage",
  "ck_remediation_execution_events_request_hash", "ck_remediation_execution_events_operation",
  "ck_remediation_execution_events_error_code", "ck_remediation_execution_events_remote_type", "ck_remediation_execution_events_metadata",
  "ck_remediation_execution_events_actor", "ck_remediation_execution_events_pr_pair", "ck_remediation_execution_events_commit_sha"
]) assert.match(executionPersistenceMigration, new RegExp(`CONSTRAINT\\s+"${constraint}"\\s+CHECK`), `missing ${constraint}`);
for (const [name, expression] of [
  ["ck_remediation_executions_lease", `("lease_owner" IS NULL AND "lease_token_hash" IS NULL AND "lease_expires_at" IS NULL) OR ("lease_owner" IS NOT NULL AND "lease_token_hash" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND btrim("lease_owner") <> '' AND "lease_token_hash" ~ '^[0-9a-f]{64}$' AND "lease_expires_at" IS NOT NULL)`],
  ["ck_remediation_executions_reconciliation_lease", `("reconciliation_lease_hash" IS NULL AND "reconciliation_lease_until" IS NULL) OR ("reconciliation_lease_hash" IS NOT NULL AND "reconciliation_lease_until" IS NOT NULL AND "reconciliation_lease_hash" ~ '^[0-9a-f]{64}$')`],
  ["ck_remediation_executions_pr_pair", `("pull_request_number" IS NULL AND "pull_request_url" IS NULL) OR ("pull_request_number" IS NOT NULL AND "pull_request_url" IS NOT NULL AND "pull_request_number" > 0 AND "pull_request_url" ~ '^https://github\\.com/[^/]+/[^/]+/pull/[1-9][0-9]*$')`],
  ["ck_remediation_execution_events_pr_pair", `("pull_request_number" IS NULL AND "pull_request_url" IS NULL) OR ("pull_request_number" IS NOT NULL AND "pull_request_url" IS NOT NULL AND "pull_request_number" > 0 AND "pull_request_url" ~ '^https://github\\.com/[^/]+/[^/]+/pull/[1-9][0-9]*$')`],
  ["ck_remediation_executions_verified_state", `("status" NOT IN ('commit_verified', 'branch_verified', 'draft_pr_verified', 'completed') OR ("commit_sha" IS NOT NULL AND "commit_verified_at" IS NOT NULL AND "commit_sha" ~ '^[0-9a-f]{40}$')) AND ("status" NOT IN ('branch_verified', 'draft_pr_verified', 'completed') OR ("branch_name" IS NOT NULL AND "branch_verified_at" IS NOT NULL)) AND ("status" NOT IN ('draft_pr_verified', 'completed') OR ("pull_request_number" IS NOT NULL AND "pull_request_url" IS NOT NULL AND "pull_request_verified_at" IS NOT NULL)) AND ("status" <> 'completed' OR ("completed_at" IS NOT NULL AND "lease_owner" IS NULL AND "reconciliation_status" IN ('not_required', 'resolved'))) AND ("status" <> 'manual_review_required' OR ("manual_review_at" IS NOT NULL AND "reconciliation_status" IN ('required', 'in_progress', 'resolved'))) AND ("status" <> 'reconciliation_in_progress' OR "reconciliation_status" = 'in_progress') AND ("status" <> 'reconciliation_resolved' OR "reconciliation_status" = 'resolved')`]
]) assertCheck(executionPersistenceMigration, name, expression);
assert.match(executionPersistenceMigration,
  /CREATE TRIGGER "trg_remediation_execution_events_append_only"\s+BEFORE UPDATE OR DELETE ON "remediation_execution_events"\s+FOR EACH ROW EXECUTE FUNCTION prevent_remediation_execution_event_mutation\(\);/i);
assert.match(executionPersistenceMigration,
  /CREATE TRIGGER "trg_remediation_execution_events_no_truncate"\s+BEFORE TRUNCATE ON "remediation_execution_events"\s+FOR EACH STATEMENT EXECUTE FUNCTION prevent_remediation_execution_event_mutation\(\);/i);
const executionEventGuard = normalizePlpgsqlBody(extractFunctionBody(executionPersistenceMigration, "prevent_remediation_execution_event_mutation"));
assert.equal(executionEventGuard, "beginraiseexception'remediationexecutioneventsareappend-only';end;",
  "execution event trigger must reject UPDATE and DELETE");
assert.match(executionPersistenceMigration,
  /Runtime role must not own these tables[\s\S]*?ALTER, or trigger-management privileges/i,
  "runtime database role privilege restriction must be documented");
assertCheck(executionPersistenceMigration, "ck_remediation_execution_events_type",
  `"event_type" IN ( 'execution_started', 'request_intent', 'remote_result_verified', 'execution_failed', 'execution_completed', 'manual_review_required', 'reconciliation_started', 'reconciliation_resolved' )`);
assert.match(remoteMutationRejectedMigration,
  /ALTER TABLE "remediation_execution_events"\s+DROP CONSTRAINT "ck_remediation_execution_events_type";/i);
assertCheck(remoteMutationRejectedMigration, "ck_remediation_execution_events_type",
  `"event_type" IN ( 'execution_started', 'request_intent', 'remote_result_verified', 'remote_mutation_rejected', 'execution_failed', 'execution_completed', 'manual_review_required', 'reconciliation_started', 'reconciliation_resolved' )`);
assertCheck(remoteMutationRejectedMigration, "ck_remediation_execution_events_rejection",
  `"event_type" <> 'remote_mutation_rejected' OR ( "stage" IN ('blob', 'tree', 'commit', 'branch', 'pull_request', 'pull_request_close') AND "operation_key" IS NOT NULL AND "request_hash" IS NOT NULL AND "error_code" = 'rate_limited' AND "remote_resource_type" = 'github_mutation' AND "metadata" ? 'rejection' AND jsonb_typeof("metadata"->'rejection') = 'string' AND "metadata"->>'rejection' IN ('primary_rate_limit', 'secondary_rate_limit') AND "metadata" ? 'requestFingerprint' AND "metadata"->>'requestFingerprint' ~ '^[0-9a-f]{64}$' AND ( NOT ("metadata" ? 'retryAfterMs') OR (jsonb_typeof("metadata"->'retryAfterMs') = 'number' AND "metadata"->>'retryAfterMs' ~ '^(0|[1-9][0-9]{0,4}|60000)$' AND ("metadata"->>'retryAfterMs')::bigint <= 60000) ) )`);
assert.match(mutationResourceTypeMigration,
  /ALTER TABLE "remediation_execution_events"\s+DROP CONSTRAINT "ck_remediation_execution_events_remote_type";/i);
assertCheck(mutationResourceTypeMigration, "ck_remediation_execution_events_remote_type",
  `"remote_resource_type" IS NULL OR "remote_resource_type" IN ( 'blob', 'tree', 'commit', 'branch', 'pull_request', 'pull_request_close', 'github_mutation' )`);
assert.match(mutationResourceTypeMigration, /'github_mutation'/,
  "the shared resource-type allowlist must admit rejection journal sentinel events");
assert.doesNotMatch(mutationResourceTypeMigration, /\b(TRUNCATE|DELETE FROM)\b/i,
  "the additive resource-type correction must preserve journal history");
assert.doesNotMatch(remoteMutationRejectedMigration, /\b(TRUNCATE|DELETE FROM)\b/i,
  "rejection journal migration must not rewrite or delete historical event rows");
assert.match(rateLimitRetryMigration,
  /ALTER TABLE "remediation_executions"\s+ADD COLUMN "retry_eligible_at" TIMESTAMP\(3\);/i);
assert.match(schema, /retryEligibleAt\s+DateTime\?\s+@map\("retry_eligible_at"\)/,
  "Prisma execution aggregate must expose the durable retry deadline");
assertCheck(rateLimitRetryMigration, "ck_remediation_execution_retry_state",
  `"retry_eligible_at" IS NULL OR ( "status" = 'failed' AND "failure_code" = 'rate_limited' AND "lease_owner" IS NULL AND "lease_token_hash" IS NULL AND "lease_expires_at" IS NULL AND "reconciliation_status" = 'not_required' AND "completed_at" IS NULL )`);
assertCheck(rateLimitRetryMigration, "ck_remediation_execution_events_retry",
  `"event_type" <> 'execution_retry_scheduled' OR ( "stage" IN ('blob', 'tree', 'commit', 'branch', 'pull_request', 'pull_request_close') AND "operation_key" IS NOT NULL AND "request_hash" IS NOT NULL AND "error_code" = 'rate_limited' AND "metadata" ? 'retryOrdinal' AND jsonb_typeof("metadata"->'retryOrdinal') = 'number' AND ("metadata"->>'retryOrdinal') ~ '^[1-3]$' AND "metadata" ? 'retryAfterMs' AND jsonb_typeof("metadata"->'retryAfterMs') = 'number' AND ("metadata"->>'retryAfterMs') ~ '^(1000|[1-9][0-9]{0,3}|[1-5][0-9]{4}|60000)$' AND ("metadata"->>'retryAfterMs')::bigint BETWEEN 1000 AND 60000 AND "metadata" ? 'retryAt' AND jsonb_typeof("metadata"->'retryAt') = 'string' AND ("metadata"->>'retryAt') ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' )`);
assert.match(rateLimitRetryMigration,
  /CREATE INDEX "idx_remediation_executions_retry_eligible"\s+ON "remediation_executions"\("retry_eligible_at"\)\s+WHERE "retry_eligible_at" IS NOT NULL;/i,
  "retry eligibility index must be partial and ordered on the deadline");
assertCheck(rateLimitRetryMigration, "ck_remediation_execution_events_type",
  `"event_type" IN ( 'execution_started', 'request_intent', 'remote_result_verified', 'remote_mutation_rejected', 'execution_retry_scheduled', 'execution_failed', 'execution_completed', 'manual_review_required', 'reconciliation_started', 'reconciliation_resolved' )`);
assert.doesNotMatch(rateLimitRetryMigration, /\b(TRUNCATE|DELETE FROM)\b/i,
  "retry migration must preserve historical execution and event rows");
assertCheck(executionPersistenceMigration, "ck_remediation_execution_events_metadata",
  `jsonb_typeof("metadata") = 'object' AND octet_length("metadata"::text) <= 16384`);
assertCheck(executionPersistenceMigration, "ck_remediation_execution_events_actor",
  `("actor_type" = 'user' AND "actor_user_id" IS NOT NULL AND "system_actor_id" IS NULL) OR ("actor_type" = 'system' AND "actor_user_id" IS NULL AND "system_actor_id" IS NOT NULL AND "system_actor_id" = btrim("system_actor_id") AND "system_actor_id" ~ '^[a-z][a-z0-9_.:-]{0,63}$')`);
const appFailureCodes = executionPersistenceSource.match(/const SAFE_FAILURE_CODES = new Set\(\[([\s\S]*?)\]\);/)?.[1];
assert.ok(appFailureCodes, "execution persistence must define an explicit safe failure-code allowlist");
const applicationCodeValues = [...appFailureCodes.matchAll(/"([a-z][a-z0-9_]{0,63})"/g)].map((match) => match[1]);
const sqlCodeValues = (constraintName) => {
  const expression = extractCheckExpression(remoteMutationRejectedMigration, constraintName);
  const allowed = expression.match(/(?:"failure_code"|"error_code")\s+IS NULL OR (?:"failure_code"|"error_code")\s+IN\s*\(([\s\S]*?)\)/);
  assert.ok(allowed, `${constraintName} must use an explicit failure-code allowlist`);
  return [...allowed[1].matchAll(/'([a-z][a-z0-9_]{0,63})'/g)].map((match) => match[1]);
};
for (const constraintName of ["ck_remediation_executions_failure", "ck_remediation_execution_events_error_code"]) {
  assert.match(remoteMutationRejectedMigration,
    new RegExp(`ALTER TABLE \\"(?:remediation_executions|remediation_execution_events)\\"\\s+DROP CONSTRAINT \\"${constraintName}\\";`, "i"),
    `${constraintName} must be replaced additively to align the final SQL allowlist`);
}
assert.deepEqual(sqlCodeValues("ck_remediation_executions_failure"), applicationCodeValues,
  "execution failure CHECK must match the application allowlist exactly");
assert.deepEqual(sqlCodeValues("ck_remediation_execution_events_error_code"), applicationCodeValues,
  "journal error-code CHECK must match the application allowlist exactly");
assert.doesNotMatch(executionPersistenceMigration,
  /^\s*(?:DROP\s+(?:TABLE|COLUMN)|TRUNCATE\s+TABLE|DELETE\s+FROM|UPDATE\s+"?remediations"?)\b/im,
  "execution persistence migration must be additive and preserve historical records");
assert.doesNotMatch(executionPersistenceMigration, /\b(access_token|private_key|webhook_secret|raw_error_body|patch_contents|rendered_content)\b/i,
  "execution persistence must not add credential, raw error, or arbitrary patch storage");

const migrationNames = (await readdir(canonicalMigrationPath, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assert.deepEqual(migrationNames, expectedMigrations, "canonical migration names/order differ from the approved migration history");
for (const name of expectedMigrations) {
  await readFile(path.join(canonicalMigrationPath, name, "migration.sql"));
}
const lock = await readFile(path.join(canonicalMigrationPath, "migration_lock.toml"), "utf8");
assert.match(lock, /^provider = "postgresql"$/m, "canonical migration lock must select PostgreSQL");

const duplicatedMigrations = {
  "phase-06": expectedMigrations.slice(0, 2),
  "phase-07": expectedMigrations.slice(0, 4)
};
for (const [phase, names] of Object.entries(duplicatedMigrations)) {
  for (const name of names) {
    const canonicalSql = await readFile(path.join(canonicalMigrationPath, name, "migration.sql"));
    const historicalSql = await readFile(path.join(root, phase, "prisma", "migrations", name, "migration.sql"));
    assert.equal(
      createHash("sha256").update(historicalSql).digest("hex"),
      createHash("sha256").update(canonicalSql).digest("hex"),
      `${phase}/${name} SQL differs from the canonical migration`
    );
  }
}

for (const phase of phases) {
  const manifest = await readJson(path.join(phase, "package.json"));
  const packageLock = await readJson(path.join(phase, "package-lock.json"));
  assert.equal(manifest.dependencies?.["@prisma/client"], "5.22.0", `${phase} @prisma/client must be pinned to 5.22.0`);
  assert.equal(manifest.devDependencies?.prisma, "5.22.0", `${phase} prisma must be pinned to 5.22.0`);
  assert.equal(packageLock.packages?.[""].dependencies?.["@prisma/client"], "5.22.0", `${phase} lockfile client pin differs`);
  assert.equal(packageLock.packages?.[""].devDependencies?.prisma, "5.22.0", `${phase} lockfile CLI pin differs`);
  assert.equal(packageLock.packages?.["node_modules/@prisma/client"]?.version, "5.22.0", `${phase} installed client lock differs`);
  assert.equal(packageLock.packages?.["node_modules/prisma"]?.version, "5.22.0", `${phase} installed CLI lock differs`);

  if (phase === "phase-08") {
    assert.equal(manifest.prisma?.schema, "prisma/schema.prisma");
    assert.match(manifest.scripts?.["prisma:generate"] ?? "", /--schema prisma\/schema\.prisma/);
    assert.match(manifest.scripts?.["prisma:migrate"] ?? "", /migrate deploy --schema prisma\/schema\.prisma/);
  } else {
    assert.equal(manifest.prisma?.schema, "../phase-08/prisma/schema.prisma");
    assert.equal(manifest.scripts?.["prisma:generate"], undefined, `${phase} must not expose a competing generation command`);
    assert.equal(manifest.scripts?.["prisma:migrate"], undefined, `${phase} must not expose an independent migration command`);
  }
}

const clientPackage = path.join(root, "phase-08", "node_modules", "@prisma", "client", "default.js");
const generatedSchema = path.join(root, "phase-08", "node_modules", ".prisma", "client", "schema.prisma");
const runtimeSources = [
  "phase-08/dist/phase-08/src",
  "phase-08/dist/phase-06/src/api",
  "phase-08/dist/phase-07/src/db"
];
const resolutions = runtimeSources.map((sourceDir) => createRequire(path.join(root, sourceDir, "__resolution_probe.cjs")).resolve("@prisma/client"));
assert.ok(resolutions.every((resolved) => path.resolve(resolved) === path.resolve(clientPackage)), "composed runtime modules resolve different Prisma client packages");
const generatedSchemaText = await readFile(generatedSchema, "utf8");
assert.match(generatedSchemaText, /model\s+Remediation\s*\{/);
assert.match(generatedSchemaText, /leaseToken\s+String\?/);
assert.match(generatedSchemaText, /model\s+Scan\s*\{[\s\S]*?leaseToken\s+String\?[^\n]*@db\.Uuid/);
for (const model of ["IdentityUser", "ExternalIdentity", "Organization", "OrganizationMember", "OrganizationAuditEvent", "ProjectOrganizationAdoption", "OrganizationGitHubInstallation", "ProjectGitHubRepository", "GitHubConnectIntent", "GitHubWebhookDelivery", "RemediationExecution", "RemediationExecutionEvent"]) {
  assert.ok(new RegExp(`model\\s+${model}\\s*\\{`).test(generatedSchemaText), `generated client schema is missing ${model}`);
}
assert.match(generatedSchemaText, /map: "idx_remediations_tenant_project"/);
assert.match(generatedSchemaText, /map: "idx_remediations_tenant_scan"/);
assert.match(generatedSchemaText, /actorType\s+String\s+@default\("user"\)/);
assert.match(generatedSchemaText, /systemActorId\s+String\?/);
for (const model of ["Project", "Scan", "Finding", "Remediation", "AuditEvent"]) {
  const body = generatedSchemaText.match(new RegExp(`model\\s+${model}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
  assert.match(body, /^\s*organizationId\s+String\?\s/m, `generated ${model} lacks nullable organization ownership`);
}

console.log("Prisma lineage verified: canonical Phase 08 schema, migration order, duplicated SQL, pinned versions, and composed runtime client.");
