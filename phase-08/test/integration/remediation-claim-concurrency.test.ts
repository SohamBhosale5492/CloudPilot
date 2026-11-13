import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { parsePhase08AcceptanceDatabase } from "./acceptance-database.js";
import { planRemediation, type FindingSummary } from "../../../phase-07/src/remediation/planner.js";
import { RemediationJobRepository } from "../../src/jobs/remediation-repo.js";
import { PrismaRemediationExecutionLifecycle } from "../../src/jobs/remediation-execution-lifecycle.js";
import { RemediationExecutionPersistenceService } from "../../src/remediation/remediation-execution-persistence.js";
import { renderExecutionArtifact } from "../../src/remediation/execution-artifact.js";
import { TrustedClaimExecutionContextService } from "../../src/remediation/trusted-claim-execution-context.js";

const acceptanceDatabase = parsePhase08AcceptanceDatabase(process.env.CLOUDPILOT_PHASE08_ACCEPTANCE_TEST_DATABASE_URL);
const DATABASE_URL = acceptanceDatabase?.url ?? process.env.CLOUDPILOT_CLAIM_CONCURRENCY_FRESH_TEST_DATABASE_URL;
const expectedDatabase = acceptanceDatabase?.database ?? "cloudpilot_claim_concurrency_fresh_test";
const expectedUsername = acceptanceDatabase?.username ?? "cloudpilot_claim_concurrency_fresh_test";
if (!DATABASE_URL) {
  throw new Error("An explicit dedicated concurrency or Phase 08 acceptance database URL is required; no fallback is permitted.");
}

const MIGRATIONS = [
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
] as const;

const ARTIFACT_HASH_SEED = "a".repeat(64);
const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const CANDIDATE_QUERY_MARKER = "FOR UPDATE OF r SKIP LOCKED";
type TransactionOptions = { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel };

function validateDatabaseUrl(value: string): URL {
  if (acceptanceDatabase) {
    if (value !== acceptanceDatabase.url) throw new Error("Refusing a database URL different from the validated acceptance target.");
    return new URL(acceptanceDatabase.url);
  }
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Concurrency database URL is malformed."); }
  const forbiddenOverrides = ["host", "port", "dbname", "database", "user", "username"];
  if (!(url.protocol === "postgres:" || url.protocol === "postgresql:") ||
      !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname) ||
      url.port !== "56438" || url.pathname.replace(/^\//, "") !== "cloudpilot_claim_concurrency_fresh_test" ||
      decodeURIComponent(url.username) !== "cloudpilot_claim_concurrency_fresh_test" || url.password.length === 0 || url.hash ||
      forbiddenOverrides.some((key) => url.searchParams.has(key))) {
    throw new Error("CLOUDPILOT_CLAIM_CONCURRENCY_FRESH_TEST_DATABASE_URL must target loopback port 56438, database/user cloudpilot_claim_concurrency_fresh_test.");
  }
  return url;
}

