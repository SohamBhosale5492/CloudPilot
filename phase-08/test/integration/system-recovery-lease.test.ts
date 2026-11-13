import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  RemediationExecutionPersistenceService,
  type SystemRecoveryLease,
  RemediationExecutionPersistenceError
} from "../../src/remediation/remediation-execution-persistence.js";
import { renderExecutionArtifact } from "../../src/remediation/execution-artifact.js";
import { planRemediation, type FindingSummary } from "../../../phase-07/src/remediation/planner.js";

// ---------------------------------------------------------------------------
// Safety guard: this test requires an explicit, dedicated, loopback-only URL.
// It never consults DATABASE_URL, .env files, or any fallback source.
// ---------------------------------------------------------------------------
const DATABASE_URL = process.env.CLOUDPILOT_RECOVERY_LEASE_FRESH_TEST_DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "CLOUDPILOT_RECOVERY_LEASE_FRESH_TEST_DATABASE_URL is required; no fallback is permitted. " +
    "It must target the dedicated loopback database on port 56439; do not log the URL value."
  );
}

// ---------------------------------------------------------------------------
// 17 migrations including journal rejection, durable retry, and resource-type compatibility.
// ---------------------------------------------------------------------------
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

// Known-valid seed values
const HASH = "a".repeat(64);
const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

// ---------------------------------------------------------------------------
// URL validator: enforces loopback, port 56439, database name, and username.
// A malformed or non-matching URL throws before any connection is opened.
// ---------------------------------------------------------------------------
function validateDatabaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("CLOUDPILOT_RECOVERY_LEASE_FRESH_TEST_DATABASE_URL is malformed."); }
  const forbiddenOverrides = ["host", "port", "dbname", "database", "user", "username"];
  const username = decodeURIComponent(url.username);
  const dbname = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!(url.protocol === "postgres:" || url.protocol === "postgresql:") ||
      !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname) ||
      url.port !== "56439" || dbname !== "cloudpilot_recovery_lease_fresh_test" ||
      username !== "cloudpilot_recovery_lease_fresh_test" || url.password.length === 0 || url.hash ||
      forbiddenOverrides.some((key) => url.searchParams.has(key))) {
    throw new Error(
      "CLOUDPILOT_RECOVERY_LEASE_FRESH_TEST_DATABASE_URL must target loopback port 56439, " +
      "database/user cloudpilot_recovery_lease_fresh_test."
    );
  }
  return url;
}

// Apply immediately at module load time — before any test body or connection.
validateDatabaseUrl(DATABASE_URL);

// ---------------------------------------------------------------------------
// PostgreSQL container address guard: confirms the connection target is a
// private container IP (10.x, 172.16-31.x, 192.168.x) or loopback.
// ---------------------------------------------------------------------------
function isPrivateContainerAddress(cidr: string | null): boolean {
  if (!cidr) return false;
  const address = cidr.split("/")[0]!;
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  if (octets[0] === 127) return true;
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

// ---------------------------------------------------------------------------
// SQL text extraction from Prisma tagged-template arguments.
// Prisma passes either a TemplateStringsArray or a Prisma.Sql object;
// both are handled without relying on internal Prisma internals.
// ---------------------------------------------------------------------------
function extractSqlText(arg: unknown): string {
  if (Array.isArray(arg)) return (arg as string[]).join(" ");
  if (arg && typeof arg === "object") {
    const o = arg as Record<string, unknown>;
    if (Array.isArray(o["strings"])) return (o["strings"] as string[]).join(" ");
    if (typeof o["text"] === "string") return o["text"];
    if (typeof o["sql"] === "string") return o["sql"];
  }
  return String(arg ?? "");
}

// ---------------------------------------------------------------------------
// Migration integrity verification.
// Resolves the migrations directory using __dirname injected by the CommonJS
// module wrapper. The compiled output path is:
//   dist/phase-08/test/integration/ → go up 4 levels → package root → prisma/migrations
//   Level 1: dist/phase-08/test/
//   Level 2: dist/phase-08/
//   Level 3: dist/
//   Level 4: <package root> (contains prisma/)
// ---------------------------------------------------------------------------
async function verifyMigrations(prisma: PrismaClient): Promise<void> {
  const packageRoot = path.resolve(__dirname, "..", "..", "..", "..");
  const migrationsDir = path.join(packageRoot, "prisma", "migrations");

  const diskNames = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.deepEqual(
    diskNames, [...MIGRATIONS],
    "migration directory must contain exactly the 17 approved migrations in order"
  );

  const rows = await prisma.$queryRaw<Array<{
    migration_name: string; checksum: string;
    finished_at: Date | null; rolled_back_at: Date | null;
  }>>`
    SELECT migration_name, checksum, finished_at, rolled_back_at
    FROM "_prisma_migrations"
    ORDER BY migration_name;
  `;
  assert.deepEqual(
    rows.map((r) => r.migration_name), [...MIGRATIONS],
    "applied migration list must match approved sequence exactly"
  );
  for (const row of rows) {
    assert.ok(row.finished_at && !row.rolled_back_at,
      `migration ${row.migration_name} must be finished and not rolled back`);
    const sql = await readFile(path.join(migrationsDir, row.migration_name, "migration.sql"));
    assert.equal(
      row.checksum, createHash("sha256").update(sql).digest("hex"),
      `checksum mismatch for migration ${row.migration_name}`
    );
  }
}

function isSerializationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const r = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  return r.code === "P2034" || r.code === "40001" || r.meta?.code === "40001" ||
    (typeof r.message === "string" && /serialization failure|could not serialize access/i.test(r.message));
}

