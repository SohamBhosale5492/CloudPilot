import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { planRemediation, type FindingSummary } from "../../../phase-07/src/remediation/planner.js";
import { RemediationJobRepository, type RemediationLease } from "../../src/jobs/remediation-repo.js";
import { RemediationExecutionPersistenceService } from "../../src/remediation/remediation-execution-persistence.js";
import { TrustedClaimExecutionContextService } from "../../src/remediation/trusted-claim-execution-context.js";
import { PrismaRemediationExecutionLifecycle } from "../../src/jobs/remediation-execution-lifecycle.js";
import { renderExecutionArtifact, sealExecutionArtifact } from "../../src/remediation/execution-artifact.js";

const DATABASE_URL = process.env.CLOUDPILOT_CLAIM_TEST_DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("CLOUDPILOT_CLAIM_TEST_DATABASE_URL is required for the remediation claim integration test.");
}

const EXPECTED_MIGRATIONS = [
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
] as const;

const HASH = "a".repeat(64);
const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

function parseApprovedUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CLOUDPILOT_CLAIM_TEST_DATABASE_URL is malformed.");
  }
  const username = decodeURIComponent(url.username);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const forbiddenOverrides = ["host", "port", "dbname", "database", "user", "username"];
  if (!(["postgres:", "postgresql:"].includes(url.protocol)) ||
      !(["127.0.0.1", "localhost", "::1"].includes(url.hostname)) ||
      url.port !== "56433" || database !== "cloudpilot_claim_test" ||
      username !== "cloudpilot_claim_test" || url.hash ||
      forbiddenOverrides.some((key) => url.searchParams.has(key))) {
    throw new Error("CLOUDPILOT_CLAIM_TEST_DATABASE_URL must target the approved local claim-test database.");
  }
  return url;
}

// Validate the URL before constructing Prisma. Never consult DATABASE_URL or dotenv files.
parseApprovedUrl(DATABASE_URL);

interface Graph {
  tenantId: string;
  identityUserId: string;
  organizationId: string;
  projectId: string;
  scanId: string;
  findingId: string;
  installationId: string;
  installationGithubId: bigint;
  bindingId: string;
  repositoryName: string;
  repositoryId: bigint;
  adoptionId: string;
  finding: FindingSummary;
}

interface ProposalOptions {
  approvalState?: "approved" | "pending" | "rejected" | "invalidated" | null;
  status?: string;
  withArtifact?: boolean;
  approvedHash?: string | null;
  executionHash?: string | null;
  artifact?: unknown;
  artifactMutator?: (artifact: Record<string, unknown>) => unknown;
  artifactHash?: string;
  artifactScopeOverrides?: Record<string, string>;
  id?: string;
  createdAt?: Date;
}

class RollbackFixtures extends Error {}