function isPrivateContainerAddress(cidr: string | null): boolean {
  if (!cidr) return false;
  const address = cidr.split("/")[0]!;
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

async function verifyMigrations(prisma: PrismaClient): Promise<void> {
  const migrationsDir = path.resolve(process.cwd(), "prisma", "migrations");
  const diskNames = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(diskNames, [...MIGRATIONS], "repository migration sequence must contain exactly the 17 approved migrations");
  const rows = await prisma.$queryRaw<Array<{ migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null }>>`
    SELECT migration_name, checksum, finished_at, rolled_back_at
    FROM "_prisma_migrations" ORDER BY migration_name;
  `;
  assert.deepEqual(rows.map((row) => row.migration_name), [...MIGRATIONS]);
  for (const row of rows) {
    assert.ok(row.finished_at && !row.rolled_back_at, `migration ${row.migration_name} must be applied successfully`);
    const sql = await readFile(path.join(migrationsDir, row.migration_name, "migration.sql"));
    assert.equal(row.checksum, createHash("sha256").update(sql).digest("hex"),
      `migration checksum mismatch for ${row.migration_name}`);
  }
}

class TwoPartyBarrier {
  arrivals = 0;
  private resolveGate!: () => void;
  private rejectGate!: (error: Error) => void;
  private released = false;
  private readonly gate: Promise<void>;
  private readonly timeout: ReturnType<typeof setTimeout>;

  constructor(timeoutMs: number) {
    this.gate = new Promise<void>((resolve, reject) => {
      this.resolveGate = resolve;
      this.rejectGate = reject;
    });
    this.timeout = setTimeout(() => this.reject(new Error("Claim concurrency synchronization timed out.")), timeoutMs);
    this.timeout.unref?.();
  }

  async arrive(): Promise<void> {
    this.arrivals++;
    if (this.arrivals === 2) this.release();
    await this.gate;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    clearTimeout(this.timeout);
    this.resolveGate();
  }

  private reject(error: Error): void {
    if (this.released) return;
    this.released = true;
    clearTimeout(this.timeout);
    this.rejectGate(error);
  }
}

function isSerializationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  return record.code === "P2034" || record.code === "40001" || record.meta?.code === "40001" ||
    (typeof record.message === "string" && /serialization failure|could not serialize access/i.test(record.message));
}

interface CandidateObservation {
  workerId: string;
  backendPid: number;
  rowCount: number | null;
  serializationFailure: boolean;
}

