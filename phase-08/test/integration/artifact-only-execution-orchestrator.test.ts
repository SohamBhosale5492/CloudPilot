import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { parsePhase08AcceptanceDatabase } from "./acceptance-database.js";
import type { RemediationLease } from "../../src/jobs/remediation-repo.js";
import { RemediationJobRepository } from "../../src/jobs/remediation-repo.js";
import { PrismaRemediationExecutionLifecycle } from "../../src/jobs/remediation-execution-lifecycle.js";
import { GITHUB_ARTIFACT_WRITER_PERMISSIONS, GITHUB_DRAFT_PR_PERMISSIONS,
  type GitHubInstallationToken } from "../../src/github/app-token-service.js";
import { GitHubExecutionCapabilityService } from "../../src/github/github-execution-capability.js";
import { ArtifactOnlyGitHubWriter, type ArtifactOnlyGitHubWriteResult } from "../../src/remediation/artifact-only-github-writer.js";
import { ArtifactOnlyGitHubDraftPrPublisher, type ArtifactOnlyDraftPullRequestResult } from "../../src/remediation/artifact-only-github-draft-pr-publisher.js";
import { ArtifactOnlyExecutionOrchestrator } from "../../src/remediation/artifact-only-execution-orchestrator.js";
import { renderExecutionArtifact, type ArtifactScope } from "../../src/remediation/execution-artifact.js";
import { TrustedClaimExecutionContextService } from "../../src/remediation/trusted-claim-execution-context.js";
import { RemediationExecutionPersistenceService } from "../../src/remediation/remediation-execution-persistence.js";

const acceptanceDatabase = parsePhase08AcceptanceDatabase(process.env.CLOUDPILOT_PHASE08_ACCEPTANCE_TEST_DATABASE_URL);
const suppliedUrl = acceptanceDatabase?.url ?? process.env.CLOUDPILOT_CLAIM_TEST_DATABASE_URL;
const expectedDatabase = acceptanceDatabase?.database ?? "cloudpilot_claim_test";
const expectedUsername = acceptanceDatabase?.username ?? "cloudpilot_claim_test";
if (!suppliedUrl) throw new Error("CLOUDPILOT_CLAIM_TEST_DATABASE_URL is required for orchestrator integration tests.");

function approvedDatabaseUrl(value: string): string {
  if (acceptanceDatabase) {
    if (value !== acceptanceDatabase.url) throw new Error("Refusing a database URL different from the validated acceptance target.");
    return acceptanceDatabase.url;
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("CLOUDPILOT_CLAIM_TEST_DATABASE_URL is malformed."); }
  let username: string;
  let database: string;
  try {
    username = decodeURIComponent(url.username);
    database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  } catch { throw new Error("CLOUDPILOT_CLAIM_TEST_DATABASE_URL is malformed."); }
  const forbiddenOverrides = ["host", "hostaddr", "port", "dbname", "database", "user", "username"];
  if (!(url.protocol === "postgres:" || url.protocol === "postgresql:") ||
      !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname) || url.port !== "56433" ||
      database !== "cloudpilot_claim_test" || username !== "cloudpilot_claim_test" || url.hash ||
      [...url.searchParams.keys()].some((key) => forbiddenOverrides.includes(key.toLowerCase()))) {
    throw new Error("CLOUDPILOT_CLAIM_TEST_DATABASE_URL must target the approved disposable claim-test database.");
  }
  return url.toString();
}

// Explicit datasource URL only; this file never loads dotenv or DATABASE_URL.
const databaseUrl = approvedDatabaseUrl(suppliedUrl);
const DIGEST = "a".repeat(64);
const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const FILE_PATH = "config/observability/metrics.yaml";
const finding = {
  requirementId: "orchestrator-integration-metric",
  ruleId: "observability.metric.present",
  ruleVersion: "1.0.0",
  signal: "metric",
  outcome: "gap",
  expected: "Request metric exists",
  observed: "Request metric is missing",
  reason: "Isolated orchestrator integration fixture"
};

class RollbackFixtures extends Error {}

interface Fixture {
  readonly tenantId: string;
  readonly requesterId: string;
  readonly approverId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly scanId: string;
  readonly findingId: string;
  readonly installationRecordId: string;
  readonly bindingId: string;
  readonly adoptionId: string;
  readonly proposalId: string;
  readonly repositoryId: string;
  readonly repositoryName: string;
  readonly githubInstallationId: string;
  readonly lease: RemediationLease;
  readonly contexts: TrustedClaimExecutionContextService;
  readonly persistence: RemediationExecutionPersistenceService;
}