function inCurrentTransaction(tx: Prisma.TransactionClient): PrismaClient {
  // The repository normally opens its own Prisma transaction. In this integration
  // test, flatten that boundary into the enclosing real PostgreSQL transaction so
  // every fixture and claim/audit write is rolled back together. SQL is not mocked.
  return new Proxy(tx as unknown as PrismaClient, {
    get(target, property) {
      if (property === "$transaction") {
        return async (callback: (client: Prisma.TransactionClient) => Promise<unknown>) => callback(tx);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function createGraph(tx: Prisma.TransactionClient, suffix: string): Promise<Graph> {
  const tenantId = randomUUID();
  const identityUserId = randomUUID();
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const scanId = randomUUID();
  const findingId = randomUUID();
  const installationId = randomUUID();
  const bindingId = randomUUID();
  const repositoryName = `repo-${suffix}`;
  const adoptionId = randomUUID();
  const serial = BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`) + 100_000_000_000n;
  const installationGithubId = serial;
  const repositoryId = serial + 1n;
  const finding: FindingSummary = {
    requirementId: `claim-test-${suffix}`,
    ruleId: "observability.metric.present",
    ruleVersion: "1.0.0",
    signal: "metric",
    outcome: "gap",
    expected: "A request metric is configured",
    observed: "No request metric is configured",
    reason: "Disposable PostgreSQL claim fixture"
  };

  await tx.$executeRaw`INSERT INTO tenants (id, name) VALUES (${tenantId}, ${`claim-test-${suffix}`});`;
  await tx.$executeRaw`
    INSERT INTO identity_users (id, status, display_name, created_at, updated_at)
    VALUES (${identityUserId}::uuid, 'active', 'Claim-test fixture', NOW(), NOW());
  `;
  await tx.$executeRaw`
    INSERT INTO organizations (
      id, display_name, status, created_by_user_id, creation_idempotency_key,
      creation_request_hash, created_at, updated_at
    ) VALUES (
      ${organizationId}::uuid, ${`Claim Test ${suffix}`}, 'active', ${identityUserId}::uuid,
      ${`claim-test-${suffix}`}, ${HASH}, NOW(), NOW()
    );
  `;
  await tx.$executeRaw`
    INSERT INTO organization_members (
      organization_id, user_id, role, status, created_by_user_id, created_at, updated_at
    ) VALUES (
      ${organizationId}::uuid, ${identityUserId}::uuid, 'owner', 'active', ${identityUserId}::uuid, NOW(), NOW()
    );
  `;
  await tx.$executeRaw`
    INSERT INTO projects (id, tenant_id, organization_id, name, repository_url, created_at, updated_at)
    VALUES (${projectId}, ${tenantId}, ${organizationId}::uuid, ${`claim-test-${suffix}`},
      'https://github.com/example/claim-test', NOW(), NOW());
  `;
  await tx.$executeRaw`
    INSERT INTO scans (id, tenant_id, organization_id, project_id, status, created_at)
    VALUES (${scanId}, ${tenantId}, ${organizationId}::uuid, ${projectId}, 'completed', NOW());
  `;
  await tx.$executeRaw`
    INSERT INTO findings (
      id, tenant_id, organization_id, project_id, scan_id, requirement_id, rule_id,
      rule_version, signal, outcome, expected, observed, reason, evidence_json, created_at
    ) VALUES (
      ${findingId}, ${tenantId}, ${organizationId}::uuid, ${projectId}, ${scanId},
      ${finding.requirementId}, ${finding.ruleId}, ${finding.ruleVersion}, ${finding.signal},
      ${finding.outcome}, ${finding.expected}, ${finding.observed}, ${finding.reason}, '{}'::jsonb, NOW()
    );
  `;
  await tx.$executeRaw`
    INSERT INTO organization_github_installations (
      id, organization_id, github_installation_id, github_account_id, github_account_login,
      github_account_type, status, verified_permissions, connected_by_identity_user_id,
      created_at, updated_at, verified_at
    ) VALUES (
      ${installationId}::uuid, ${organizationId}::uuid, ${installationGithubId}, ${installationGithubId + 1n},
      'claim-test', 'Organization', 'active', '{"metadata":"read"}'::jsonb,
      ${identityUserId}::uuid, NOW(), NOW(), NOW()
    );
  `;
  await tx.$executeRaw`
    INSERT INTO project_github_repositories (
      id, tenant_id, organization_id, project_id, installation_record_id, github_repository_id,
      owner_login, repository_name, status, connected_by_identity_user_id, created_at, updated_at
    ) VALUES (
      ${bindingId}::uuid, ${tenantId}, ${organizationId}::uuid, ${projectId}, ${installationId}::uuid,
      ${repositoryId}, 'claim-test', ${repositoryName}, 'active', ${identityUserId}::uuid, NOW(), NOW()
    );
  `;
  await tx.$executeRaw`
    INSERT INTO project_organization_adoptions (
      id, tenant_id, project_id, organization_id, requested_by_identity_user_id,
      approved_by_identity_user_id, status, approved_at, idempotency_key, request_hash,
      provenance, created_at, updated_at
    ) VALUES (
      ${adoptionId}::uuid, ${tenantId}, ${projectId}, ${organizationId}::uuid,
      ${identityUserId}::uuid, ${identityUserId}::uuid, 'approved', NOW(),
      ${`claim-adoption-${suffix}`}, ${HASH}, '{}'::jsonb, NOW(), NOW()
    );
  `;
  return {
    tenantId, identityUserId, organizationId, projectId, scanId, findingId,
    installationId, installationGithubId, bindingId, repositoryName, repositoryId, adoptionId, finding
  };
}

async function insertProposal(
  tx: Prisma.TransactionClient,
  graph: Graph,
  options: ProposalOptions = {}
): Promise<string> {
  const id = options.id ?? randomUUID();
  const approvalState = options.approvalState === undefined ? "approved" : options.approvalState;
  const withArtifact = options.withArtifact ?? true;
  const patch = planRemediation(graph.finding);
  const planSnapshot = {
    schemaVersion: 1,
    plannerVersion: "phase07-planner-v1",
    projectId: graph.projectId,
    finding: {
      id: graph.findingId, scanId: graph.scanId, requirementId: graph.finding.requirementId,
      ruleId: graph.finding.ruleId, ruleVersion: graph.finding.ruleVersion, signal: graph.finding.signal,
      outcome: graph.finding.outcome, expected: graph.finding.expected, observed: graph.finding.observed,
      reason: graph.finding.reason
    },
    repository: {
      bindingId: graph.bindingId, repositoryId: graph.repositoryId.toString(),
      installationRecordId: graph.installationId, owner: "claim-test", name: graph.repositoryName
    },
    patch: {
      filePath: patch.filePath, title: patch.prTitle, body: patch.prBody,
      commitMessage: patch.commitMessage, summary: patch.summary
    }
  };
  const planHash = createHash("sha256").update(JSON.stringify(planSnapshot), "utf8").digest("hex");
  const sealed = makeSealedArtifact(graph, id, planHash, options.artifactScopeOverrides);
  const executionHash = options.executionHash ?? options.artifactHash ?? sealed.artifactHash;
  const artifactPayload = options.artifactMutator
    ? options.artifactMutator(structuredClone(sealed.artifact) as unknown as Record<string, unknown>)
    : options.artifact ?? sealed.artifact;
  const artifact = withArtifact ? JSON.stringify(artifactPayload) : null;
  const approvedHash = options.approvedHash === undefined
    ? (approvalState === "approved" && withArtifact ? executionHash : null)
    : options.approvedHash;
  const approvedBy = approvalState === "approved" ? graph.identityUserId : null;
  const approvedAt = approvalState === "approved" ? new Date("2026-01-01T00:00:00.000Z") : null;
  const rejectedBy = approvalState === "rejected" ? graph.identityUserId : null;
  const rejectedAt = approvalState === "rejected" ? new Date("2026-01-01T00:00:00.000Z") : null;
  const invalidatedBy = approvalState === "invalidated" ? graph.identityUserId : null;
  const invalidatedAt = approvalState === "invalidated" ? new Date("2026-01-01T00:00:00.000Z") : null;

  await tx.$executeRaw`
    INSERT INTO remediations (
      id, tenant_id, organization_id, project_id, scan_id, finding_id,
      requested_by_identity_user_id, repository_binding_id, github_repository_id,
      plan_hash, plan_snapshot, execution_artifact, execution_artifact_hash, approved_artifact_hash,
      approval_state, approved_by_identity_user_id, approved_at,
      rejected_by_identity_user_id, rejected_at, invalidated_by_identity_user_id, invalidated_at,
      idempotency_key, status, retries_left, next_attempt_at, created_at, updated_at
    ) VALUES (
      ${id}, ${graph.tenantId}, ${graph.organizationId}::uuid, ${graph.projectId}, ${graph.scanId}, ${graph.findingId},
      ${graph.identityUserId}::uuid, ${graph.bindingId}::uuid, ${graph.repositoryId},
      ${planHash}, ${JSON.stringify(planSnapshot)}::jsonb,
      ${artifact}::jsonb, ${withArtifact ? executionHash : null}, ${approvedHash},
      ${approvalState}, ${approvedBy}::uuid, ${approvedAt}, ${rejectedBy}::uuid, ${rejectedAt},
      ${invalidatedBy}::uuid, ${invalidatedAt}, ${`claim-test-${id}`}, ${options.status ?? "pending"},
      3, ${new Date(Date.now() + 60 * 60 * 1000)}, ${options.createdAt ?? new Date()}, NOW()
    );
  `;
  return id;
}

function makeSealedArtifact(graph: Graph, proposalId: string, planHash: string, scopeOverrides: Record<string, string> = {}) {
  const scope = {
    proposalId, tenantId: graph.tenantId, organizationId: graph.organizationId, projectId: graph.projectId,
    repositoryBindingId: graph.bindingId, githubRepositoryId: graph.repositoryId.toString(),
    installationRecordId: graph.installationId, planHash, ...scopeOverrides
  };
  return renderExecutionArtifact({
    scope,
    finding: graph.finding,
    snapshot: {
      immutableRepositoryId: scope.githubRepositoryId,
      baseRef: "main",
      baseCommitSha: BASE_SHA,
      filePath: "config/observability/metrics.yaml",
      file: { content: null, contentBase64: null, blobSha: null, mode: null, fileType: null, isRegularFile: true }
    },
    createdAt: new Date("2026-01-01T00:00:00.000Z")
  });
}

async function expectClaimDenied(
  tx: Prisma.TransactionClient,
  repo: RemediationJobRepository,
  remediationId: string,
  label: string
): Promise<void> {
  await tx.$executeRaw`
    UPDATE remediations SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = ${remediationId};
  `;
  const claim = await repo.claimNextPending(`claim-test-${label}`, 60_000);
  assert.equal(claim, null, `${label} must not be claimable`);
  await tx.$executeRaw`UPDATE remediations SET next_attempt_at = ${new Date(Date.now() + 60 * 60 * 1000)} WHERE id = ${remediationId};`;
}

async function assertConstraintRejects(
  tx: Prisma.TransactionClient,
  operation: () => Promise<unknown>,
  label: string
): Promise<void> {
  await tx.$executeRawUnsafe("SAVEPOINT claim_test_rejected_write");
  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  } finally {
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT claim_test_rejected_write");
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT claim_test_rejected_write");
  }
  assert.ok(rejected, `${label} must be rejected by PostgreSQL`);
}

async function verifyMigrationHistory(prisma: PrismaClient): Promise<void> {
  const migrationsDir = path.resolve(process.cwd(), "prisma", "migrations");
  const directories = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(directories, [...EXPECTED_MIGRATIONS], "canonical migration directory sequence changed");
  const rows = await prisma.$queryRaw<Array<{
    migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null;
  }>>`SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name;`;
  assert.deepEqual(rows.map((row) => row.migration_name), [...EXPECTED_MIGRATIONS]);
  for (const row of rows) {
    assert.ok(row.finished_at && !row.rolled_back_at, `migration ${row.migration_name} must be successfully applied`);
    const sql = await readFile(path.join(migrationsDir, row.migration_name, "migration.sql"));
    assert.equal(row.checksum, createHash("sha256").update(sql).digest("hex"),
      `migration checksum mismatch for ${row.migration_name}`);
  }
}

async function verifyDatabaseProtections(prisma: PrismaClient): Promise<void> {
  const constraints = await prisma.$queryRaw<Array<{ name: string; kind: string; definition: string }>>`
    SELECT conname AS name, contype AS kind, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'remediations'::regclass;
  `;
  const byName = new Map(constraints.map((constraint) => [constraint.name, constraint]));
  for (const name of [
    "ck_remediations_approval_state",
    "ck_remediations_proposal_context",
    "ck_remediations_approval_timestamps",
    "ck_remediations_execution_artifact",
    "ck_remediations_approval_repository_id"
  ]) assert.ok(byName.has(name), `required remediation constraint ${name} is missing`);
  const artifactCheck = byName.get("ck_remediations_execution_artifact")!.definition;
  assert.match(artifactCheck, /jsonb_typeof/i);
  assert.match(artifactCheck, /execution_artifact_hash/i);
  assert.match(artifactCheck, /approved_artifact_hash/i);

  // PostgreSQL truncates identifiers longer than NAMEDATALEN, so FK integrity
  // is verified from catalog structure rather than hard-coded constraint names.
  const foreignKeys = await prisma.$queryRaw<Array<{
    sourceRelation: string;
    referencedRelation: string;
    constraintType: string;
    validated: boolean;
    sourceColumns: string[];
    referencedColumns: string[];
  }>>`
    SELECT source_table.relname AS "sourceRelation",
           referenced_table.relname AS "referencedRelation",
           constraint_row.contype AS "constraintType",
           constraint_row.convalidated AS validated,
           ARRAY(
             SELECT source_column.attname::text
             FROM unnest(constraint_row.conkey) WITH ORDINALITY AS source_key(attnum, ordinal)
             JOIN pg_attribute AS source_column
               ON source_column.attrelid = constraint_row.conrelid
              AND source_column.attnum = source_key.attnum
             ORDER BY source_key.ordinal
           ) AS "sourceColumns",
           ARRAY(
             SELECT referenced_column.attname::text
             FROM unnest(constraint_row.confkey) WITH ORDINALITY AS referenced_key(attnum, ordinal)
             JOIN pg_attribute AS referenced_column
               ON referenced_column.attrelid = constraint_row.confrelid
              AND referenced_column.attnum = referenced_key.attnum
             ORDER BY referenced_key.ordinal
           ) AS "referencedColumns"
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS source_table ON source_table.oid = constraint_row.conrelid
    JOIN pg_namespace AS source_schema ON source_schema.oid = source_table.relnamespace
    JOIN pg_class AS referenced_table ON referenced_table.oid = constraint_row.confrelid
    WHERE source_schema.nspname = current_schema()
      AND source_table.relname = 'remediations'
      AND constraint_row.contype = 'f';
  `;

  function assertForeignKey(
    referencedRelation: string,
    sourceColumns: string[],
    referencedColumns: string[]
  ): void {
    const matches = foreignKeys.filter((foreignKey) =>
      foreignKey.sourceRelation === "remediations" &&
      foreignKey.referencedRelation === referencedRelation &&
      foreignKey.constraintType === "f" &&
      JSON.stringify(foreignKey.sourceColumns) === JSON.stringify(sourceColumns) &&
      JSON.stringify(foreignKey.referencedColumns) === JSON.stringify(referencedColumns)
    );
    assert.equal(matches.length, 1,
      `expected one validated remediations -> ${referencedRelation} foreign key for (${sourceColumns.join(", ")})`);
    assert.equal(matches[0].validated, true,
      `remediations -> ${referencedRelation} foreign key must be validated`);
  }

  assertForeignKey("projects", ["tenant_id", "project_id"], ["tenant_id", "id"]);
  assertForeignKey("projects", ["tenant_id", "organization_id", "project_id"],
    ["tenant_id", "organization_id", "id"]);
  assertForeignKey("scans", ["tenant_id", "scan_id"], ["tenant_id", "id"]);
  assertForeignKey("scans", ["tenant_id", "organization_id", "project_id", "scan_id"],
    ["tenant_id", "organization_id", "project_id", "id"]);
  assertForeignKey("findings", ["tenant_id", "finding_id"], ["tenant_id", "id"]);
  assertForeignKey("findings", ["tenant_id", "organization_id", "project_id", "scan_id", "finding_id"],
    ["tenant_id", "organization_id", "project_id", "scan_id", "id"]);
  assertForeignKey("project_github_repositories",
    ["tenant_id", "organization_id", "project_id", "repository_binding_id", "github_repository_id"],
    ["tenant_id", "organization_id", "project_id", "id", "github_repository_id"]);

  const trigger = await prisma.$queryRaw<Array<{
    enabled: string; triggerDefinition: string; functionDefinition: string;
  }>>`
    SELECT t.tgenabled AS enabled,
           pg_get_triggerdef(t.oid) AS "triggerDefinition",
           pg_get_functiondef(p.oid) AS "functionDefinition"
    FROM pg_trigger AS t
    JOIN pg_class AS c ON c.oid = t.tgrelid
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    JOIN pg_proc AS p ON p.oid = t.tgfoid
    WHERE n.nspname = current_schema()
      AND c.relname = 'remediations'
      AND t.tgname = 'trg_remediations_execution_artifact_immutable'
      AND NOT t.tgisinternal;
  `;
  assert.equal(trigger.length, 1, "artifact immutability trigger must exist exactly once");
  assert.ok(["O", "A"].includes(trigger[0].enabled), "artifact trigger must be enabled");
  assert.match(trigger[0].triggerDefinition, /BEFORE/i);
  assert.match(trigger[0].functionDefinition, /OLD\."execution_artifact" IS NOT NULL/i);
  assert.match(trigger[0].functionDefinition, /RAISE EXCEPTION/i);
  assert.match(trigger[0].functionDefinition, /immutable/i);

  const indexes = await prisma.$queryRaw<Array<{
    name: string; unique: boolean; definition: string; predicate: string | null;
  }>>`
    SELECT index_class.relname AS name,
           index_info.indisunique AS unique,
           pg_get_indexdef(index_info.indexrelid) AS definition,
           pg_get_expr(index_info.indpred, index_info.indrelid) AS predicate
    FROM pg_index AS index_info
    JOIN pg_class AS table_class ON table_class.oid = index_info.indrelid
    JOIN pg_class AS index_class ON index_class.oid = index_info.indexrelid
    JOIN pg_namespace AS n ON n.oid = table_class.relnamespace
    WHERE n.nspname = current_schema()
      AND table_class.relname = 'project_github_repositories'
      AND index_class.relname IN (
        'uq_project_github_repos_active_project',
        'uq_project_github_repos_active_repo'
      );
  `;
  assert.equal(indexes.length, 2, "both SQL-managed partial unique indexes must exist");
  const projectIndex = indexes.find((index) => index.name === "uq_project_github_repos_active_project")!;
  const repoIndex = indexes.find((index) => index.name === "uq_project_github_repos_active_repo")!;
  function hasExactActiveOnlyPredicate(predicate: string | null): boolean {
    if (!predicate) return false;
    const normalized = predicate
      .replace(/::\s*(?:text|varchar|character\s+varying|bpchar|char(?:acter)?(?:\s*\(\d+\))?)/gi, "")
      .replace(/\s+/g, "")
      .replace(/[()]/g, "");
    return normalized === "status='active'";
  }
  for (const index of [projectIndex, repoIndex]) {
    assert.equal(index.unique, true, `${index.name} must be unique`);
    assert.equal(hasExactActiveOnlyPredicate(index.predicate), true,
      `${index.name} predicate must be exactly status = 'active'`);
  }
  assert.match(projectIndex.definition, /tenant_id.*organization_id.*project_id/i);
  assert.match(repoIndex.definition, /organization_id.*github_repository_id/i);
}

test("PostgreSQL remediation claim eligibility, constraints, and lease fencing", async () => {
  const explicitUrl = parseApprovedUrl(DATABASE_URL).toString();
  const prisma = new PrismaClient({ datasources: { db: { url: explicitUrl } } });
  const fixtureTenantIds: string[] = [];
  try {
    await prisma.$connect();
    const identity = await prisma.$queryRaw<Array<{
      database: string; username: string; serverPort: number;
    }>>`SELECT current_database() AS database, current_user AS username, inet_server_port() AS "serverPort";`;
    assert.equal(identity[0]?.database, "cloudpilot_claim_test");
    assert.equal(identity[0]?.username, "cloudpilot_claim_test");
    assert.equal(Number(identity[0]?.serverPort), 5432);
    await verifyMigrationHistory(prisma);
    await verifyDatabaseProtections(prisma);

    const pendingBefore = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM remediations WHERE status = 'pending';
    `;
    assert.equal(pendingBefore[0]?.count, 0n,
      "refusing to run against pre-existing pending jobs in the disposable claim-test database");

    let rollbackTenantIds: string[] = [];
    try {
      await prisma.$transaction(async (tx) => {
        const isolation = await tx.$queryRaw<Array<{ isolation: string }>>`
          SELECT current_setting('transaction_isolation') AS isolation;
        `;
        assert.equal(isolation[0]?.isolation, "serializable",
          "the rollback-contained claim verification runs at serializable isolation");
        const transactionClient = inCurrentTransaction(tx);
        const executionPersistence = new RemediationExecutionPersistenceService(transactionClient);
        const contexts = new TrustedClaimExecutionContextService(transactionClient);
        const repo = new RemediationJobRepository(transactionClient,
          new PrismaRemediationExecutionLifecycle(contexts, executionPersistence));
        const graphA = await createGraph(tx, "a");
        const graphB = await createGraph(tx, "b");
        rollbackTenantIds = [graphA.tenantId, graphB.tenantId];
        fixtureTenantIds.push(...rollbackTenantIds);

        const approvedId = await insertProposal(tx, graphA);
        await tx.$executeRaw`
          UPDATE remediations SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = ${approvedId};
        `;
        const lease = await repo.claimNextPending("claim-test-approved", 60_000);
        assert.ok(lease, "valid approved proposal and artifact should be claimable");
        assert.equal(lease.id, approvedId);
        assert.equal(lease.tenantId, graphA.tenantId);
        assert.match(lease.leaseToken, /^[0-9a-f-]{36}$/i);
        assert.ok(lease.workerId === "claim-test-approved");

        const pendingId = await insertProposal(tx, graphA, { approvalState: "pending" });
        const rejectedId = await insertProposal(tx, graphA, { approvalState: "rejected" });
        const invalidatedId = await insertProposal(tx, graphA, { approvalState: "invalidated" });
        const unapprovedStatusId = await insertProposal(tx, graphA, { approvalState: "pending", status: "pending_approval" });
        const noArtifactId = await insertProposal(tx, graphA, { approvalState: "pending", withArtifact: false });
        const legacyId = randomUUID();
        await tx.$executeRaw`
          INSERT INTO remediations (
            id, tenant_id, organization_id, project_id, scan_id, finding_id,
            idempotency_key, status, retries_left, created_at, updated_at
          ) VALUES (
            ${legacyId}, ${graphA.tenantId}, ${graphA.organizationId}::uuid, ${graphA.projectId},
            ${graphA.scanId}, ${graphA.findingId}, ${`claim-legacy-${legacyId}`}, 'pending', 3, NOW(), NOW()
          );
        `;

        await expectClaimDenied(tx, repo, pendingId, "pending approval state");
        await expectClaimDenied(tx, repo, rejectedId, "rejected proposal");
        await expectClaimDenied(tx, repo, invalidatedId, "invalidated proposal");
        await expectClaimDenied(tx, repo, unapprovedStatusId, "pending_approval job status");
        await expectClaimDenied(tx, repo, noArtifactId, "missing artifact");
        await expectClaimDenied(tx, repo, legacyId, "legacy null approval and artifact fields");

        const unchangedHashId = await insertProposal(tx, graphA, {
          artifactMutator: (artifact) => ({ ...artifact, renderedContent: `${String(artifact.renderedContent)}# changed after sealing\\n` })
        });
        await expectClaimDenied(tx, repo, unchangedHashId, "modified artifact with unchanged canonical hashes");

        const forgedHash = "c".repeat(64);
        const forgedHashId = await insertProposal(tx, graphA, {
          artifactMutator: (artifact) => ({ ...artifact, renderedContent: `${String(artifact.renderedContent)}# forged payload\\n` }),
          executionHash: forgedHash, approvedHash: forgedHash
        });
        await expectClaimDenied(tx, repo, forgedHashId, "modified payload with equal forged stored hashes");

        const invalidArtifactCases: Array<[string, ProposalOptions]> = [
          ["incorrect tenant scope", { artifactScopeOverrides: { tenantId: graphB.tenantId } }],
          ["incorrect organization scope", { artifactScopeOverrides: { organizationId: graphB.organizationId } }],
          ["incorrect project scope", { artifactScopeOverrides: { projectId: graphB.projectId } }],
          ["incorrect proposal scope", { artifactScopeOverrides: { proposalId: graphB.projectId } }],
          ["incorrect binding scope", { artifactScopeOverrides: { repositoryBindingId: graphB.bindingId } }],
          ["incorrect repository scope", { artifactScopeOverrides: { githubRepositoryId: graphB.repositoryId.toString() } }],
          ["incorrect installation scope", { artifactScopeOverrides: { installationRecordId: graphB.installationId } }],
          ["malformed artifact", { artifact: { schemaVersion: 2 }, artifactHash: HASH }],
          ["unsupported artifact version", { artifactMutator: (artifact) => ({ ...artifact, schemaVersion: 999 }), artifactHash: HASH }]
        ];
        for (const [label, options] of invalidArtifactCases) {
          const invalidId = await insertProposal(tx, graphA, options);
          await expectClaimDenied(tx, repo, invalidId, label);
        }

        // A corrupt candidate ordered before a valid one must be skipped without
        // receiving a lease. The following valid fixture must still be claimable.
        const earlierInvalidId = await insertProposal(tx, graphA, {
          artifactMutator: (artifact) => ({ ...artifact, schemaVersion: 999 }),
          artifactHash: HASH, createdAt: new Date("2020-01-01T00:00:00.000Z")
        });
        const laterValidId = await insertProposal(tx, graphA);
        await tx.$executeRaw`UPDATE remediations SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id IN (${earlierInvalidId}, ${laterValidId});`;
        const afterInvalid = await repo.claimNextPending("claim-test-skip-invalid", 60_000);
        assert.equal(afterInvalid?.id, laterValidId, "invalid older candidate is skipped in favor of valid work");
        const invalidState = await tx.$queryRaw<Array<{ status: string; lease_token: string | null }>>`
          SELECT status, lease_token::text AS lease_token FROM remediations WHERE id = ${earlierInvalidId};
        `;
        assert.equal(invalidState[0]?.status, "pending");
        assert.equal(invalidState[0]?.lease_token, null);
        // Retire this test-owned malformed job without deleting its persisted artifact.
        await tx.$executeRaw`UPDATE remediations SET status = 'failed' WHERE id = ${earlierInvalidId};`;

        // Exactly 1,000 malformed but constraint-valid candidates exercise the
        // bounded scan. A valid 1,001st candidate must not be reached in that call.
        const boundKey = randomUUID();
        await tx.$executeRaw`
          INSERT INTO remediations (
            id, tenant_id, organization_id, project_id, scan_id, finding_id,
            requested_by_identity_user_id, repository_binding_id, github_repository_id,
            plan_hash, plan_snapshot, execution_artifact, execution_artifact_hash, approved_artifact_hash,
            approval_state, approved_by_identity_user_id, approved_at,
            idempotency_key, status, retries_left, next_attempt_at, created_at, updated_at
          )
          SELECT gen_random_uuid(), ${graphA.tenantId}, ${graphA.organizationId}::uuid, ${graphA.projectId},
            ${graphA.scanId}, ${graphA.findingId}, ${graphA.identityUserId}::uuid, ${graphA.bindingId}::uuid,
            ${graphA.repositoryId}, ${HASH}, jsonb_build_object('fixture', true),
            jsonb_build_object('schemaVersion', 999), ${HASH}, ${HASH}, 'approved',
            ${graphA.identityUserId}::uuid, NOW(), ${boundKey} || '-' || series_value::text,
            'pending', 3, NOW() - INTERVAL '1 second', NOW() - INTERVAL '1 day', NOW()
          FROM generate_series(1, 1000) AS g(series_value);
        `;
        const beyondBoundId = await insertProposal(tx, graphA);
        await tx.$executeRaw`UPDATE remediations SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = ${beyondBoundId};`;
        assert.equal(await repo.claimNextPending("claim-test-bounded-scan", 60_000), null,
          "claim scan stops after 1,000 invalid candidates");
        const beyondBoundBefore = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT status FROM remediations WHERE id = ${beyondBoundId};
        `;
        assert.equal(beyondBoundBefore[0]?.status, "pending");
        await tx.$executeRaw`UPDATE remediations SET status = 'failed' WHERE idempotency_key LIKE ${boundKey + "-%"};`;
        const afterBound = await repo.claimNextPending("claim-test-after-bound", 60_000);
        assert.equal(afterBound?.id, beyondBoundId, "valid work is claimable after the invalid batch is no longer pending");

        await assertConstraintRejects(tx, async () => {
          await insertProposal(tx, graphA, { approvalState: "approved", withArtifact: false });
        }, "approved proposal without execution artifact");
        await assertConstraintRejects(tx, async () => {
          await insertProposal(tx, graphA, { approvalState: "approved", approvedHash: "b".repeat(64) });
        }, "approval hash that differs from execution artifact hash");

        const inactiveOrgId = await insertProposal(tx, graphA);
        await tx.$executeRaw`UPDATE organizations SET status = 'suspended' WHERE id = ${graphA.organizationId}::uuid;`;
        await expectClaimDenied(tx, repo, inactiveOrgId, "inactive organization");
        await tx.$executeRaw`UPDATE organizations SET status = 'active' WHERE id = ${graphA.organizationId}::uuid;`;

        const inactiveBindingId = await insertProposal(tx, graphA);
        await tx.$executeRaw`
          UPDATE project_github_repositories SET status = 'disconnected', disconnected_at = NOW()
          WHERE id = ${graphA.bindingId}::uuid;
        `;
        await expectClaimDenied(tx, repo, inactiveBindingId, "inactive repository binding");
        await tx.$executeRaw`
          UPDATE project_github_repositories SET status = 'active', disconnected_at = NULL
          WHERE id = ${graphA.bindingId}::uuid;
        `;

        const inactiveInstallationId = await insertProposal(tx, graphA);
        await tx.$executeRaw`
          UPDATE organization_github_installations SET status = 'suspended'
          WHERE id = ${graphA.installationId}::uuid;
        `;
        await expectClaimDenied(tx, repo, inactiveInstallationId, "inactive installation");
        await tx.$executeRaw`
          UPDATE organization_github_installations SET status = 'active'
          WHERE id = ${graphA.installationId}::uuid;
        `;

        const noAdoptionId = await insertProposal(tx, graphA);
        await tx.$executeRaw`DELETE FROM project_organization_adoptions WHERE id = ${graphA.adoptionId}::uuid;`;
        await expectClaimDenied(tx, repo, noAdoptionId, "missing approved adoption");
        await tx.$executeRaw`
          INSERT INTO project_organization_adoptions (
            id, tenant_id, project_id, organization_id, requested_by_identity_user_id,
            approved_by_identity_user_id, status, approved_at, idempotency_key, request_hash,
            provenance, created_at, updated_at
          ) VALUES (
            ${graphA.adoptionId}::uuid, ${graphA.tenantId}, ${graphA.projectId}, ${graphA.organizationId}::uuid,
            ${graphA.identityUserId}::uuid, ${graphA.identityUserId}::uuid, 'approved', NOW(),
            ${`claim-adoption-a`}, ${HASH}, '{}'::jsonb, NOW(), NOW()
          );
        `;
        const rejectedAdoptionId = await insertProposal(tx, graphA);
        await tx.$executeRaw`
          UPDATE project_organization_adoptions
          SET status = 'rejected', approved_by_identity_user_id = NULL, approved_at = NULL, rejected_at = NOW()
          WHERE id = ${graphA.adoptionId}::uuid;
        `;
        await expectClaimDenied(tx, repo, rejectedAdoptionId, "rejected adoption");
        // Restore the shared authorization fixture before later lease-reclaim
        // assertions; the claim query correctly requires approved adoption.
        await tx.$executeRaw`
          UPDATE project_organization_adoptions
          SET status = 'approved', approved_by_identity_user_id = ${graphA.identityUserId}::uuid,
              approved_at = NOW(), rejected_at = NULL, updated_at = NOW()
          WHERE id = ${graphA.adoptionId}::uuid;
        `;

        // Composite foreign keys reject each inconsistent scope before a job can
        // persist. Each failed write is isolated by a savepoint; no constraint is bypassed.
        const scopeMismatches: Array<[string, Partial<Graph>]> = [
          ["tenant mismatch", { tenantId: graphB.tenantId }],
          ["project mismatch", { projectId: graphB.projectId }],
          ["scan mismatch", { scanId: graphB.scanId }],
          ["finding mismatch", { findingId: graphB.findingId }],
          ["organization mismatch", { organizationId: graphB.organizationId }],
          ["repository binding mismatch", { bindingId: graphB.bindingId, repositoryId: graphB.repositoryId }],
          ["immutable repository ID mismatch", { repositoryId: graphB.repositoryId }]
        ];
        for (const [label, changes] of scopeMismatches) {
          const mismatched = { ...graphA, ...changes };
          await assertConstraintRejects(tx, async () => insertProposal(tx, mismatched), label);
        }

        const triggerProbeId = await insertProposal(tx, graphA);
        await assertConstraintRejects(tx, async () => {
          await tx.$executeRaw`
            UPDATE remediations SET execution_artifact_hash = ${"b".repeat(64)}
            WHERE id = ${triggerProbeId};
          `;
        }, "changing an immutable execution artifact hash");
        await assertConstraintRejects(tx, async () => {
          await tx.$executeRaw`DELETE FROM remediations WHERE id = ${triggerProbeId};`;
        }, "deleting a remediation with an immutable artifact");

        const futureRetry = await repo.reclaimExpiredLeases();
        assert.deepEqual(futureRetry, { requeued: 0, failed: 0, manualReview: 0 });
        await tx.$executeRaw`
          UPDATE remediations SET lease_expires_at = NOW() - INTERVAL '1 second'
          WHERE id = ${approvedId} AND lease_token = ${lease.leaseToken}::uuid;
        `;
        const executionLeaseHash = createHash("sha256").update(lease.leaseToken, "utf8").digest("hex");
        await tx.$executeRaw`
          UPDATE remediation_executions SET lease_expires_at = clock_timestamp() - INTERVAL '1 second'
          WHERE remediation_id = ${approvedId} AND lease_token_hash = ${executionLeaseHash};
        `;
        assert.deepEqual(await repo.reclaimExpiredLeases(), { requeued: 1, failed: 0, manualReview: 0 });
        assert.equal(await repo.completeLease(lease, {
          kind: "pull-request", disposition: "created", branchName: "claim-test/stale",
          prNumber: 1, prUrl: "https://github.com/example/claim-test/pull/1", summary: "stale"
        }), false, "expired lease token cannot complete the requeued job");
        await tx.$executeRaw`
          UPDATE remediations SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = ${approvedId};
        `;
        const reclaimed = await repo.claimNextPending("claim-test-reclaimed", 60_000);
        assert.ok(reclaimed);
        assert.equal(reclaimed.id, approvedId);
        assert.notEqual(reclaimed.leaseToken, lease.leaseToken);
        assert.equal(await repo.renewLease(lease), false, "old token cannot renew after reclaim");
        assert.equal(await repo.completeLease(lease, {
          kind: "pull-request", disposition: "created", branchName: "claim-test/stale",
          prNumber: 2, prUrl: "https://github.com/example/claim-test/pull/2", summary: "stale"
        }), false, "old token cannot complete after reclaim");
        assert.equal(await repo.renewLease(reclaimed), true, "current token can renew");
        assert.equal(await repo.completeLease(reclaimed, {
          kind: "pull-request", disposition: "created", branchName: "claim-test/current",
          prNumber: 3, prUrl: "https://github.com/example/claim-test/pull/3", summary: "current"
        }), false, "queue status alone cannot complete an execution; only the durable lifecycle can settle it");

        // Calls share this rollback transaction and one PostgreSQL connection.
        // This remains a sequential claim smoke test, not independent-worker contention.
        const contentionId = await insertProposal(tx, graphA);
        await tx.$executeRaw`
          UPDATE remediations SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = ${contentionId};
        `;
        const competing = await Promise.all(Array.from({ length: 8 }, (_, index) =>
          repo.claimNextPending(`claim-test-contender-${index}`, 60_000)
        ));
        const winners = competing.filter((candidate): candidate is RemediationLease => candidate?.id === contentionId);
        assert.equal(winners.length, 1, "parallel claim calls return the test job at most once");

        throw new RollbackFixtures("roll back every claim-test fixture, claim, lease update, and audit row");
      }, { timeout: 120_000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!(error instanceof RollbackFixtures)) throw error;
    }

    for (const tenantId of fixtureTenantIds) {
      const remaining = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM tenants WHERE id = ${tenantId};
      `;
      assert.equal(remaining[0]?.count, 0n, "rollback must leave no test-owned tenant fixture");
    }
  } finally {
    await prisma.$disconnect();
  }
});
