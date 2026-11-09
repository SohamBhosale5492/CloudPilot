import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { planRemediation, type FindingSummary } from "../../../phase-07/src/remediation/planner.js";
import type { RemediationLease } from "../../src/jobs/remediation-repo.js";
import { renderExecutionArtifact, type ArtifactScope } from "../../src/remediation/execution-artifact.js";
import {
  isTrustedClaimExecutionContext,
  TrustedClaimExecutionContextService
} from "../../src/remediation/trusted-claim-execution-context.js";

const DATABASE_URL = process.env.CLOUDPILOT_CLAIM_TEST_DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("CLOUDPILOT_CLAIM_TEST_DATABASE_URL is required for trusted execution context integration tests.");
}

function parseApprovedUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CLOUDPILOT_CLAIM_TEST_DATABASE_URL is malformed.");
  }
  let username: string;
  let database: string;
  try {
    username = decodeURIComponent(url.username);
    database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("CLOUDPILOT_CLAIM_TEST_DATABASE_URL is malformed.");
  }
  const overrides = ["host", "hostaddr", "port", "dbname", "database", "user", "username"];
  if (!(url.protocol === "postgres:" || url.protocol === "postgresql:") ||
      !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname) ||
      url.port !== "56433" || database !== "cloudpilot_claim_test" ||
      username !== "cloudpilot_claim_test" || url.hash ||
      [...url.searchParams.keys()].some((key) => overrides.includes(key.toLowerCase()))) {
    throw new Error("CLOUDPILOT_CLAIM_TEST_DATABASE_URL must target the approved disposable claim-test database.");
  }
  return url;
}

// Fail closed before Prisma construction; never read DATABASE_URL or dotenv files.
const approvedUrl = parseApprovedUrl(DATABASE_URL).toString();
const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const FIXTURE_HASH = "a".repeat(64);

interface Fixture {
  lease: RemediationLease;
  service: TrustedClaimExecutionContextService;
  tenantId: string;
  organizationId: string;
  projectId: string;
  requesterId: string;
  approverId: string;
  adoptionId: string;
  installationId: string;
  bindingId: string;
  proposalId: string;
}

class RollbackFixtures extends Error {}

