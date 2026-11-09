import assert from "node:assert/strict";
import { test } from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  type ExpiredRemediationClaim,
  RemediationJobRepository,
  RemediationLease,
  retryDelayMs
} from "../../src/jobs/remediation-repo.js";
import type { RemediationExecutionLifecycle } from "../../src/jobs/remediation-execution-lifecycle.js";
import { renderExecutionArtifact, sealExecutionArtifact } from "../../src/remediation/execution-artifact.js";

interface CapturedSql {
  text: string;
  values: unknown[];
}

function mockPrisma(options: {
  query?: (query: CapturedSql) => unknown[];
  execute?: (query: CapturedSql) => number;
} = {}) {
  const queries: CapturedSql[] = [];
  const auditWrites: unknown[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = { text: strings.join(" <value> "), values };
      queries.push(query);
      return options.query?.(query) ?? [];
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = { text: strings.join(" <value> "), values };
      queries.push(query);
      return options.execute?.(query) ?? 0;
    },
    auditEvent: {
      create: async (input: unknown) => { auditWrites.push(input); return {}; }
    }
  };
  const client = {
    ...tx,
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)
  } as unknown as PrismaClient;
  return { client, queries, auditWrites };
}

function lease(overrides: Partial<RemediationLease> = {}): RemediationLease {
  return {
    id: "rem-1",
    tenantId: "tenant-1",
    projectId: "project-1",
    workerId: "worker-1",
    leaseToken: "d60587a1-58d7-4836-bc3d-f8ebecb10147",
    retriesLeft: 3,
    ...overrides
  };
}

function repository(client: PrismaClient, lifecycle: RemediationExecutionLifecycle = {
    async startClaimed() {},
    async expireClaim(_tx, expired: ExpiredRemediationClaim) { return expired.retriesLeft > 0 ? "requeued" : "failed"; }
  }): RemediationJobRepository {
  return new RemediationJobRepository(client, lifecycle);
}

async function capturedClaimSql(): Promise<string> {
  const { client, queries } = mockPrisma({
    query: (query) => query.text.includes("FROM remediations AS r") ? [candidate()] :
      query.text.includes("WITH candidate AS") ? claimedRow(query) : []
  });
  await repository(client).claimNextPending("worker");
  return queries.find((query) => query.text.includes("WITH candidate AS"))?.text ?? "";
}

const claimScope = {
  proposalId: "rem-1", tenantId: "tenant-1", organizationId: "org-1", projectId: "project-1",
  repositoryBindingId: "binding-1", githubRepositoryId: "987654321", installationRecordId: "installation-1",
  planHash: "a".repeat(64)
};
function makeClaimArtifact(scope = claimScope) {
  return renderExecutionArtifact({
  scope,
  finding: { requirementId: "req", ruleId: "rule", ruleVersion: "1", signal: "metric", outcome: "gap", expected: "1", observed: "0", reason: "missing" },
  snapshot: {
    immutableRepositoryId: scope.githubRepositoryId, baseRef: "main", baseCommitSha: "b".repeat(40),
    filePath: "config/observability/metrics.yaml",
    file: { content: null, contentBase64: null, blobSha: null, mode: null, fileType: null, isRegularFile: true }
  },
  createdAt: new Date("2026-11-05T00:00:00.000Z")
  });
}
const claimArtifact = makeClaimArtifact();
function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: claimScope.proposalId, tenantId: claimScope.tenantId, organizationId: claimScope.organizationId,
    projectId: claimScope.projectId, repositoryBindingId: claimScope.repositoryBindingId,
    githubRepositoryId: claimScope.githubRepositoryId, installationRecordId: claimScope.installationRecordId,
    planHash: claimScope.planHash, executionArtifact: claimArtifact.artifact,
    executionArtifactHash: claimArtifact.artifactHash, approvedArtifactHash: claimArtifact.artifactHash,
    ...overrides
  };
}
function claimedRow(query: CapturedSql) {
  const token = query.values.find((value) => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) as string;
  return [{ id: claimScope.proposalId, tenantId: claimScope.tenantId, projectId: claimScope.projectId,
    workerId: "worker", leaseToken: token, retriesLeft: 3 }];
}