// ---------------------------------------------------------------------------
// Transaction proxy.
// Wraps a PrismaClient so that:
//   - onTxStart(pid) fires once inside the transaction with the real backend PID.
//   - onForUpdate(pid) fires (and may await) immediately after SELECT … FOR UPDATE.
// No production code is modified.
// ---------------------------------------------------------------------------
function instrumentTransactionClient(
  client: PrismaClient,
  hooks?: {
    onTxStart?: (pid: number) => void;
    onForUpdate?: (pid: number) => Promise<void>;
  }
): PrismaClient {
  return new Proxy(client, {
    get(target, prop) {
      if (prop !== "$transaction") {
        const val = Reflect.get(target, prop, target);
        return typeof val === "function" ? (val as Function).bind(target) : val;
      }
      const originalTx = Reflect.get(target, prop, target) as Function;
      return (
        callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options?: unknown
      ) =>
        originalTx.call(target, async (tx: Prisma.TransactionClient) => {
          // Capture the actual PID of this interactive transaction's backend.
          const pidRows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid;`;
          const txPid = Number(pidRows[0]?.pid);
          hooks?.onTxStart?.(txPid);

          // Wrap tx to intercept $queryRaw and pause after FOR UPDATE.
          const proxiedTx: Prisma.TransactionClient = new Proxy(tx, {
            get(inner, innerProp) {
              if (innerProp !== "$queryRaw") {
                const val = Reflect.get(inner, innerProp, inner);
                return typeof val === "function" ? (val as Function).bind(inner) : val;
              }
              const originalQuery = Reflect.get(inner, innerProp, inner) as Function;
              return async (...args: unknown[]) => {
                const result = await originalQuery.apply(inner, args);
                if (extractSqlText(args[0]).includes("FOR UPDATE")) {
                  await hooks?.onForUpdate?.(txPid);
                }
                return result;
              };
            }
          });

          return callback(proxiedTx);
        }, options);
    }
  }) as PrismaClient;
}

// ---------------------------------------------------------------------------
// Fixture helpers — identical conventions to remediation-claim.test.ts.
// ---------------------------------------------------------------------------
interface FixtureScope {
  tenantId: string;
  identityUserId: string;
  organizationId: string;
  projectId: string;
  scanId: string;
  findingId: string;
  installationId: string;
  bindingId: string;
  repositoryId: bigint;
  remediationId: string;
  executionId: string;
}

async function createRecoveryLeaseFixture(prisma: PrismaClient): Promise<FixtureScope> {
  const tenantId = randomUUID();
  const identityUserId = randomUUID();
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const scanId = randomUUID();
  const findingId = randomUUID();
  const installationId = randomUUID();
  const bindingId = randomUUID();
  const adoptionId = randomUUID();
  const remediationId = randomUUID();
  const executionId = randomUUID();

  // Derive numeric IDs the same way as the existing concurrency test.
  const serial = BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`) + 300_000_000_000n;
  const installationGithubId = serial;
  const repositoryId = serial + 1n;

  const finding: FindingSummary = {
    requirementId: `recovery-lease-${remediationId}`,
    ruleId: "observability.metric.present",
    ruleVersion: "1.0.0",
    signal: "metric",
    outcome: "gap",
    expected: "A request metric is configured",
    observed: "No request metric is configured",
    reason: "Disposable recovery-lease integration-test fixture"
  };

  // planRemediation derives the correct filePath for renderExecutionArtifact.
  const patch = planRemediation(finding);
  const planHash = createHash("sha256").update(JSON.stringify({ remediationId, finding })).digest("hex");

  const sealed = renderExecutionArtifact({
    scope: {
      proposalId: remediationId,
      tenantId,
      organizationId,
      projectId,
      repositoryBindingId: bindingId,
      githubRepositoryId: repositoryId.toString(),
      installationRecordId: installationId,
      planHash
    },
    finding,
    snapshot: {
      immutableRepositoryId: repositoryId.toString(),
      baseRef: "main",
      baseCommitSha: BASE_SHA,
      filePath: patch.filePath,
      file: { content: null, contentBase64: null, blobSha: null, mode: null, fileType: null, isRegularFile: true }
    },
    createdAt: new Date("2026-11-07T00:00:00.000Z")
  });

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO tenants (id, name)
      VALUES (${tenantId}, ${`recovery-lease-${tenantId}`});`;

    await tx.$executeRaw`
      INSERT INTO identity_users (id, status, display_name, created_at, updated_at)
      VALUES (${identityUserId}::uuid, 'active', 'Recovery-lease fixture user', NOW(), NOW());
    `;

    await tx.$executeRaw`
      INSERT INTO organizations (
        id, display_name, status, created_by_user_id,
        creation_idempotency_key, creation_request_hash, created_at, updated_at
      ) VALUES (
        ${organizationId}::uuid, 'Recovery-lease fixture org', 'active',
        ${identityUserId}::uuid, ${`recovery-lease-org-${organizationId}`}, ${HASH}, NOW(), NOW()
      );
    `;

    await tx.$executeRaw`
      INSERT INTO organization_members (
        organization_id, user_id, role, status, created_by_user_id, created_at, updated_at
      ) VALUES (
        ${organizationId}::uuid, ${identityUserId}::uuid, 'owner', 'active',
        ${identityUserId}::uuid, NOW(), NOW()
      );
    `;

    await tx.$executeRaw`
      INSERT INTO projects (id, tenant_id, organization_id, name, repository_url, created_at, updated_at)
      VALUES (
        ${projectId}, ${tenantId}, ${organizationId}::uuid,
        'Recovery-lease fixture project', 'https://github.com/example/recovery-lease-test', NOW(), NOW()
      );
    `;

    await tx.$executeRaw`
      INSERT INTO scans (id, tenant_id, organization_id, project_id, status, created_at)
      VALUES (${scanId}, ${tenantId}, ${organizationId}::uuid, ${projectId}, 'completed', NOW());
    `;

    await tx.$executeRaw`
      INSERT INTO findings (
        id, tenant_id, organization_id, project_id, scan_id,
        requirement_id, rule_id, rule_version, signal, outcome,
        expected, observed, reason, evidence_json, created_at
      ) VALUES (
        ${findingId}, ${tenantId}, ${organizationId}::uuid, ${projectId}, ${scanId},
        ${finding.requirementId}, ${finding.ruleId}, ${finding.ruleVersion},
        ${finding.signal}, ${finding.outcome},
        ${finding.expected}, ${finding.observed}, ${finding.reason}, '{}'::jsonb, NOW()
      );
    `;

    await tx.$executeRaw`
      INSERT INTO organization_github_installations (
        id, organization_id, github_installation_id, github_account_id,
        github_account_login, github_account_type, status, verified_permissions,
        connected_by_identity_user_id, created_at, updated_at, verified_at
      ) VALUES (
        ${installationId}::uuid, ${organizationId}::uuid,
        ${installationGithubId}, ${installationGithubId + 1n},
        'recovery-lease-test', 'Organization', 'active',
        '{"metadata":"read"}'::jsonb, ${identityUserId}::uuid, NOW(), NOW(), NOW()
      );
    `;

    await tx.$executeRaw`
      INSERT INTO project_github_repositories (
        id, tenant_id, organization_id, project_id, installation_record_id,
        github_repository_id, owner_login, repository_name, status,
        connected_by_identity_user_id, created_at, updated_at
      ) VALUES (
        ${bindingId}::uuid, ${tenantId}, ${organizationId}::uuid, ${projectId},
        ${installationId}::uuid, ${repositoryId}, 'recovery-lease-test',
        ${`repo-${remediationId.slice(0, 8)}`}, 'active',
        ${identityUserId}::uuid, NOW(), NOW()
      );
    `;

    await tx.$executeRaw`
      INSERT INTO project_organization_adoptions (
        id, tenant_id, project_id, organization_id,
        requested_by_identity_user_id, approved_by_identity_user_id,
        status, approved_at, idempotency_key, request_hash,
        provenance, created_at, updated_at
      ) VALUES (
        ${adoptionId}::uuid, ${tenantId}, ${projectId}, ${organizationId}::uuid,
        ${identityUserId}::uuid, ${identityUserId}::uuid, 'approved', NOW(),
        ${`recovery-lease-adoption-${adoptionId}`}, ${HASH}, '{}'::jsonb, NOW(), NOW()
      );
    `;

    // Remediation row in manual_review_required state so it is eligible for recovery.
    await tx.$executeRaw`
      INSERT INTO remediations (
        id, tenant_id, organization_id, project_id, scan_id, finding_id,
        requested_by_identity_user_id, approved_by_identity_user_id, approved_at,
        repository_binding_id, github_repository_id,
        plan_hash, plan_snapshot, execution_artifact, execution_artifact_hash, approved_artifact_hash,
        approval_state, idempotency_key, status, retries_left,
        next_attempt_at, created_at, updated_at
      ) VALUES (
        ${remediationId}, ${tenantId}, ${organizationId}::uuid, ${projectId}, ${scanId}, ${findingId},
        ${identityUserId}::uuid, ${identityUserId}::uuid, NOW(),
        ${bindingId}::uuid, ${repositoryId},
        ${planHash}, ${JSON.stringify({ schemaVersion: 1, fixture: remediationId })}::jsonb,
        ${JSON.stringify(sealed.artifact)}::jsonb, ${sealed.artifactHash}, ${sealed.artifactHash},
        'approved', ${`recovery-lease-remediation-${remediationId}`},
        'manual_review_required', 0,
        NULL, NOW(), NOW()
      );
    `;

    // Execution row: status=manual_review_required, reconciliation_status=required,
    // no recovery lease columns set → eligible for claimSystemRecoveryLease().
    // Uses 'commit' stage (valid per ck_remediation_executions_stage).
    // Includes all composite FK columns (binding, installation, repository).
    // ck_remediation_executions_verified_state requires manual_review_at IS NOT NULL
    // when status = 'manual_review_required' (migration line 140-141).
    await tx.$executeRaw`
      INSERT INTO remediation_executions (
        id, remediation_id, tenant_id, organization_id, project_id,
        repository_binding_id, installation_record_id, github_repository_id,
        version, status, stage, reconciliation_status,
        artifact_hash, base_ref, base_commit_sha,
        manual_review_at,
        created_at, updated_at,
        recovery_lease_hash, recovery_lease_until, recovery_lease_owner
      ) VALUES (
        ${executionId}::uuid, ${remediationId}, ${tenantId}, ${organizationId}::uuid, ${projectId},
        ${bindingId}::uuid, ${installationId}::uuid, ${repositoryId},
        0, 'manual_review_required', 'commit', 'required',
        ${sealed.artifactHash}, 'main', ${BASE_SHA},
        NOW(),
        NOW(), NOW(),
        NULL, NULL, NULL
      );
    `;
  });

  return {
    tenantId, identityUserId, organizationId, projectId,
    scanId, findingId, installationId, bindingId, repositoryId,
    remediationId, executionId
  };
}

// ---------------------------------------------------------------------------
// Main test suite
// ---------------------------------------------------------------------------
test(
  "SystemRecoveryLease: verified transaction lock contention, mutual exclusion, " +
  "takeover, token fencing, and expired lease rejection",
  { timeout: 120_000 },
  async (t) => {
    const approvedUrl = validateDatabaseUrl(DATABASE_URL).toString();

    // Three independent Prisma clients: A, B, and a monitor client.
    const clients = [0, 1, 2].map(
      () => new PrismaClient({ datasources: { db: { url: approvedUrl } } })
    );

    // ---------------------------------------------------------------------------
    // Bounded pause gate: Client A's transaction holds its row lock open here.
    // Released unconditionally from finally even if assertions or lock inspection fail.
    // ---------------------------------------------------------------------------
    let releaseGateA!: () => void;
    let gateAReleased = false;
    const gateAPromise = new Promise<void>((resolve) => {
      releaseGateA = () => {
        if (!gateAReleased) {
          gateAReleased = true;
          resolve();
        }
      };
    });
    const gateFallbackTimer = setTimeout(() => releaseGateA(), 10_000);
    gateFallbackTimer.unref?.();

    // ---------------------------------------------------------------------------
    // Bounded lock-acquired signal.
    // If Client A never reaches SELECT … FOR UPDATE within 10 seconds, the test
    // fails with an explicit diagnostic rather than hanging indefinitely.
    // ---------------------------------------------------------------------------
    let notifyLockAcquired!: () => void;
    let rejectLockAcquired!: (err: Error) => void;
    let lockAcquiredTimer!: ReturnType<typeof setTimeout>;
    const lockAcquiredPromise = new Promise<void>((resolve, reject) => {
      notifyLockAcquired = () => {
        clearTimeout(lockAcquiredTimer);
        resolve();
      };
      rejectLockAcquired = (err) => {
        clearTimeout(lockAcquiredTimer);
        reject(err);
      };
      lockAcquiredTimer = setTimeout(() => {
        reject(new Error(
          "Timeout: Client A did not acquire the row lock inside its transaction within 10,000 ms."
        ));
      }, 10_000);
      lockAcquiredTimer.unref?.();
    });

    // Real in-transaction backend PIDs (set by the proxy hooks).
    let txPidA: number | null = null;
    let txPidB: number | null = null;

    // Promise references for cleanup tracking.
    let claimPromiseA: Promise<SystemRecoveryLease | null> | null = null;
    let claimPromiseB: Promise<SystemRecoveryLease | null> | null = null;

    try {
      for (const c of clients) await c.$connect();

      // -----------------------------------------------------------------------
      // 1. Verify target database identity and runtime safety.
      // -----------------------------------------------------------------------
      const identityRows = await clients[0]!.$queryRaw<Array<{
        database: string; username: string; serverAddress: string | null;
        serverPort: number; readOnly: string;
      }>>`
        SELECT current_database() AS database, current_user AS username,
               inet_server_addr()::text AS "serverAddress",
               inet_server_port() AS "serverPort",
               current_setting('transaction_read_only') AS "readOnly";
      `;
      assert.equal(identityRows[0]?.database, "cloudpilot_recovery_lease_fresh_test",
        "must be connected to the approved disposable test database");
      assert.equal(identityRows[0]?.username, "cloudpilot_recovery_lease_fresh_test",
        "must authenticate as the approved test user");
      assert.equal(Number(identityRows[0]?.serverPort), 5432,
        "PostgreSQL must be listening on port 5432 inside the container");
      assert.ok(
        isPrivateContainerAddress(identityRows[0]?.serverAddress ?? null),
        "server address must be a loopback or private container IPv4"
      );
      assert.equal(identityRows[0]?.readOnly, "off",
        "the disposable test database must accept writes");

      // -----------------------------------------------------------------------
      // 2. Verify migration integrity.
      // -----------------------------------------------------------------------
      await verifyMigrations(clients[0]!);

      // -----------------------------------------------------------------------
      // 3. Verify empty baseline in all three core tables.
      // -----------------------------------------------------------------------
      const counts = await clients[0]!.$queryRaw<Array<{
        remediations: bigint; executions: bigint; events: bigint;
      }>>`
        SELECT
          (SELECT count(*) FROM remediations)              AS remediations,
          (SELECT count(*) FROM remediation_executions)    AS executions,
          (SELECT count(*) FROM remediation_execution_events) AS events;
      `;
      const freshnessContext = `database=${identityRows[0]?.database} role=${identityRows[0]?.username} counts(remediations=${counts[0]?.remediations}, executions=${counts[0]?.executions}, events=${counts[0]?.events}); expected all zero; no cleanup attempted`;
      assert.equal(counts[0]?.remediations, 0n,
        `fresh disposable database required: ${freshnessContext}`);
      assert.equal(counts[0]?.executions, 0n,
        `fresh disposable database required: ${freshnessContext}`);
      assert.equal(counts[0]?.events, 0n,
        `fresh disposable database required: ${freshnessContext}`);

      // -----------------------------------------------------------------------
      // 4. Create fixture rows.
      // -----------------------------------------------------------------------
      const fixture = await createRecoveryLeaseFixture(clients[0]!);

      // -----------------------------------------------------------------------
      // 5. Instrument Client A: captures its own in-transaction PID and pauses
      //    after SELECT … FOR UPDATE so Client B can be observed blocking on it.
      // -----------------------------------------------------------------------
      const instrumentedA = instrumentTransactionClient(clients[0]!, {
        onTxStart(pid) { txPidA = pid; },
        async onForUpdate() {
          notifyLockAcquired();
          await gateAPromise;
        }
      });

      // Instrument Client B: captures its own in-transaction PID.
      const instrumentedB = instrumentTransactionClient(clients[1]!, {
        onTxStart(pid) { txPidB = pid; }
      });

      const persistenceA = new RemediationExecutionPersistenceService(instrumentedA);
      const persistenceB = new RemediationExecutionPersistenceService(instrumentedB);
      const monitorClient = clients[2]!;

      // -----------------------------------------------------------------------
      // SCENARIO 1: Concurrent claim — exactly one transaction wins.
      // -----------------------------------------------------------------------

      // Start Client A. It will pause inside its transaction after FOR UPDATE.
      // If claimPromiseA rejects before lockAcquiredPromise resolves, forward the
      // error to rejectLockAcquired so the await below fails fast.
      claimPromiseA = persistenceA.claimSystemRecoveryLease({
        executionId: fixture.executionId,
        organizationId: fixture.organizationId,
        tenantId: fixture.tenantId,
        projectId: fixture.projectId,
        recoveryOwnerId: "recovery-worker-a"
      });
      void claimPromiseA.then(
        () => { /* lock succeeded; lockAcquiredPromise already resolved */ },
        (err: unknown) => rejectLockAcquired(err instanceof Error ? err : new Error(String(err)))
      );

      // Wait until Client A actually holds the row lock in the database.
      await lockAcquiredPromise;
      assert.ok(txPidA, "Client A must have captured its in-transaction backend PID");

      // Start Client B. It will block inside the PostgreSQL lock manager.
      claimPromiseB = persistenceB.claimSystemRecoveryLease({
        executionId: fixture.executionId,
        organizationId: fixture.organizationId,
        tenantId: fixture.tenantId,
        projectId: fixture.projectId,
        recoveryOwnerId: "recovery-worker-b"
      });

      // Poll pg_stat_activity until Client B's real transaction PID (captured from
      // inside its own SELECT pg_backend_pid() call) appears as blocked on Client A.
      let clientBBlockedByA = false;
      const pollDeadline = Date.now() + 5_000;
      while (Date.now() < pollDeadline) {
        if (txPidB !== null) {
          const lockRows = await monitorClient.$queryRaw<Array<{
            blocking_pids: number[]; wait_event_type: string | null;
          }>>`
            SELECT pg_blocking_pids(pid) AS blocking_pids, wait_event_type
            FROM pg_stat_activity
            WHERE pid = ${txPidB}::integer;
          `;
          const row = lockRows[0];
          if (row && row.blocking_pids.includes(txPidA)) {
            clientBBlockedByA = true;
            break;
          }
        }
        await new Promise<void>((r) => setTimeout(r, 25));
      }
      assert.equal(
        clientBBlockedByA, true,
        "PostgreSQL must confirm Client B's transaction is actively blocked on Client A's row lock"
      );
      assert.notEqual(txPidA, txPidB,
        "Client A and Client B must operate on distinct PostgreSQL backend processes");

      // Release Client A — it commits and returns a lease.
      releaseGateA();

      const [claimA, claimB] = await Promise.allSettled([claimPromiseA, claimPromiseB]);

      // Identify winner and loser unambiguously.
      let winnerLease: SystemRecoveryLease;
      let loserResult: PromiseSettledResult<SystemRecoveryLease | null>;

      if (claimA.status === "fulfilled" && claimA.value !== null) {
        winnerLease = claimA.value;
        loserResult = claimB;
      } else if (claimB.status === "fulfilled" && claimB.value !== null) {
        winnerLease = claimB.value;
        loserResult = claimA;
      } else {
        assert.fail(
          "Exactly one concurrent claimSystemRecoveryLease must resolve to a valid SystemRecoveryLease. " +
          `claimA=${claimA.status} claimB=${claimB.status}`
        );
      }

      if (loserResult.status === "fulfilled") {
        assert.equal(loserResult.value, null,
          "losing concurrent transaction must return null once the winner's lease is committed");
      } else {
        assert.ok(isSerializationFailure(loserResult.reason),
          `losing concurrent transaction must abort with a serialization failure, got: ${loserResult.reason}`);
      }

      // Verify durable state.
      const afterClaim = await clients[0]!.$queryRaw<Array<{
        hash: string | null; until: Date | null; owner: string | null; leaseValid: boolean;
      }>>`
        SELECT recovery_lease_hash AS hash, recovery_lease_until AS until,
               recovery_lease_owner AS owner,
               recovery_lease_until > clock_timestamp() AS "leaseValid"
        FROM remediation_executions
        WHERE id = ${fixture.executionId}::uuid;
      `;
      const leaseRow = afterClaim[0];
      assert.ok(leaseRow?.hash, "recovery_lease_hash must be set after claim");
      assert.ok(leaseRow?.until, "recovery_lease_until must be set after claim");
      assert.ok(leaseRow?.owner, "recovery_lease_owner must be set after claim");
      assert.equal(leaseRow?.leaseValid, true, "lease must be valid immediately after claim");

      // -----------------------------------------------------------------------
      // SCENARIO 2: Active lease prevents a second claim.
      // -----------------------------------------------------------------------
      // Use bare (uninstrumented) clients from here on.
      const persistenceABare = new RemediationExecutionPersistenceService(clients[0]!);
      const persistenceBBare = new RemediationExecutionPersistenceService(clients[1]!);

      const secondClaim = await persistenceBBare.claimSystemRecoveryLease({
        executionId: fixture.executionId,
        organizationId: fixture.organizationId,
        tenantId: fixture.tenantId,
        projectId: fixture.projectId,
        recoveryOwnerId: "recovery-worker-b"
      });
      assert.equal(secondClaim, null,
        "active unexpired lease must prevent a second concurrent claim");

      // -----------------------------------------------------------------------
      // SCENARIO 3: Expired lease permits takeover.
      // -----------------------------------------------------------------------
      await clients[0]!.$executeRaw`
        UPDATE remediation_executions
           SET recovery_lease_until = clock_timestamp() - INTERVAL '5 seconds'
         WHERE id = ${fixture.executionId}::uuid;
      `;

      const takeoverLease = await persistenceBBare.claimSystemRecoveryLease({
        executionId: fixture.executionId,
        organizationId: fixture.organizationId,
        tenantId: fixture.tenantId,
        projectId: fixture.projectId,
        recoveryOwnerId: "recovery-worker-b"
      });
      assert.ok(takeoverLease,
        "expired lease must permit a new claim (takeover)");
      assert.notEqual(takeoverLease.leaseToken, winnerLease.leaseToken,
        "takeover must generate a distinct lease token");

      // -----------------------------------------------------------------------
      // SCENARIO 4: Previous (stale) token cannot renew or assert ownership
      //             after the takeover.
      // -----------------------------------------------------------------------
      const staleRenewal = await persistenceABare.renewSystemRecoveryLease(winnerLease);
      assert.equal(staleRenewal, false,
        "stale token must not renew after takeover");

      await assert.rejects(
        persistenceABare.assertSystemRecoveryLeaseOwned(winnerLease),
        (err: Error) => {
          assert.ok(err instanceof RemediationExecutionPersistenceError,
            "must throw RemediationExecutionPersistenceError");
          assert.equal(err.code, "lease_guard_unavailable",
            "code must be lease_guard_unavailable");
          return true;
        },
        "stale token must throw lease_guard_unavailable on assertSystemRecoveryLeaseOwned"
      );

      // Release with stale token is a no-op (must not throw and must not clear the live lease).
      await persistenceABare.releaseSystemRecoveryLease(winnerLease);
      const afterStaleRelease = await clients[0]!.$queryRaw<Array<{
        owner: string | null;
      }>>`
        SELECT recovery_lease_owner AS owner
        FROM remediation_executions WHERE id = ${fixture.executionId}::uuid;
      `;
      assert.equal(afterStaleRelease[0]?.owner, "recovery-worker-b",
        "stale token release must not clear the live takeover owner");

      // -----------------------------------------------------------------------
      // SCENARIO 5: Current (takeover) token is valid and can be renewed.
      // -----------------------------------------------------------------------
      await assert.doesNotReject(
        persistenceBBare.assertSystemRecoveryLeaseOwned(takeoverLease),
        "current takeover token must pass assertSystemRecoveryLeaseOwned"
      );
      const validRenewal = await persistenceBBare.renewSystemRecoveryLease(takeoverLease);
      assert.equal(validRenewal, true,
        "current takeover token must successfully renew");

      // -----------------------------------------------------------------------
      // SCENARIO 6: Expired / non-future lease timestamp fails closed.
      //
      // Classification: This scenario proves that any timestamp where
      //   recovery_lease_until <= clock_timestamp()
      // causes the guard to fail closed.  It does NOT assert exact timestamp
      // equality (T_lease == T_now) across discrete client/server round-trips,
      // which is unachievable without database clock virtualization.
      // -----------------------------------------------------------------------
      await clients[0]!.$executeRaw`
        UPDATE remediation_executions
           SET recovery_lease_until = clock_timestamp()
         WHERE id = ${fixture.executionId}::uuid;
      `;

      await assert.rejects(
        persistenceBBare.assertSystemRecoveryLeaseOwned(takeoverLease),
        (err: Error) => {
          assert.ok(err instanceof RemediationExecutionPersistenceError);
          assert.equal(err.code, "lease_guard_unavailable");
          return true;
        },
        "lease timestamp equal to clock_timestamp() must fail the strict > guard"
      );

      const expiredRenewal = await persistenceBBare.renewSystemRecoveryLease(takeoverLease);
      assert.equal(expiredRenewal, false,
        "lease timestamp equal to clock_timestamp() must reject renewal");

      // Worker A reclaims from the expired boundary state.
      const thirdLease = await persistenceABare.claimSystemRecoveryLease({
        executionId: fixture.executionId,
        organizationId: fixture.organizationId,
        tenantId: fixture.tenantId,
        projectId: fixture.projectId,
        recoveryOwnerId: "recovery-worker-a-third"
      });
      assert.ok(thirdLease,
        "a non-future lease timestamp permits a new takeover claim");

      // -----------------------------------------------------------------------
      // SCENARIO 7: Clean release clears all three recovery lease columns.
      // -----------------------------------------------------------------------
      await persistenceABare.releaseSystemRecoveryLease(thirdLease);

      const finalRow = await clients[0]!.$queryRaw<Array<{
        hash: string | null; until: Date | null; owner: string | null;
      }>>`
        SELECT recovery_lease_hash AS hash,
               recovery_lease_until AS until,
               recovery_lease_owner AS owner
        FROM remediation_executions
        WHERE id = ${fixture.executionId}::uuid;
      `;
      assert.equal(finalRow[0]?.hash, null,
        "recovery_lease_hash must be NULL after clean release");
      assert.equal(finalRow[0]?.until, null,
        "recovery_lease_until must be NULL after clean release");
      assert.equal(finalRow[0]?.owner, null,
        "recovery_lease_owner must be NULL after clean release");

    } finally {
      // -----------------------------------------------------------------------
      // Unconditional cleanup — in this exact order:
      //   1. Release gate A (idempotent — safe to call even if already released).
      //   2. Clear all bounded timers.
      //   3. Give pending claim promises a bounded window to settle.
      //   4. Disconnect all three clients.
      // -----------------------------------------------------------------------
      releaseGateA();
      clearTimeout(gateFallbackTimer);
      clearTimeout(lockAcquiredTimer);

      // Rejection-safe settlement tracking: dual-callback .then(ok, err) avoids
      // creating an unobserved rejected promise derivation (Fix: no .finally()).
      const tracked: Array<{ name: string; settled: boolean }> = [];

      function trackPromise(name: string, p: Promise<unknown>): void {
        const item = { name, settled: false };
        const mark = () => { item.settled = true; };
        p.then(mark, mark);
        tracked.push(item);
      }

      if (claimPromiseA) trackPromise("Client A claim", claimPromiseA);
      if (claimPromiseB) trackPromise("Client B claim", claimPromiseB);

      if (tracked.length > 0) {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && tracked.some((it) => !it.settled)) {
          await new Promise<void>((r) => setTimeout(r, 50));
        }
        const unresolved = tracked.filter((it) => !it.settled).map((it) => it.name);
        if (unresolved.length > 0) {
          t.diagnostic(
            `WARNING: The following claim operations were still pending at cleanup deadline: ${unresolved.join(", ")}. ` +
            "This may indicate a blocked PostgreSQL transaction. The disposable database container should be destroyed."
          );
        }
      }

      await Promise.allSettled(clients.map((c) => c.$disconnect()));
    }

    t.diagnostic(
      "Recovery lease integration test completed. " +
      "Dispose of the dedicated test container and volume after reviewing results."
    );
  }
);