// Candidate rows are recorded by a narrower wrapper so we can assert that the
// lock winner held its row while the other independent transaction selected.
function instrumentCandidateResult(client: PrismaClient, barrier: TwoPartyBarrier, workerId: string,
  observations: CandidateObservation[]): PrismaClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === "$transaction") {
        const transaction = Reflect.get(target, property, target) as (
          callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: TransactionOptions
        ) => Promise<unknown>;
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: TransactionOptions) =>
          transaction.call(target, async (tx) => {
            const backend = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid;`;
            const backendPid = Number(backend[0]?.pid);
            return callback(new Proxy(tx, {
              get(inner, innerProperty) {
                if (innerProperty === "$queryRaw") {
                  const query = Reflect.get(inner, innerProperty, inner) as (...args: unknown[]) => Promise<unknown>;
                  return async (...args: unknown[]) => {
                    const template = args[0];
                    const sqlText = Array.isArray(template) ? template.join(" ") : "";
                    const candidateLock = sqlText.includes(CANDIDATE_QUERY_MARKER);
                    try {
                      const result = await query.apply(inner, args);
                      if (candidateLock) {
                        const rowCount = Array.isArray(result) ? result.length : null;
                        observations.push({ workerId, backendPid, rowCount, serializationFailure: false });
                        await barrier.arrive();
                      }
                      return result;
                    } catch (error) {
                      if (candidateLock && isSerializationFailure(error)) {
                        observations.push({ workerId, backendPid, rowCount: null, serializationFailure: true });
                        await barrier.arrive();
                      }
                      throw error;
                    }
                  };
                }
                const value = Reflect.get(inner, innerProperty, inner) as unknown;
                return typeof value === "function" ? value.bind(inner) : value;
              }
            }));
          }, { ...options, maxWait: 10_000, timeout: 30_000 });
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as PrismaClient;
}

async function createCommittedFixture(prisma: PrismaClient): Promise<{ tenantId: string; remediationId: string }> {
  const tenantId = randomUUID();
  const identityId = randomUUID();
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const scanId = randomUUID();
  const findingId = randomUUID();
  const installationId = randomUUID();
  const bindingId = randomUUID();
  const adoptionId = randomUUID();
  const remediationId = randomUUID();
  const repositoryId = BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`) + 100_000_000_000n;
  const githubInstallationId = repositoryId + 100n;
  const owner = "claim-concurrency-fixture";
  const repositoryName = `repo-${remediationId.slice(0, 8)}`;
  const finding: FindingSummary = {
    requirementId: `claim-concurrency-${remediationId}`,
    ruleId: "observability.metric.present",
    ruleVersion: "1.0.0",
    signal: "metric",
    outcome: "gap",
    expected: "Request metric is configured",
    observed: "Request metric is missing",
    reason: "Disposable claim concurrency fixture"
  };
  const patch = planRemediation(finding);
  const planSnapshot = {
    schemaVersion: 1,
    plannerVersion: "phase07-planner-v1",
    projectId,
    finding: {
      id: findingId, scanId, requirementId: finding.requirementId, ruleId: finding.ruleId,
      ruleVersion: finding.ruleVersion, signal: finding.signal, outcome: finding.outcome,
      expected: finding.expected, observed: finding.observed, reason: finding.reason
    },
    repository: { bindingId, repositoryId: repositoryId.toString(), installationRecordId: installationId, owner, name: repositoryName },
    patch: {
      filePath: patch.filePath, title: patch.prTitle, body: patch.prBody,
      commitMessage: patch.commitMessage, summary: patch.summary
    }
  };
  const planHash = createHash("sha256").update(JSON.stringify(planSnapshot), "utf8").digest("hex");
  const sealed = renderExecutionArtifact({
    scope: { proposalId: remediationId, tenantId, organizationId, projectId, repositoryBindingId: bindingId,
      githubRepositoryId: repositoryId.toString(), installationRecordId: installationId, planHash },
    finding,
    snapshot: { immutableRepositoryId: repositoryId.toString(), baseRef: "main", baseCommitSha: BASE_SHA,
      filePath: patch.filePath,
      file: { content: null, contentBase64: null, blobSha: null, mode: null, fileType: null, isRegularFile: true } },
    createdAt: new Date("2026-11-07T00:00:00.000Z")
  });

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO tenants (id, name) VALUES (${tenantId}, ${`claim-concurrency-${tenantId}`});`;
    await tx.$executeRaw`INSERT INTO identity_users (id, status, display_name, created_at, updated_at)
      VALUES (${identityId}::uuid, 'active', 'Claim concurrency fixture', NOW(), NOW());`;
    await tx.$executeRaw`INSERT INTO organizations (
      id, display_name, status, created_by_user_id, creation_idempotency_key, creation_request_hash, created_at, updated_at
    ) VALUES (${organizationId}::uuid, 'Claim concurrency fixture', 'active', ${identityId}::uuid,
      ${`claim-concurrency-${organizationId}`}, ${ARTIFACT_HASH_SEED}, NOW(), NOW());`;
    await tx.$executeRaw`INSERT INTO organization_members (
      organization_id, user_id, role, status, created_by_user_id, created_at, updated_at
    ) VALUES (${organizationId}::uuid, ${identityId}::uuid, 'owner', 'active', ${identityId}::uuid, NOW(), NOW());`;
    await tx.$executeRaw`INSERT INTO projects (id, tenant_id, organization_id, name, repository_url, created_at, updated_at)
      VALUES (${projectId}, ${tenantId}, ${organizationId}::uuid, 'Claim concurrency fixture', NULL, NOW(), NOW());`;
    await tx.$executeRaw`INSERT INTO scans (id, tenant_id, organization_id, project_id, status, created_at)
      VALUES (${scanId}, ${tenantId}, ${organizationId}::uuid, ${projectId}, 'completed', NOW());`;
    await tx.$executeRaw`INSERT INTO findings (
      id, tenant_id, organization_id, project_id, scan_id, requirement_id, rule_id, rule_version, signal,
      outcome, expected, observed, reason, evidence_json, created_at
    ) VALUES (${findingId}, ${tenantId}, ${organizationId}::uuid, ${projectId}, ${scanId},
      ${finding.requirementId}, ${finding.ruleId}, ${finding.ruleVersion}, ${finding.signal}, ${finding.outcome},
      ${finding.expected}, ${finding.observed}, ${finding.reason}, '{}'::jsonb, NOW());`;
    await tx.$executeRaw`INSERT INTO organization_github_installations (
      id, organization_id, github_installation_id, github_account_id, github_account_login, github_account_type,
      status, verified_permissions, connected_by_identity_user_id, created_at, updated_at, verified_at
    ) VALUES (${installationId}::uuid, ${organizationId}::uuid, ${githubInstallationId}, ${githubInstallationId + 1n},
      ${owner}, 'Organization', 'active', '{"metadata":"read"}'::jsonb, ${identityId}::uuid, NOW(), NOW(), NOW());`;
    await tx.$executeRaw`INSERT INTO project_github_repositories (
      id, tenant_id, organization_id, project_id, installation_record_id, github_repository_id,
      owner_login, repository_name, status, connected_by_identity_user_id, created_at, updated_at
    ) VALUES (${bindingId}::uuid, ${tenantId}, ${organizationId}::uuid, ${projectId}, ${installationId}::uuid,
      ${repositoryId}, ${owner}, ${repositoryName}, 'active', ${identityId}::uuid, NOW(), NOW());`;
    await tx.$executeRaw`INSERT INTO project_organization_adoptions (
      id, tenant_id, project_id, organization_id, requested_by_identity_user_id,
      approved_by_identity_user_id, status, approved_at, idempotency_key, request_hash, provenance, created_at, updated_at
    ) VALUES (${adoptionId}::uuid, ${tenantId}, ${projectId}, ${organizationId}::uuid,
      ${identityId}::uuid, ${identityId}::uuid, 'approved', NOW(), ${`claim-adoption-${adoptionId}`},
      ${ARTIFACT_HASH_SEED}, '{}'::jsonb, NOW(), NOW());`;
    await tx.$executeRaw`INSERT INTO remediations (
      id, tenant_id, organization_id, project_id, scan_id, finding_id, requested_by_identity_user_id,
      approved_by_identity_user_id, approved_at, repository_binding_id, github_repository_id,
      plan_hash, plan_snapshot, execution_artifact, execution_artifact_hash, approved_artifact_hash,
      approval_state, idempotency_key, status, retries_left, next_attempt_at, created_at, updated_at
    ) VALUES (${remediationId}, ${tenantId}, ${organizationId}::uuid, ${projectId}, ${scanId}, ${findingId},
      ${identityId}::uuid, ${identityId}::uuid, NOW(), ${bindingId}::uuid, ${repositoryId},
      ${planHash}, ${JSON.stringify(planSnapshot)}::jsonb, ${JSON.stringify(sealed.artifact)}::jsonb,
      ${sealed.artifactHash}, ${sealed.artifactHash}, 'approved', ${`claim-${remediationId}`}, 'pending', 3,
      NOW() - INTERVAL '1 second', NOW(), NOW());`;
  });
  return { tenantId, remediationId };
}

test("independent PostgreSQL transactions allow exactly one durable remediation claim", { timeout: 120_000 }, async (t) => {
  const approvedUrl = validateDatabaseUrl(DATABASE_URL).toString();
  const clients = [0, 1].map(() => new PrismaClient({ datasources: { db: { url: approvedUrl } } }));
  const barrier = new TwoPartyBarrier(15_000);
  const observations: CandidateObservation[] = [];
  let tenantId: string | null = null;
  try {
    for (const client of clients) await client.$connect();
    const identityRows = await clients[0]!.$queryRaw<Array<{
      database: string; username: string; serverAddress: string | null; serverPort: number; readOnly: string;
    }>>`SELECT current_database() AS database, current_user AS username, inet_server_addr()::text AS "serverAddress",
              inet_server_port() AS "serverPort", current_setting('transaction_read_only') AS "readOnly";`;
    assert.equal(identityRows[0]?.database, expectedDatabase);
    assert.equal(identityRows[0]?.username, expectedUsername);
    assert.equal(Number(identityRows[0]?.serverPort), 5432);
    assert.ok(isPrivateContainerAddress(identityRows[0]?.serverAddress ?? null), "server address must be private container IPv4");
    assert.equal(identityRows[0]?.readOnly, "off", "the disposable test database must accept fixture writes");
    await verifyMigrations(clients[0]!);

    const existing = await clients[0]!.$queryRaw<Array<{ remediations: bigint; executions: bigint; events: bigint }>>`
      SELECT (SELECT count(*) FROM remediations) AS remediations,
             (SELECT count(*) FROM remediation_executions) AS executions,
             (SELECT count(*) FROM remediation_execution_events) AS events;
    `;
    const freshnessContext = `database=${identityRows[0]?.database} role=${identityRows[0]?.username} counts(remediations=${existing[0]?.remediations}, executions=${existing[0]?.executions}, events=${existing[0]?.events}); expected all zero; no cleanup attempted`;
    assert.equal(existing[0]?.remediations, 0n, `fresh disposable database required: ${freshnessContext}`);
    assert.equal(existing[0]?.executions, 0n, `fresh disposable database required: ${freshnessContext}`);
    assert.equal(existing[0]?.events, 0n, `fresh disposable database required: ${freshnessContext}`);

    const fixture = await createCommittedFixture(clients[0]!);
    tenantId = fixture.tenantId;
    const workerIds = ["concurrency-worker-a", "concurrency-worker-b"];
    const repositories = clients.map((client, index) => {
      const persistence = new RemediationExecutionPersistenceService(client);
      const context = new TrustedClaimExecutionContextService(client);
      const lifecycle = new PrismaRemediationExecutionLifecycle(context, persistence);
      const instrumented = instrumentCandidateResult(client, barrier, workerIds[index]!, observations);
      return new RemediationJobRepository(instrumented, lifecycle);
    });
    const attempts = await Promise.allSettled(repositories.map((repository, index) =>
      repository.claimNextPending(workerIds[index]!, 60_000)));
    barrier.release();

    assert.equal(barrier.arrivals, 2, "both independent transactions reached the locked candidate selection");
    assert.deepEqual(observations.map((row) => row.workerId).sort(), [...workerIds].sort());
    assert.equal(new Set(observations.map((row) => row.backendPid)).size, 2, "transactions must use distinct PostgreSQL backend PIDs");
    assert.equal(observations.filter((row) => row.rowCount === 1).length, 1, "exactly one transaction must hold the candidate row lock");
    assert.equal(observations.filter((row) => row.rowCount === 0).length +
      observations.filter((row) => row.serializationFailure).length, 1, "the competing transaction must skip or abort as a serialization loser");

    const leases = attempts.filter((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<RemediationJobRepository["claimNextPending"]>>> =>
      attempt.status === "fulfilled" && attempt.value !== null).map((attempt) => attempt.value!);
    const serializationLosers = attempts.filter((attempt) => attempt.status === "rejected" && isSerializationFailure(attempt.reason));
    const nullLosers = attempts.filter((attempt) => attempt.status === "fulfilled" && attempt.value === null);
    assert.equal(leases.length, 1, "exactly one transaction claims the remediation");
    assert.equal(nullLosers.length + serializationLosers.length, 1, "the other transaction returns no claim or a serialization failure");
    assert.ok(attempts.every((attempt) => attempt.status === "fulfilled" ||
      (attempt.status === "rejected" && isSerializationFailure(attempt.reason))), "unexpected claim errors fail the test");

    const lease = leases[0]!;
    assert.equal(lease.id, fixture.remediationId);
    assert.ok(workerIds.includes(lease.workerId));
    assert.match(lease.leaseToken, /^[0-9a-f-]{36}$/i);

    const queueRows = await clients[0]!.$queryRaw<Array<{
      status: string; workerId: string | null; leaseToken: string | null; leaseValid: boolean;
    }>>`SELECT status, worker_id AS "workerId", lease_token::text AS "leaseToken",
              lease_expires_at > clock_timestamp() AS "leaseValid"
        FROM remediations WHERE id = ${fixture.remediationId} AND tenant_id = ${fixture.tenantId};`;
    assert.equal(queueRows.length, 1);
    assert.equal(queueRows[0]?.status, "running");
    assert.equal(queueRows[0]?.workerId, lease.workerId);
    assert.equal(queueRows[0]?.leaseToken, lease.leaseToken);
    assert.equal(queueRows[0]?.leaseValid, true);

    const executionRows = await clients[0]!.$queryRaw<Array<{
      count: bigint; status: string; owner: string | null; tokenHash: string | null; leaseValid: boolean;
    }>>`SELECT count(*) OVER () AS count, status, lease_owner AS owner, lease_token_hash AS "tokenHash",
              lease_expires_at > clock_timestamp() AS "leaseValid"
        FROM remediation_executions WHERE remediation_id = ${fixture.remediationId} AND tenant_id = ${fixture.tenantId};`;
    assert.equal(executionRows.length, 1, "one durable execution is created");
    assert.equal(executionRows[0]?.count, 1n);
    assert.equal(executionRows[0]?.status, "execution_started");
    assert.equal(executionRows[0]?.owner, lease.workerId);
    assert.equal(executionRows[0]?.tokenHash, createHash("sha256").update(lease.leaseToken).digest("hex"));
    assert.equal(executionRows[0]?.leaseValid, true);

    const eventRows = await clients[0]!.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM remediation_execution_events e
      JOIN remediation_executions x ON x.id = e.execution_id
      WHERE x.remediation_id = ${fixture.remediationId} AND x.tenant_id = ${fixture.tenantId}
        AND e.event_type = 'execution_started';
    `;
    assert.equal(eventRows[0]?.count, 1n, "one execution-started journal event is committed");
    const allEvents = await clients[0]!.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM remediation_execution_events e
      JOIN remediation_executions x ON x.id = e.execution_id
      WHERE x.remediation_id = ${fixture.remediationId} AND x.tenant_id = ${fixture.tenantId};
    `;
    assert.equal(allEvents[0]?.count, 1n, "the losing claim creates no duplicate journal entries");
    const executionAudits = await clients[0]!.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM organization_audit_events
      WHERE tenant_id = ${fixture.tenantId} AND action = 'REMEDIATION_EXECUTION_STARTED'
        AND target_type = 'remediation_execution'
        AND target_id = (SELECT id::text FROM remediation_executions WHERE remediation_id = ${fixture.remediationId});
    `;
    assert.equal(executionAudits[0]?.count, 1n, "one organization execution-started audit is committed");
    const workerAudits = await clients[0]!.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM audit_events WHERE tenant_id = ${fixture.tenantId}
        AND resource_type = 'remediation' AND resource_id = ${fixture.remediationId}
        AND action = 'REMEDIATION_WORKER_CLAIMED';
    `;
    assert.equal(workerAudits[0]?.count, 1n, "one worker-claimed audit is committed");
    const prematureSuccessAudits = await clients[0]!.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM audit_events WHERE tenant_id = ${fixture.tenantId}
        AND resource_type = 'remediation' AND resource_id = ${fixture.remediationId}
        AND action IN ('REMEDIATION_PR_OPENED', 'REMEDIATION_PR_RECONCILED_MERGED');
    `;
    assert.equal(prematureSuccessAudits[0]?.count, 0n, "claiming alone cannot create a remote-success audit");
  } finally {
    barrier.release();
    await Promise.allSettled(clients.map((client) => client.$disconnect()));
  }
  // The committed fixture and immutable artifact are intentionally retained.
  // The user disposes of this entire dedicated database/container/volume after reviewing the result.
  assert.ok(tenantId, "fixture setup completed");
  t.diagnostic("This test commits fixture rows; dispose only the dedicated concurrency-test database after review.");
});