function transactionBoundClient(tx: Prisma.TransactionClient): PrismaClient {
  return new Proxy(tx as unknown as PrismaClient, {
    get(target, property) {
      if (property === "$transaction") {
        return async (callback: (transaction: Prisma.TransactionClient) => Promise<unknown>) => callback(tx);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function createFixture(tx: Prisma.TransactionClient, label: string, options: {
  readonly storedArtifactHash?: string;
  readonly artifactScopeOverrides?: Partial<ArtifactScope>;
} = {}): Promise<Fixture> {
  const tenantId = randomUUID();
  const requesterId = randomUUID();
  const approverId = randomUUID();
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const scanId = randomUUID();
  const findingId = randomUUID();
  const installationRecordId = randomUUID();
  const bindingId = randomUUID();
  const adoptionId = randomUUID();
  const proposalId = randomUUID();
  const githubInstallationId = (BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`) + 100_000_000_000n).toString();
  const repositoryId = (BigInt(githubInstallationId) + 1n).toString();
  const repositoryName = `repo-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const leaseToken = randomUUID();
  const snapshot = {
    schemaVersion: 1,
    plannerVersion: "phase07-planner-v1",
    projectId,
    finding: { id: findingId, scanId, ...finding },
    repository: { bindingId, repositoryId, installationRecordId, owner: "orchestrator-fixture", name: repositoryName },
    patch: { filePath: FILE_PATH, title: "Approved fixture", body: "Fixture only", commitMessage: "Fixture only", summary: "Fixture" }
  };
  const planHash = createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex");
  const artifactScope: ArtifactScope = {
    proposalId, tenantId, organizationId, projectId, repositoryBindingId: bindingId,
    githubRepositoryId: repositoryId, installationRecordId, planHash
  };
  const sealed = renderExecutionArtifact({
    scope: { ...artifactScope, ...options.artifactScopeOverrides },
    finding,
    snapshot: {
      immutableRepositoryId: options.artifactScopeOverrides?.githubRepositoryId ?? repositoryId,
      baseRef: "main", baseCommitSha: BASE_SHA, filePath: FILE_PATH,
      file: { content: null, contentBase64: null, blobSha: null, mode: null, fileType: null, isRegularFile: true }
    },
    createdAt: new Date("2026-11-06T00:00:00.000Z")
  });
  const storedArtifactHash = options.storedArtifactHash ?? sealed.artifactHash;

  await tx.$executeRaw`INSERT INTO tenants (id, name) VALUES (${tenantId}, ${`orch-${label}`})`;
  for (const [id, name] of [[requesterId, "requester"], [approverId, "approver"]] as const) {
    await tx.$executeRaw`INSERT INTO identity_users (id, status, display_name, created_at, updated_at)
      VALUES (${id}::uuid, 'active', ${`orch ${name}`}, NOW(), NOW())`;
  }
  await tx.$executeRaw`INSERT INTO organizations (
    id, display_name, status, created_by_user_id, creation_idempotency_key, creation_request_hash, created_at, updated_at
  ) VALUES (${organizationId}::uuid, ${`Orchestrator ${label}`}, 'active', ${requesterId}::uuid,
    ${`orch-org-${randomUUID()}`}, ${DIGEST}, NOW(), NOW())`;
  await tx.$executeRaw`INSERT INTO organization_members (
    organization_id, user_id, role, status, created_by_user_id, created_at, updated_at
  ) VALUES (${organizationId}::uuid, ${approverId}::uuid, 'admin', 'active', ${requesterId}::uuid, NOW(), NOW())`;
  await tx.$executeRaw`INSERT INTO projects (id, tenant_id, organization_id, name, repository_url, created_at, updated_at)
    VALUES (${projectId}, ${tenantId}, ${organizationId}::uuid, ${`Orchestrator ${label}`},
      'https://mutable.invalid/should-not-be-used', NOW(), NOW())`;
  await tx.$executeRaw`INSERT INTO scans (id, tenant_id, organization_id, project_id, status, created_at)
    VALUES (${scanId}, ${tenantId}, ${organizationId}::uuid, ${projectId}, 'completed', NOW())`;
  await tx.$executeRaw`INSERT INTO findings (
    id, tenant_id, organization_id, project_id, scan_id, requirement_id, rule_id, rule_version,
    signal, outcome, expected, observed, reason, evidence_json, created_at
  ) VALUES (${findingId}, ${tenantId}, ${organizationId}::uuid, ${projectId}, ${scanId}, ${finding.requirementId},
    ${finding.ruleId}, ${finding.ruleVersion}, ${finding.signal}, ${finding.outcome}, ${finding.expected},
    ${finding.observed}, ${finding.reason}, '{}'::jsonb, NOW())`;
  await tx.$executeRaw`INSERT INTO organization_github_installations (
    id, organization_id, github_installation_id, github_account_id, github_account_login, github_account_type,
    status, verified_permissions, connected_by_identity_user_id, created_at, updated_at, verified_at
  ) VALUES (${installationRecordId}::uuid, ${organizationId}::uuid, ${BigInt(githubInstallationId)},
    ${BigInt(githubInstallationId) + 1n}, 'orchestrator-fixture', 'Organization', 'active',
    '{"metadata":"read"}'::jsonb, ${requesterId}::uuid, NOW(), NOW(), NOW())`;
  await tx.$executeRaw`INSERT INTO project_github_repositories (
    id, tenant_id, organization_id, project_id, installation_record_id, github_repository_id,
    owner_login, repository_name, status, connected_by_identity_user_id, created_at, updated_at
  ) VALUES (${bindingId}::uuid, ${tenantId}, ${organizationId}::uuid, ${projectId}, ${installationRecordId}::uuid,
    ${BigInt(repositoryId)}, 'orchestrator-fixture', ${repositoryName}, 'active', ${requesterId}::uuid, NOW(), NOW())`;
  await tx.$executeRaw`INSERT INTO project_organization_adoptions (
    id, tenant_id, project_id, organization_id, requested_by_identity_user_id, approved_by_identity_user_id,
    status, approved_at, idempotency_key, request_hash, provenance, created_at, updated_at
  ) VALUES (${adoptionId}::uuid, ${tenantId}, ${projectId}, ${organizationId}::uuid, ${requesterId}::uuid,
    ${approverId}::uuid, 'approved', NOW(), ${`orch-adoption-${randomUUID()}`}, ${DIGEST}, '{}'::jsonb, NOW(), NOW())`;
  await tx.$executeRaw`INSERT INTO remediations (
    id, tenant_id, organization_id, project_id, scan_id, finding_id, requested_by_identity_user_id,
    repository_binding_id, github_repository_id, plan_hash, plan_snapshot, execution_artifact,
    execution_artifact_hash, approved_artifact_hash, approval_state, approved_by_identity_user_id, approved_at,
    idempotency_key, status, worker_id, lease_token, claimed_at, heartbeat_at, lease_expires_at,
    retries_left, created_at, updated_at
  ) VALUES (${proposalId}, ${tenantId}, ${organizationId}::uuid, ${projectId}, ${scanId}, ${findingId},
    ${requesterId}::uuid, ${bindingId}::uuid, ${BigInt(repositoryId)}, ${planHash}, ${JSON.stringify(snapshot)}::jsonb,
    ${JSON.stringify(sealed.artifact)}::jsonb, ${storedArtifactHash}, ${storedArtifactHash}, 'approved',
    ${approverId}::uuid, NOW(), ${`orch-proposal-${proposalId}`}, 'running', 'orch-worker', ${leaseToken}::uuid,
    NOW(), NOW(), NOW() + INTERVAL '5 minutes', 3, NOW(), NOW())`;

  return {
    tenantId, requesterId, approverId, organizationId, projectId, scanId, findingId,
    installationRecordId, bindingId, adoptionId, proposalId, repositoryId, repositoryName, githubInstallationId,
    lease: { id: proposalId, tenantId, projectId, workerId: "orch-worker", leaseToken, retriesLeft: 3 },
    contexts: new TrustedClaimExecutionContextService(transactionBoundClient(tx)),
    persistence: new RemediationExecutionPersistenceService(transactionBoundClient(tx))
  };
}

function privateAddress(value: string | null): boolean {
  if (!value) return false;
  const ip = value.split("/")[0]?.replace(/^::ffff:/iu, "");
  if (!ip) return false;
  if (ip.includes(":")) return ip === "::1";
  const octets = ip.split(".").map(Number);
  return octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    (octets[0] === 127 || octets[0] === 10 || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168));
}

function json(value: unknown, status = 200, raw?: string): Response {
  return new Response(raw ?? JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function harness(fixture: Fixture, options: {
  readonly fetchImpl?: typeof fetch;
  readonly writer?: { write(input: Parameters<ArtifactOnlyGitHubWriter["write"]>[0]): Promise<ArtifactOnlyGitHubWriteResult> };
  readonly publisher?: { publish(input: Parameters<ArtifactOnlyGitHubDraftPrPublisher["publish"]>[0]): Promise<ArtifactOnlyDraftPullRequestResult> };
} = {}) {
  const tokenProfiles: string[] = [];
  const tokenProvider = {
    async getArtifactWriterInstallationToken(input: { installationId: string; repositoryId: string }): Promise<GitHubInstallationToken> {
      tokenProfiles.push("contents-only");
      assert.equal(input.installationId, fixture.githubInstallationId);
      assert.equal(input.repositoryId, fixture.repositoryId);
      return { token: "test-token-contents", expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
        installationId: fixture.githubInstallationId, repositoryId: fixture.repositoryId,
        permissions: GITHUB_ARTIFACT_WRITER_PERMISSIONS };
    },
    async getDraftPullRequestInstallationToken(input: { installationId: string; repositoryId: string }): Promise<GitHubInstallationToken> {
      tokenProfiles.push("pull-request-only");
      assert.equal(input.installationId, fixture.githubInstallationId);
      assert.equal(input.repositoryId, fixture.repositoryId);
      return { token: "test-token-pull-request", expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
        installationId: fixture.githubInstallationId, repositoryId: fixture.repositoryId,
        permissions: GITHUB_DRAFT_PR_PERMISSIONS };
    },
    invalidate() {}
  };
  const requests: string[] = [];
  const fetchImpl = options.fetchImpl ?? (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(`${url.host}${url.pathname}`);
    if (url.pathname === `/repositories/${fixture.repositoryId}`) {
      const raw = `{"id":${fixture.repositoryId},"name":"${fixture.repositoryName}","owner":{"login":"orchestrator-fixture"},"default_branch":"main","archived":false,"disabled":false}`;
      return json(JSON.parse(raw), 200, raw);
    }
    // Stop at a controlled read failure after identity resolution. No write endpoint succeeds.
    return json({ message: "controlled missing base ref" }, 404);
  }) as typeof fetch;
  const capabilities = new GitHubExecutionCapabilityService(fixture.contexts, tokenProvider, { clientOptions: { fetchImpl } });
  const orchestrator = new ArtifactOnlyExecutionOrchestrator(fixture.contexts, capabilities,
    options.writer ?? new ArtifactOnlyGitHubWriter(capabilities),
    options.publisher ?? new ArtifactOnlyGitHubDraftPrPublisher(capabilities), fixture.persistence);
  return { orchestrator, requests, tokenProfiles };
}

test("PostgreSQL orchestrator authorization and lease integration stays rollback-contained", async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const fixtureTenantIds: string[] = [];
  try {
    await prisma.$connect();
    const identity = await prisma.$queryRaw<Array<{ database: string; username: string; address: string | null; serverPort: number }>>`
      SELECT current_database() AS database, current_user AS username,
        inet_server_addr()::text AS address, inet_server_port() AS "serverPort"
    `;
    assert.equal(identity[0]?.database, expectedDatabase);
    assert.equal(identity[0]?.username, expectedUsername);
    assert.equal(Number(identity[0]?.serverPort), 5432, "PostgreSQL internal port for the dedicated host mapping");
    assert.ok(privateAddress(identity[0]?.address ?? null), "server address must be loopback/private as expected for the dedicated container");
    const trigger = await prisma.$queryRaw<Array<{ enabled: string }>>`
      SELECT tgenabled AS enabled FROM pg_trigger
      WHERE tgrelid = 'remediations'::regclass AND tgname = 'trg_remediations_execution_artifact_immutable' AND NOT tgisinternal
    `;
    assert.equal(trigger.length, 1);
    assert.ok(["O", "A"].includes(trigger[0]!.enabled), "artifact immutability trigger must remain enabled");

    let rolledBack = false;
    try {
      await prisma.$transaction(async (tx) => {
        const valid = await createFixture(tx, `valid-${randomUUID()}`);
        fixtureTenantIds.push(valid.tenantId);
        const validContext = await valid.contexts.prepare(valid.lease);
        assert.ok(validContext, "fixture must have a persisted trusted context");
        const validHarness = harness(valid);
        const partial = await validHarness.orchestrator.execute(valid.lease);
        assert.deepEqual(partial, { kind: "failed", stage: "write", code: "github_read_failed", remediationId: valid.proposalId },
          "valid persisted approval reaches the capability and writer boundaries; mock then fails the pinned-base read");
        assert.deepEqual(validHarness.tokenProfiles, ["contents-only"], "no combined or PR token is requested before a verified Git commit");
        assert.ok(validHarness.requests.length > 0);
        assert.ok(validHarness.requests.every((request) => request.startsWith("api.github.com/")));
        assert.ok(!validHarness.requests.some((request) => request.includes("mutable.invalid")),
          "mutable Project.repositoryUrl is not used as repository identity");

        const retryFixture = await createFixture(tx, `durable-retry-${randomUUID()}`);
        fixtureTenantIds.push(retryFixture.tenantId);
        const rootTreeSha = "f".repeat(40);
        let mutationRequests = 0;
        const retryFetch = (async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input));
          const method = init?.method ?? "GET";
          if (url.pathname === `/repositories/${retryFixture.repositoryId}`) {
            const raw = `{"id":${retryFixture.repositoryId},"name":"${retryFixture.repositoryName}","owner":{"login":"orchestrator-fixture"},"default_branch":"main","archived":false,"disabled":false}`;
            return json(JSON.parse(raw), 200, raw);
          }
          if (url.pathname.endsWith("/git/ref/heads/main")) {
            return json({ ref: "refs/heads/main", object: { type: "commit", sha: BASE_SHA } });
          }
          if (url.pathname.endsWith(`/git/commits/${BASE_SHA}`)) {
            return json({ sha: BASE_SHA, tree: { sha: rootTreeSha }, parents: [] });
          }
          if (url.pathname.endsWith(`/git/trees/${rootTreeSha}`)) {
            return json({ sha: rootTreeSha, tree: [], truncated: false });
          }
          if (method === "POST" && url.pathname.endsWith("/git/blobs")) {
            mutationRequests++;
            return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
              status: 429, headers: { "content-type": "application/json", "retry-after": "45" }
            });
          }
          return json({ message: "unexpected mocked route" }, 404);
        }) as typeof fetch;
        const retryHarness = harness(retryFixture, { fetchImpl: retryFetch });
        assert.deepEqual(await retryHarness.orchestrator.execute(retryFixture.lease), {
          kind: "retry_scheduled", stage: "write", code: "rate_limited",
          remediationId: retryFixture.proposalId, retryAfterMs: 45_000
        }, "a definitive GitHub 429 schedules bounded durable retry");
        assert.equal(mutationRequests, 1, "the rejected mutation is attempted exactly once");

        const persistedRetry = await tx.$queryRaw<Array<{
          executionId: string; status: string; retryEligibleAt: Date | null; leaseTokenHash: string | null;
        }>>`SELECT id AS "executionId", status, retry_eligible_at AS "retryEligibleAt", lease_token_hash AS "leaseTokenHash"
          FROM remediation_executions WHERE remediation_id = ${retryFixture.proposalId}`;
        assert.equal(persistedRetry.length, 1);
        assert.equal(persistedRetry[0]?.status, "failed");
        assert.ok(persistedRetry[0]?.retryEligibleAt instanceof Date);
        assert.equal(persistedRetry[0]?.leaseTokenHash, null, "retry settlement releases the old execution lease");
        const projectedRetry = await tx.$queryRaw<Array<{
          status: string; retriesLeft: number; nextAttemptAt: Date | null; leaseToken: string | null;
        }>>`SELECT status, retries_left AS "retriesLeft", next_attempt_at AS "nextAttemptAt", lease_token::text AS "leaseToken"
          FROM remediations WHERE id = ${retryFixture.proposalId}`;
        assert.deepEqual(projectedRetry[0] && {
          status: projectedRetry[0].status, retriesLeft: projectedRetry[0].retriesLeft,
          hasDeadline: projectedRetry[0].nextAttemptAt instanceof Date, leaseToken: projectedRetry[0].leaseToken
        }, { status: "pending", retriesLeft: 2, hasDeadline: true, leaseToken: null });
        const retryEvents = await tx.$queryRaw<Array<{ eventType: string; attemptNumber: number; stage: string | null }>>`
          SELECT event_type AS "eventType", attempt_number AS "attemptNumber", stage
          FROM remediation_execution_events WHERE execution_id = ${persistedRetry[0]!.executionId}::uuid
          ORDER BY sequence_number`;
        assert.deepEqual(retryEvents.map((event) => event.eventType), [
          "execution_started", "request_intent", "remote_mutation_rejected", "execution_retry_scheduled"
        ]);
        assert.equal(retryEvents[2]?.attemptNumber, 1);
        assert.equal(retryEvents[2]?.stage, "blob");
        const retryAudits = await tx.$queryRaw<Array<{ action: string }>>`
          SELECT action FROM organization_audit_events
          WHERE target_type = 'remediation_execution' AND target_id = ${persistedRetry[0]!.executionId}
            AND action IN ('REMEDIATION_EXECUTION_REMOTE_MUTATION_REJECTED', 'REMEDIATION_EXECUTION_RETRY_SCHEDULED')
          ORDER BY action`;
        assert.deepEqual(retryAudits.map((event) => event.action), [
          "REMEDIATION_EXECUTION_REMOTE_MUTATION_REJECTED", "REMEDIATION_EXECUTION_RETRY_SCHEDULED"
        ]);

        // Reconstruct the persistence/lifecycle services from durable rows, as a
        // restarted worker would. The persisted deadline gates a premature claim.
        const restartedClient = transactionBoundClient(tx);
        const restartedContexts = new TrustedClaimExecutionContextService(restartedClient);
        const restartedPersistence = new RemediationExecutionPersistenceService(restartedClient);
        const retryRepository = new RemediationJobRepository(restartedClient,
          new PrismaRemediationExecutionLifecycle(restartedContexts, restartedPersistence));
        assert.equal(await retryRepository.claimNextPending("retry-before-deadline"), null,
          "restart-safe retry remains unclaimable before its persisted deadline");
        await tx.$executeRaw`UPDATE remediation_executions SET retry_eligible_at = clock_timestamp() - INTERVAL '1 second'
          WHERE id = ${persistedRetry[0]!.executionId}::uuid`;
        await tx.$executeRaw`UPDATE remediations SET next_attempt_at = clock_timestamp() - INTERVAL '1 second'
          WHERE id = ${retryFixture.proposalId}`;
        const reclaimed = await retryRepository.claimNextPending("retry-after-deadline");
        assert.ok(reclaimed, "a due retry can be claimed from persisted state after service reconstruction");
        assert.equal(reclaimed?.retriesLeft, 2);
        assert.equal(mutationRequests, 1, "claim/recovery does not repeat the GitHub mutation");

        const partialFixture = await createFixture(tx, `partial-write-${randomUUID()}`);
        fixtureTenantIds.push(partialFixture.tenantId);
        const partialContext = await partialFixture.contexts.prepare(partialFixture.lease);
        assert.ok(partialContext, "post-write lease-loss fixture must have a fresh persisted claim context");
        let publisherCalled = false;
        const partialHarness = harness(partialFixture, {
          writer: { async write() { return { kind: "manual_review", code: "lease_lost_after_write" }; } },
          publisher: { async publish() { publisherCalled = true; return { kind: "failed", code: "github_request_failed" }; } }
        });
        assert.deepEqual(await partialHarness.orchestrator.execute(partialFixture.lease), {
          kind: "manual_review", stage: "write", code: "lease_lost_after_write", remediationId: partialFixture.proposalId,
          proposalId: partialFixture.proposalId, artifactHash: partialContext.artifactHash
        });
        assert.equal(publisherCalled, false, "partial writer outcome must stop publication");

        const denied = async (label: string, fixture: Fixture, lease = fixture.lease) => {
          const h = harness(fixture);
          const result = await h.orchestrator.execute(lease);
          assert.equal(result.kind, "failed", `${label} must fail closed`);
          assert.ok(result.kind === "failed" && (result.stage === "context" || result.stage === "capability"), label);
          assert.deepEqual(h.tokenProfiles, [], `${label} must be denied before token creation`);
          assert.deepEqual(h.requests, [], `${label} must be denied before GitHub HTTP`);
        };

        await denied("wrong worker", valid, { ...valid.lease, workerId: "untrusted-worker" });
        const replacedLease = { ...valid.lease, leaseToken: randomUUID() };
        await denied("wrong lease token", valid, replacedLease);

        const mutateAndDeny = async (label: string, update: (fixture: Fixture) => Promise<void>, restore: (fixture: Fixture) => Promise<void>) => {
          const fixture = await createFixture(tx, `${label}-${randomUUID()}`);
          fixtureTenantIds.push(fixture.tenantId);
          await update(fixture);
          await denied(label, fixture);
          await restore(fixture);
        };
        await mutateAndDeny("requester deactivated",
          (f) => tx.$executeRaw`UPDATE identity_users SET status = 'suspended' WHERE id = ${f.requesterId}::uuid`.then(() => {}),
          (f) => tx.$executeRaw`UPDATE identity_users SET status = 'active' WHERE id = ${f.requesterId}::uuid`.then(() => {}));
        await mutateAndDeny("approver deactivated",
          (f) => tx.$executeRaw`UPDATE identity_users SET status = 'suspended' WHERE id = ${f.approverId}::uuid`.then(() => {}),
          (f) => tx.$executeRaw`UPDATE identity_users SET status = 'active' WHERE id = ${f.approverId}::uuid`.then(() => {}));
        await mutateAndDeny("approver membership revoked",
          (f) => tx.$executeRaw`UPDATE organization_members SET status = 'revoked', revoked_at = NOW()
            WHERE organization_id = ${f.organizationId}::uuid AND user_id = ${f.approverId}::uuid`.then(() => {}),
          (f) => tx.$executeRaw`UPDATE organization_members SET status = 'active', revoked_at = NULL
            WHERE organization_id = ${f.organizationId}::uuid AND user_id = ${f.approverId}::uuid`.then(() => {}));
        await mutateAndDeny("approver permission revoked",
          (f) => tx.$executeRaw`UPDATE organization_members SET role = 'operator'
            WHERE organization_id = ${f.organizationId}::uuid AND user_id = ${f.approverId}::uuid`.then(() => {}),
          (f) => tx.$executeRaw`UPDATE organization_members SET role = 'admin'
            WHERE organization_id = ${f.organizationId}::uuid AND user_id = ${f.approverId}::uuid`.then(() => {}));
        await mutateAndDeny("adoption rejected",
          (f) => tx.$executeRaw`UPDATE project_organization_adoptions SET status = 'rejected',
            approved_by_identity_user_id = NULL, approved_at = NULL, rejected_at = NOW() WHERE id = ${f.adoptionId}::uuid`.then(() => {}),
          (f) => tx.$executeRaw`UPDATE project_organization_adoptions SET status = 'approved',
            approved_by_identity_user_id = ${f.approverId}::uuid, approved_at = NOW(), rejected_at = NULL
            WHERE id = ${f.adoptionId}::uuid`.then(() => {}));
        await mutateAndDeny("binding disconnected",
          (f) => tx.$executeRaw`UPDATE project_github_repositories SET status = 'disconnected', disconnected_at = NOW()
            WHERE id = ${f.bindingId}::uuid`.then(() => {}),
          (f) => tx.$executeRaw`UPDATE project_github_repositories SET status = 'active', disconnected_at = NULL
            WHERE id = ${f.bindingId}::uuid`.then(() => {}));
        await mutateAndDeny("installation suspended",
          (f) => tx.$executeRaw`UPDATE organization_github_installations SET status = 'suspended'
            WHERE id = ${f.installationRecordId}::uuid`.then(() => {}),
          (f) => tx.$executeRaw`UPDATE organization_github_installations SET status = 'active'
            WHERE id = ${f.installationRecordId}::uuid`.then(() => {}));
        await mutateAndDeny("organization inactive",
          (f) => tx.$executeRaw`UPDATE organizations SET status = 'suspended' WHERE id = ${f.organizationId}::uuid`.then(() => {}),
          (f) => tx.$executeRaw`UPDATE organizations SET status = 'active' WHERE id = ${f.organizationId}::uuid`.then(() => {}));
        await mutateAndDeny("lease expired",
          (f) => tx.$executeRaw`UPDATE remediations SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = ${f.proposalId}`.then(() => {}),
          (f) => tx.$executeRaw`UPDATE remediations SET lease_expires_at = clock_timestamp() + INTERVAL '5 minutes' WHERE id = ${f.proposalId}`.then(() => {}));
        await mutateAndDeny("lease replaced",
          (f) => tx.$executeRaw`UPDATE remediations SET lease_token = ${randomUUID()}::uuid WHERE id = ${f.proposalId}`.then(() => {}),
          (f) => tx.$executeRaw`UPDATE remediations SET lease_token = ${f.lease.leaseToken}::uuid WHERE id = ${f.proposalId}`.then(() => {}));

        const badHash = await createFixture(tx, `bad-hash-${randomUUID()}`, { storedArtifactHash: "b".repeat(64) });
        fixtureTenantIds.push(badHash.tenantId);
        await denied("artifact/hash mismatch", badHash);
        const badScope = await createFixture(tx, `bad-scope-${randomUUID()}`, { artifactScopeOverrides: { githubRepositoryId: "999999999999999" } });
        fixtureTenantIds.push(badScope.tenantId);
        await denied("artifact/repository scope mismatch", badScope);

        // Replace the lease in real PostgreSQL between the orchestrator's first
        // context read and capability issuance. The second persisted check must
        // stop before token creation or any GitHub mutation.
        const changing = await createFixture(tx, `during-prepare-${randomUUID()}`);
        fixtureTenantIds.push(changing.tenantId);
        let replaced = false;
        const contextBoundary = {
          async prepare(lease: RemediationLease) {
            const prepared = await changing.contexts.prepare(lease);
            if (!replaced && prepared) {
              replaced = true;
              await tx.$executeRaw`UPDATE remediations SET lease_token = ${randomUUID()}::uuid WHERE id = ${changing.proposalId}`;
            }
            return prepared;
          }
        };
        const duringHarness = harness({ ...changing, contexts: contextBoundary as unknown as TrustedClaimExecutionContextService });
        const duringResult = await duringHarness.orchestrator.execute(changing.lease);
        assert.deepEqual(duringResult, { kind: "failed", stage: "claim", code: "claim_not_authorized",
          remediationId: changing.proposalId });
        assert.equal(replaced, true);
        assert.deepEqual(duringHarness.tokenProfiles, []);
        assert.deepEqual(duringHarness.requests, []);

        // Project reassignment is rejected by the composite ownership constraints;
        // isolate the expected SQL failure with a savepoint and leave the valid row intact.
        const reassignmentTarget = randomUUID();
        await tx.$executeRaw`INSERT INTO organizations (
          id, display_name, status, created_by_user_id, creation_idempotency_key, creation_request_hash, created_at, updated_at
        ) VALUES (${reassignmentTarget}::uuid, 'reassignment target', 'active', ${valid.requesterId}::uuid,
          ${`orch-reassign-${randomUUID()}`}, ${DIGEST}, NOW(), NOW())`;
        await tx.$executeRawUnsafe("SAVEPOINT orchestrator_reassignment");
        let reassignmentRejected = false;
        try { await tx.$executeRaw`UPDATE projects SET organization_id = ${reassignmentTarget}::uuid WHERE id = ${valid.projectId}`; }
        catch { reassignmentRejected = true; }
        finally {
          await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT orchestrator_reassignment");
          await tx.$executeRawUnsafe("RELEASE SAVEPOINT orchestrator_reassignment");
        }
        assert.equal(reassignmentRejected, true, "database ownership constraints prevent persisted project reassignment");

        throw new RollbackFixtures("rollback all test-owned fixture rows; never delete immutable artifact rows");
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000 });
    } catch (error) {
      if (!(error instanceof RollbackFixtures)) throw error;
      rolledBack = true;
    }
    assert.equal(rolledBack, true, "fixture transaction must roll back instead of deleting artifact rows");
    for (const tenantId of fixtureTenantIds) {
      const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM tenants WHERE id = ${tenantId}`;
      assert.equal(rows[0]?.count, 0n, "rollback must remove each fixture tenant");
    }
  } finally {
    await prisma.$disconnect();
  }
});