/** Run the production repository against the enclosing real PostgreSQL transaction. */
function transactionBoundClient(tx: Prisma.TransactionClient, observeQuery?: (sql: string) => void): PrismaClient {
  const transactionClient = observeQuery ? new Proxy(tx, {
    get(target, property) {
      if (property === "$queryRaw") {
        return (strings: TemplateStringsArray, ...values: unknown[]) => {
          observeQuery(strings.join("?"));
          return (Reflect.get(target, property, target) as (...args: unknown[]) => Promise<unknown>).bind(target)(strings, ...values);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) : tx;
  return new Proxy(tx as unknown as PrismaClient, {
    get(target, property) {
      if (property === "$transaction") {
        return async (callback: (client: Prisma.TransactionClient) => Promise<unknown>) => callback(transactionClient);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function planHash(snapshot: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex");
}

async function createFixture(
  tx: Prisma.TransactionClient,
  label: string,
  options: { artifactScopeOverrides?: Partial<ArtifactScope>; storedHash?: string; leaseToken?: string | null; leaseExpiry?: Date } = {}
): Promise<Fixture> {
  const tenantId = randomUUID();
  const requesterId = randomUUID();
  const approverId = randomUUID();
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const scanId = randomUUID();
  const findingId = randomUUID();
  const installationId = randomUUID();
  const bindingId = randomUUID();
  const adoptionId = randomUUID();
  const proposalId = randomUUID();
  const leaseToken = options.leaseToken === undefined ? randomUUID() : options.leaseToken;
  const githubInstallationId = BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`) + 100_000_000_000n;
  const githubRepositoryId = githubInstallationId + 1n;
  const ownerLogin = "context-test";
  const repositoryName = `repo-${label}`;
  const finding: FindingSummary = {
    requirementId: `context-${label}`,
    ruleId: "observability.metric.present",
    ruleVersion: "1.0.0",
    signal: "metric",
    outcome: "gap",
    expected: "A request metric is configured",
    observed: "No request metric is configured",
    reason: "Disposable trusted-context integration fixture"
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
    repository: {
      bindingId, repositoryId: githubRepositoryId.toString(), installationRecordId: installationId,
      owner: ownerLogin, name: repositoryName
    },
    patch: {
      filePath: patch.filePath, title: patch.prTitle, body: patch.prBody,
      commitMessage: patch.commitMessage, summary: patch.summary
    }
  };
  const computedPlanHash = planHash(planSnapshot);
  const scope: ArtifactScope = {
    proposalId, tenantId, organizationId, projectId, repositoryBindingId: bindingId,
    githubRepositoryId: githubRepositoryId.toString(), installationRecordId: installationId,
    planHash: computedPlanHash
  };
  const sealed = renderExecutionArtifact({
    scope: { ...scope, ...options.artifactScopeOverrides },
    finding,
    snapshot: {
      immutableRepositoryId: (options.artifactScopeOverrides?.githubRepositoryId ?? scope.githubRepositoryId),
      baseRef: "main",
      baseCommitSha: BASE_SHA,
      filePath: patch.filePath,
      file: { content: null, contentBase64: null, blobSha: null, mode: null, fileType: null, isRegularFile: true }
    },
    createdAt: new Date("2026-11-06T00:00:00.000Z")
  });
  const storedHash = options.storedHash ?? sealed.artifactHash;

  await tx.$executeRaw`INSERT INTO tenants (id, name) VALUES (${tenantId}, ${`context-${label}`})`;
  for (const [id, name] of [[requesterId, "requester"], [approverId, "approver"]] as const) {
    await tx.$executeRaw`
      INSERT INTO identity_users (id, status, display_name, created_at, updated_at)
      VALUES (${id}::uuid, 'active', ${`context ${name}`}, NOW(), NOW())
    `;
  }
  await tx.$executeRaw`
    INSERT INTO organizations (
      id, display_name, status, created_by_user_id, creation_idempotency_key,
      creation_request_hash, created_at, updated_at
    ) VALUES (
      ${organizationId}::uuid, ${`Context ${label}`}, 'active', ${requesterId}::uuid,
      ${`context-${label}`}, ${FIXTURE_HASH}, NOW(), NOW()
    )
  `;
  await tx.$executeRaw`
    INSERT INTO organization_members (
      organization_id, user_id, role, status, created_by_user_id, created_at, updated_at
    ) VALUES (${organizationId}::uuid, ${approverId}::uuid, 'admin', 'active', ${requesterId}::uuid, NOW(), NOW())
  `;
  await tx.$executeRaw`
    INSERT INTO projects (id, tenant_id, organization_id, name, repository_url, created_at, updated_at)
    VALUES (${projectId}, ${tenantId}, ${organizationId}::uuid, ${`Context ${label}`}, NULL, NOW(), NOW())
  `;
  await tx.$executeRaw`
    INSERT INTO scans (id, tenant_id, organization_id, project_id, status, created_at)
    VALUES (${scanId}, ${tenantId}, ${organizationId}::uuid, ${projectId}, 'completed', NOW())
  `;
  await tx.$executeRaw`
    INSERT INTO findings (
      id, tenant_id, organization_id, project_id, scan_id, requirement_id, rule_id,
      rule_version, signal, outcome, expected, observed, reason, evidence_json, created_at
    ) VALUES (
      ${findingId}, ${tenantId}, ${organizationId}::uuid, ${projectId}, ${scanId},
      ${finding.requirementId}, ${finding.ruleId}, ${finding.ruleVersion}, ${finding.signal},
      ${finding.outcome}, ${finding.expected}, ${finding.observed}, ${finding.reason}, '{}'::jsonb, NOW()
    )
  `;
  await tx.$executeRaw`
    INSERT INTO organization_github_installations (
      id, organization_id, github_installation_id, github_account_id, github_account_login,
      github_account_type, status, verified_permissions, connected_by_identity_user_id,
      created_at, updated_at, verified_at
    ) VALUES (
      ${installationId}::uuid, ${organizationId}::uuid, ${githubInstallationId}, ${githubInstallationId + 1n},
      'context-test', 'Organization', 'active', '{"metadata":"read"}'::jsonb,
      ${requesterId}::uuid, NOW(), NOW(), NOW()
    )
  `;
  await tx.$executeRaw`
    INSERT INTO project_github_repositories (
      id, tenant_id, organization_id, project_id, installation_record_id, github_repository_id,
      owner_login, repository_name, status, connected_by_identity_user_id, created_at, updated_at
    ) VALUES (
      ${bindingId}::uuid, ${tenantId}, ${organizationId}::uuid, ${projectId}, ${installationId}::uuid,
      ${githubRepositoryId}, ${ownerLogin}, ${repositoryName}, 'active', ${requesterId}::uuid, NOW(), NOW()
    )
  `;
  await tx.$executeRaw`
    INSERT INTO project_organization_adoptions (
      id, tenant_id, project_id, organization_id, requested_by_identity_user_id,
      approved_by_identity_user_id, status, approved_at, idempotency_key, request_hash,
      provenance, created_at, updated_at
    ) VALUES (
      ${adoptionId}::uuid, ${tenantId}, ${projectId}, ${organizationId}::uuid, ${requesterId}::uuid,
      ${approverId}::uuid, 'approved', NOW(), ${`context-adoption-${label}`}, ${FIXTURE_HASH}, '{}'::jsonb, NOW(), NOW()
    )
  `;
  await tx.$executeRaw`
    INSERT INTO remediations (
      id, tenant_id, organization_id, project_id, scan_id, finding_id,
      requested_by_identity_user_id, repository_binding_id, github_repository_id,
      plan_hash, plan_snapshot, execution_artifact, execution_artifact_hash, approved_artifact_hash,
      approval_state, approved_by_identity_user_id, approved_at, idempotency_key,
      status, worker_id, lease_token, claimed_at, heartbeat_at, lease_expires_at,
      retries_left, created_at, updated_at
    ) VALUES (
      ${proposalId}, ${tenantId}, ${organizationId}::uuid, ${projectId}, ${scanId}, ${findingId},
      ${requesterId}::uuid, ${bindingId}::uuid, ${githubRepositoryId},
      ${computedPlanHash}, ${JSON.stringify(planSnapshot)}::jsonb, ${JSON.stringify(sealed.artifact)}::jsonb,
      ${storedHash}, ${storedHash}, 'approved', ${approverId}::uuid, NOW(), ${`context-${proposalId}`},
      'running', 'context-worker', ${leaseToken}::uuid, NOW(), NOW(),
      ${options.leaseExpiry ?? new Date(Date.now() + 5 * 60_000)}, 3, NOW(), NOW()
    )
  `;
  const lease: RemediationLease = {
    id: proposalId, tenantId, projectId, workerId: "context-worker",
    leaseToken: leaseToken ?? randomUUID(), retriesLeft: 3
  };
  return {
    lease, tenantId, organizationId, projectId, requesterId, approverId, adoptionId,
    installationId, bindingId, proposalId,
    service: new TrustedClaimExecutionContextService(transactionBoundClient(tx))
  };
}

function isPrivateServerAddress(value: string | null): boolean {
  if (!value) return false;
  const address = value.split("/")[0]?.replace(/^::ffff:/i, "");
  if (!address || address.includes(":")) return address === "::1";
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 127 || octets[0] === 10 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

test("PostgreSQL trusted claim execution context validates persisted approval, scope, and lease", async (t) => {
  const prisma = new PrismaClient({ datasources: { db: { url: approvedUrl } } });
  try {
    await prisma.$connect();
    const identity = await prisma.$queryRaw<Array<{
      database: string; username: string; serverAddress: string | null; serverPort: number;
    }>>`
      SELECT current_database() AS database, current_user AS username,
        inet_server_addr()::text AS "serverAddress", inet_server_port() AS "serverPort"
    `;
    assert.equal(identity[0]?.database, "cloudpilot_claim_test", "refuse any database other than the disposable claim database");
    assert.equal(identity[0]?.username, "cloudpilot_claim_test", "refuse an unexpected database user");
    assert.equal(Number(identity[0]?.serverPort), 5432, "verify PostgreSQL's container-side port");
    assert.ok(isPrivateServerAddress(identity[0]?.serverAddress ?? null), "refuse an unexpected PostgreSQL server address");

    const trigger = await prisma.$queryRaw<Array<{ name: string; enabled: string }>>`
      SELECT tgname AS name, tgenabled AS enabled
      FROM pg_trigger
      WHERE tgrelid = 'remediations'::regclass
        AND tgname = 'trg_remediations_execution_artifact_immutable'
        AND NOT tgisinternal
    `;
    assert.equal(trigger.length, 1, "artifact immutability trigger must exist before fixture writes");
    assert.ok(["O", "A"].includes(trigger[0]!.enabled), "artifact immutability trigger must be enabled");

    let transactionRolledBack = false;
    try {
      await prisma.$transaction(async (tx) => {
        const isolation = await tx.$queryRaw<Array<{ isolation: string }>>`
          SELECT current_setting('transaction_isolation') AS isolation
        `;
        assert.equal(isolation[0]?.isolation, "serializable");

        const make = (label: string, options?: Parameters<typeof createFixture>[2]) => createFixture(tx, label, options);
        const valid = await make("valid");
        const context = await valid.service.prepare(valid.lease);
        assert.ok(context, "valid persisted approved artifact and lease should produce a context");
        assert.equal(isTrustedClaimExecutionContext(context), true);
        assert.match(context.artifactHash, /^[0-9a-f]{64}$/);
        assert.equal(context.githubRepositoryId.length > 0, true);
        const persisted = await tx.$queryRaw<Array<{ executionArtifactHash: string; approvedArtifactHash: string }>>`
          SELECT execution_artifact_hash AS "executionArtifactHash",
            approved_artifact_hash AS "approvedArtifactHash"
          FROM remediations WHERE id = ${valid.proposalId}
        `;
        assert.equal(context.artifactHash, persisted[0]?.executionArtifactHash);
        assert.equal(persisted[0]?.executionArtifactHash, persisted[0]?.approvedArtifactHash);

        const denied = async (label: string, mutate: (fixture: Fixture) => Promise<void>, options?: Parameters<typeof createFixture>[2]) => {
          const fixture = await make(label, options);
          await mutate(fixture);
          assert.equal(await fixture.service.prepare(fixture.lease), null, `${label} must fail closed`);
        };
        await denied("bad-hash", async () => {}, { storedHash: "b".repeat(64) });
        await denied("wrong-artifact-scope", async () => {}, { artifactScopeOverrides: { tenantId: randomUUID() } });
        await denied("wrong-project-scope", async () => {}, { artifactScopeOverrides: { projectId: randomUUID() } });
        await denied("wrong-binding-scope", async () => {}, { artifactScopeOverrides: { repositoryBindingId: randomUUID() } });
        await denied("wrong-repository-scope", async () => {}, { artifactScopeOverrides: { githubRepositoryId: "9876543210123" } });
        await denied("wrong-installation-scope", async () => {}, { artifactScopeOverrides: { installationRecordId: randomUUID() } });
        await denied("requester-inactive", async (f) => {
          await tx.$executeRaw`UPDATE identity_users SET status = 'suspended' WHERE id = ${f.requesterId}::uuid`;
        });
        await denied("approver-inactive", async (f) => {
          await tx.$executeRaw`UPDATE identity_users SET status = 'suspended' WHERE id = ${f.approverId}::uuid`;
        });
        await denied("approver-membership-revoked", async (f) => {
          await tx.$executeRaw`
            UPDATE organization_members SET status = 'revoked', revoked_at = NOW()
            WHERE organization_id = ${f.organizationId}::uuid AND user_id = ${f.approverId}::uuid
          `;
        });
        await denied("approver-permission-downgraded", async (f) => {
          await tx.$executeRaw`
            UPDATE organization_members SET role = 'operator'
            WHERE organization_id = ${f.organizationId}::uuid AND user_id = ${f.approverId}::uuid
          `;
        });
        await denied("adoption-rejected", async (f) => {
          await tx.$executeRaw`
            UPDATE project_organization_adoptions
            SET status = 'rejected', approved_by_identity_user_id = NULL, approved_at = NULL, rejected_at = NOW()
            WHERE id = ${f.adoptionId}::uuid
          `;
        });
        await denied("binding-disconnected", async (f) => {
          await tx.$executeRaw`
            UPDATE project_github_repositories SET status = 'disconnected', disconnected_at = NOW()
            WHERE id = ${f.bindingId}::uuid
          `;
        });
        await denied("installation-suspended", async (f) => {
          await tx.$executeRaw`
            UPDATE organization_github_installations SET status = 'suspended'
            WHERE id = ${f.installationId}::uuid
          `;
        });
        await denied("installation-revoked", async (f) => {
          await tx.$executeRaw`
            UPDATE organization_github_installations SET status = 'revoked', disconnected_at = NOW()
            WHERE id = ${f.installationId}::uuid
          `;
        });
        await denied("missing-lease-token", async (f) => {
          await tx.$executeRaw`UPDATE remediations SET lease_token = NULL WHERE id = ${f.proposalId}`;
        }, { leaseToken: null });
        await denied("expired-lease", async (f) => {
          await tx.$executeRaw`UPDATE remediations SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = ${f.proposalId}`;
        }, { leaseExpiry: new Date(Date.now() - 60_000) });
        await denied("replaced-lease-token", async (f) => {
          await tx.$executeRaw`UPDATE remediations SET lease_token = ${randomUUID()}::uuid WHERE id = ${f.proposalId}`;
        });

        // The database's composite ownership FKs prevent reassignment while an
        // adopted project has scoped scans, bindings, and remediation records.
        const secondOrgId = randomUUID();
        await tx.$executeRaw`
          INSERT INTO organizations (
            id, display_name, status, created_by_user_id, creation_idempotency_key,
            creation_request_hash, created_at, updated_at
          ) VALUES (
            ${secondOrgId}::uuid, 'Context reassignment target', 'active', ${valid.requesterId}::uuid,
            ${`context-reassign-${randomUUID()}`}, ${FIXTURE_HASH}, NOW(), NOW()
          )
        `;
        await tx.$executeRawUnsafe("SAVEPOINT context_reassignment_attempt");
        let reassignmentRejected = false;
        try {
          await tx.$executeRaw`UPDATE projects SET organization_id = ${secondOrgId}::uuid WHERE id = ${valid.projectId}`;
        } catch {
          reassignmentRejected = true;
        } finally {
          await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT context_reassignment_attempt");
          await tx.$executeRawUnsafe("RELEASE SAVEPOINT context_reassignment_attempt");
        }
        assert.equal(reassignmentRejected, true, "relational ownership constraints must reject project reassignment");

        // Observe both real DB-time lease checks around the locked context build.
        // The outer Serializable transaction is rollback-contained, while the
        // production context service still executes its actual SQL on PostgreSQL.
        const observedQueries: string[] = [];
        const finalCheckFixture = await make("final-lease-check");
        const finalCheckContext = await new TrustedClaimExecutionContextService(
          transactionBoundClient(tx, (sql) => observedQueries.push(sql))
        ).prepare(finalCheckFixture.lease);
        assert.ok(finalCheckContext, "valid context should survive the transactional final lease check");
        for (const relation of ["organizations", "projects", "scans", "findings", "project_organization_adoptions",
          "project_github_repositories", "organization_github_installations", "identity_users", "organization_members"]) {
          assert.ok(observedQueries.some((sql) => sql.includes(`FROM ${relation}`) && /FOR SHARE/i.test(sql)),
            `the real preparation transaction must lock ${relation} authorization state`);
        }
        assert.equal(observedQueries.filter((sql) => sql.includes("FROM remediations") &&
          sql.includes("lease_expires_at > clock_timestamp()") && /FOR UPDATE/i.test(sql)).length, 2,
        "initial claim and final context issuance must both execute the database-time lease check under row lock");

        throw new RollbackFixtures("rollback all uniquely identified fixtures, including immutable artifact rows");
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000 });
    } catch (error) {
      if (!(error instanceof RollbackFixtures)) throw error;
      transactionRolledBack = true;
    }
    assert.equal(transactionRolledBack, true, "all artifact-bearing fixture rows must be rolled back, never deleted");
  } finally {
    await prisma.$disconnect();
  }
});