test("claims use fresh UUID lease tokens and PostgreSQL SKIP LOCKED/database time", async () => {
  const { client, queries } = mockPrisma({
    query: (query) => query.text.includes("FROM remediations AS r") ? [candidate()] :
      query.text.includes("WITH candidate AS") ? claimedRow(query) : []
  });
  const repo = repository(client);
  const first = await repo.claimNextPending("worker");
  const second = await repo.claimNextPending("worker");

  assert.ok(first && second);
  assert.match(first.leaseToken, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  assert.notEqual(first.leaseToken, second.leaseToken);
  const claimSql = queries.find((query) => query.text.includes("WITH candidate AS"))!.text;
  assert.match(claimSql, /FOR UPDATE SKIP LOCKED/);
  assert.match(claimSql, /next_attempt_at <= clock_timestamp\(\)/);
  assert.match(claimSql, /lease_expires_at = NOW\(\)/);
  assert.match(claimSql, /status = 'pending'/);
  assert.match(claimSql, /approval_state = 'approved'/);
});

test("atomic claim requires complete approved proposal, matching artifact hashes, and consistent active scope", async () => {
  const claim = await capturedClaimSql();
  // NULL legacy fields, missing artifacts and non-approved/rejected/invalidated
  // rows fail directly in the SQL claim predicate, before lease assignment.
  for (const predicate of [
    /approval_state = 'approved'/,
    /requested_by_identity_user_id IS NOT NULL/,
    /approved_by_identity_user_id IS NOT NULL/,
    /approved_at IS NOT NULL/,
    /organization_id IS NOT NULL/,
    /repository_binding_id IS NOT NULL/,
    /github_repository_id IS NOT NULL/,
    /plan_hash ~ '\^\[0-9a-f\]\{64\}\$'/,
    /plan_snapshot IS NOT NULL/,
    /execution_artifact IS NOT NULL/,
    /execution_artifact_hash ~ '\^\[0-9a-f\]\{64\}\$'/,
    /approved_artifact_hash IS NOT NULL/,
    /approved_artifact_hash = execution_artifact_hash/,
    /p\.organization_id = remediations\.organization_id/,
    /s\.project_id = remediations\.project_id/,
    /f\.scan_id = remediations\.scan_id/,
    /b\.github_repository_id = remediations\.github_repository_id/,
    /b\.status = 'active'/,
    /i\.status = 'active'/,
    /a\.status = 'approved'/
  ]) assert.match(claim, predicate);
  assert.match(claim, /status = 'pending'/);
  assert.match(claim, /FOR UPDATE SKIP LOCKED/);

  const eligible = mockPrisma({ query: (query) => query.text.includes("FROM remediations AS r") ? [candidate()] :
    query.text.includes("WITH candidate AS") ? claimedRow(query) : [] });
  assert.equal((await repository(eligible.client).claimNextPending("worker"))?.id, claimScope.proposalId);
});

test("atomic claim respects the durable execution retry deadline and rejects unresolved or previously successful mutation history", async () => {
  const claim = await capturedClaimSql();
  assert.match(claim, /r\.next_attempt_at IS NULL OR r\.next_attempt_at <= clock_timestamp\(\)/);
  assert.match(claim, /e\.retry_eligible_at IS NOT NULL AND e\.retry_eligible_at > clock_timestamp\(\)/);
  assert.match(claim, /event_type = 'remote_result_verified'/);
  assert.match(claim, /'remote_result_verified', 'remote_mutation_rejected'/);
  assert.match(claim, /requestFingerprint/);
});

test("claim compares remediation IDs as text and retains the complete atomic eligibility boundary", async () => {
  const claim = await capturedClaimSql();
  assert.match(claim, /AND id =\s*<value>/);
  assert.doesNotMatch(claim, /AND id =\s*<value>\s*::uuid/);

  for (const predicate of [
    /status = 'pending'/,
    /next_attempt_at <= clock_timestamp\(\)/,
    /approval_state = 'approved'/,
    /execution_artifact_hash ~/,
    /approved_artifact_hash = execution_artifact_hash/,
    /p\.tenant_id = remediations\.tenant_id/,
    /s\.project_id = remediations\.project_id/,
    /f\.scan_id = remediations\.scan_id/,
    /b\.github_repository_id = remediations\.github_repository_id/,
    /i\.status = 'active'/,
    /a\.status = 'approved'/,
    /FOR UPDATE SKIP LOCKED/,
    /lease_token =\s*<value>\s*::uuid/
  ]) assert.match(claim, predicate);
});

test("rejected remediation IDs are excluded as text, without UUID casts", async () => {
  let candidateReturned = false;
  const { client, queries } = mockPrisma({
    query: (query) => {
      if (query.text.includes("FROM remediations AS r")) {
        if (candidateReturned) return [];
        candidateReturned = true;
        return [candidate({ executionArtifactHash: "f".repeat(64) })];
      }
      return [];
    }
  });

  assert.equal(await repository(client).claimNextPending("worker"), null);
  const excludedQuery = queries.find((query) => query.text.includes("FROM remediations AS r") &&
    query.values.some((value) => value !== null && typeof value === "object" && "sql" in value &&
      String((value as { sql: unknown }).sql).includes("r.id NOT IN")));
  assert.ok(excludedQuery, "a rejected candidate is excluded on the next candidate scan");
  const exclusion = excludedQuery!.values.find((value) => value !== null && typeof value === "object" &&
    "sql" in value && String((value as { sql: unknown }).sql).includes("r.id NOT IN")) as { sql: string; values: unknown[] };
  assert.match(exclusion.sql, /r\.id NOT IN/);
  assert.doesNotMatch(exclusion.sql, /::uuid/i);
  assert.deepEqual(exclusion.values, [claimScope.proposalId]);
});

test("claim verifies the persisted artifact payload and both approved hashes before leasing", async () => {
  const { client, queries, auditWrites } = mockPrisma({
    query: (query) => query.text.includes("FROM remediations AS r") ? [candidate()] :
      query.text.includes("WITH candidate AS") ? claimedRow(query) : []
  });
  const lease = await repository(client).claimNextPending("worker");
  assert.ok(lease, "valid artifact with a matching canonical hash remains claimable");
  const selection = queries.find((query) => query.text.includes("FROM remediations AS r"))!;
  assert.match(selection.text, /FOR UPDATE OF r SKIP LOCKED/);
  assert.equal(auditWrites.length, 1);
});

test("tampered, malformed, unsupported, or mis-scoped artifacts never reach the atomic lease update", async () => {
  const tampered = structuredClone(claimArtifact.artifact);
  tampered.renderedContent += "# tampered\\n";
  const unsupported = structuredClone(claimArtifact.artifact);
  (unsupported as { schemaVersion: number }).schemaVersion = 999;
  const wrongBinding = sealExecutionArtifact({ ...claimArtifact.artifact, repositoryBindingId: "other-binding" });
  const wrongInstallation = sealExecutionArtifact({ ...claimArtifact.artifact, installationRecordId: "other-installation" });
  const wrongRepository = makeClaimArtifact({ ...claimScope, githubRepositoryId: "123456789" });
  const cases: Array<{ name: string; candidate: Record<string, unknown> }> = [
    { name: "modified payload with unchanged hash", candidate: candidate({ executionArtifact: tampered }) },
    { name: "modified payload with matching forged hash columns", candidate: candidate({
      executionArtifact: tampered, executionArtifactHash: "c".repeat(64), approvedArtifactHash: "c".repeat(64)
    }) },
    { name: "incorrect tenant", candidate: candidate({ tenantId: "other-tenant" }) },
    { name: "incorrect organization", candidate: candidate({ organizationId: "other-organization" }) },
    { name: "incorrect project", candidate: candidate({ projectId: "other-project" }) },
    { name: "incorrect proposal identity", candidate: candidate({ id: "other-proposal" }) },
    { name: "incorrect plan hash", candidate: candidate({ planHash: "e".repeat(64) }) },
    { name: "incorrect repository binding", candidate: candidate({ executionArtifact: wrongBinding.artifact,
      executionArtifactHash: wrongBinding.artifactHash, approvedArtifactHash: wrongBinding.artifactHash }) },
    { name: "incorrect installation identity", candidate: candidate({ executionArtifact: wrongInstallation.artifact,
      executionArtifactHash: wrongInstallation.artifactHash, approvedArtifactHash: wrongInstallation.artifactHash }) },
    { name: "incorrect immutable repository identity", candidate: candidate({ executionArtifact: wrongRepository.artifact,
      executionArtifactHash: wrongRepository.artifactHash, approvedArtifactHash: wrongRepository.artifactHash }) },
    { name: "missing artifact", candidate: candidate({ executionArtifact: null }) },
    { name: "malformed artifact", candidate: candidate({ executionArtifact: { schemaVersion: 2 } }) },
    { name: "unsupported artifact version", candidate: candidate({ executionArtifact: unsupported }) },
    { name: "approval hash mismatch", candidate: candidate({ approvedArtifactHash: "d".repeat(64) }) },
    { name: "missing installation binding", candidate: candidate({ installationRecordId: null }) }
  ];

  for (const item of cases) {
    let selected = false;
    const { client, queries, auditWrites } = mockPrisma({
      query: (query) => {
        if (query.text.includes("FROM remediations AS r")) {
          if (selected) return [];
          selected = true;
          return [item.candidate];
        }
        return query.text.includes("WITH candidate AS") ? claimedRow(query) : [];
      }
    });
    const result = await repository(client).claimNextPending("worker");
    assert.equal(result, null, item.name);
    assert.equal(queries.some((query) => query.text.includes("UPDATE remediations AS r")), false, item.name);
    assert.equal(auditWrites.length, 0, item.name);
  }
});

test("legacy pending rows with NULL approval state are excluded by the atomic claim", async () => {
  const sql = await capturedClaimSql();
  assert.match(sql, /status = 'pending'/);
  assert.match(sql, /approval_state = 'approved'/);
  assert.doesNotMatch(sql, /approval_state IS NULL/);
});

test("claim requires the persisted proposal row identifier and requester context", async () => {
  const sql = await capturedClaimSql();
  assert.match(sql, /id IS NOT NULL/);
  assert.match(sql, /requested_by_identity_user_id IS NOT NULL/);
  assert.match(sql, /plan_snapshot IS NOT NULL/);
  assert.match(sql, /plan_hash ~/);
});

test("claim excludes a proposal with a missing or malformed execution artifact", async () => {
  const sql = await capturedClaimSql();
  assert.match(sql, /execution_artifact IS NOT NULL/);
  assert.match(sql, /jsonb_typeof\(execution_artifact\) = 'object'/);
  assert.match(sql, /execution_artifact_hash ~/);
});

test("claim excludes a missing approved artifact hash", async () => {
  const sql = await capturedClaimSql();
  assert.match(sql, /approved_artifact_hash IS NOT NULL/);
});

test("claim excludes mismatched approved and execution artifact hashes", async () => {
  const sql = await capturedClaimSql();
  assert.match(sql, /approved_artifact_hash = execution_artifact_hash/);
});

test("claim excludes pending and rejected approval states", async () => {
  const sql = await capturedClaimSql();
  assert.match(sql, /approval_state = 'approved'/);
  assert.doesNotMatch(sql, /approval_state IN/);
});

test("claim excludes invalidated proposals", async () => {
  const sql = await capturedClaimSql();
  assert.match(sql, /approval_state = 'approved'/);
});

test("claim scope predicates reject cross-tenant and cross-project proposal relations", async () => {
  const sql = await capturedClaimSql();
  assert.match(sql, /p\.tenant_id = remediations\.tenant_id/);
  assert.match(sql, /p\.id = remediations\.project_id/);
  assert.match(sql, /s\.tenant_id = remediations\.tenant_id/);
  assert.match(sql, /s\.project_id = remediations\.project_id/);
  assert.match(sql, /f\.tenant_id = remediations\.tenant_id/);
  assert.match(sql, /f\.project_id = remediations\.project_id/);
  assert.match(sql, /f\.scan_id = remediations\.scan_id/);
  assert.match(sql, /b\.organization_id = remediations\.organization_id/);
  assert.match(sql, /b\.project_id = remediations\.project_id/);
});

test("renewal is fenced by tenant, status, token and unexpired database-time lease", async () => {
  const resultCounts = [1, 0];
  const queryResults: unknown[][] = [[{ id: "rem-1" }], [{ leaseExpiresAt: new Date("2026-11-06T00:01:00.000Z") }], [{ id: "rem-1" }]];
  const { client, queries } = mockPrisma({
    query: () => queryResults.shift() ?? [],
    execute: () => resultCounts.shift() ?? 0
  });
  const repository = new RemediationJobRepository(client);

  // First call needs one execution-row CAS; second is denied by a lost remediation lease.
  assert.equal(await repository.renewLease(lease()), true);
  assert.equal(await repository.renewLease(lease()), false);
  const query = queries[0].text;
  assert.match(query, /tenant_id/);
  assert.match(query, /status = 'running'/);
  assert.match(query, /lease_token/);
  assert.match(query, /lease_expires_at > clock_timestamp\(\)/);
});

test("stale completion cannot write or append an audit event", async () => {
  const { client, queries, auditWrites } = mockPrisma({ execute: () => 0 });
  const repository = new RemediationJobRepository(client);
  const result = await repository.completeLease(lease(), {
    kind: "pull-request",
    disposition: "reconciled",
    branchName: "cloudpilot/remediate/abc",
    prNumber: 9,
    prUrl: "https://github.com/o/r/pull/9",
    summary: "add metric"
  });

  assert.equal(result, false);
  assert.equal(auditWrites.length, 0);
  assert.match(queries[0].text, /id =/);
  assert.match(queries[0].text, /tenant_id =/);
  assert.match(queries[0].text, /status = 'running'/);
  assert.match(queries[0].text, /lease_token/);
  assert.match(queries[0].text, /lease_expires_at > NOW\(\)/);
});

test("expired lease reaper schedules retry or terminal failure with token fencing", async () => {
  const { client, queries, auditWrites } = mockPrisma({
    query: (query) => query.text.includes("SELECT id,") ? [
      { id: "rem-retry", tenantId: "tenant-1", projectId: "project-1", workerId: "w1", leaseToken: "a", retriesLeft: 3 },
      { id: "rem-exhausted", tenantId: "tenant-1", projectId: "project-1", workerId: "w2", leaseToken: "b", retriesLeft: 0 }
    ] : [],
    execute: () => 1
  });
  const repo = repository(client);
  const result = await repo.reclaimExpiredLeases();

  assert.deepEqual(result, { requeued: 1, failed: 1, manualReview: 0 });
  assert.match(queries[0]!.text, /FOR UPDATE SKIP LOCKED/);
  assert.match(queries[0]!.text, /lease_expires_at <= NOW\(\)/);
  assert.equal(auditWrites.length, 0, "the transactional execution lifecycle owns terminal audits");
});

test("retry delays are bounded to 2, 4 and 8 seconds", () => {
  assert.equal(retryDelayMs(3), 2_000);
  assert.equal(retryDelayMs(2), 4_000);
  assert.equal(retryDelayMs(1), 8_000);
  assert.equal(retryDelayMs(0), 0);
});
