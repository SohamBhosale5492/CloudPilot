import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import type { RemediationLease } from "../../src/jobs/remediation-repo.js";
import { GitHubExecutionCapabilityService } from "../../src/github/github-execution-capability.js";
import { isAuthorizedArtifactPullRequestCapability } from "../../src/github/github-execution-capability.js";
import { ArtifactGitHubClientError } from "../../src/github/artifact-only-github-client.js";
import { GITHUB_ARTIFACT_WRITER_PERMISSIONS, type GitHubInstallationToken } from "../../src/github/app-token-service.js";
import { renderExecutionArtifact } from "../../src/remediation/execution-artifact.js";
import { TrustedClaimExecutionContextService } from "../../src/remediation/trusted-claim-execution-context.js";

const lease: RemediationLease = { id: "proposal-cap", tenantId: "tenant-cap", projectId: "project-cap", workerId: "worker-cap",
  leaseToken: "d60587a1-58d7-4836-bc3d-f8ebecb10147", retriesLeft: 1 };
const ids = { organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", bindingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  installationRecordId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", installationId: "9223372036854775000",
  repositoryId: "9007199254740993", requesterId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  approverId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", scanId: "scan-cap", findingId: "finding-cap" };
const finding = { id: ids.findingId, scanId: ids.scanId, requirementId: "r", ruleId: "rule", ruleVersion: "1", signal: "metric",
  outcome: "gap", expected: "count >= 1", observed: "0", reason: "Missing evidence." };
const planSnapshot = { schemaVersion: 1, plannerVersion: "phase07-planner-v1", projectId: lease.projectId, finding,
  repository: { bindingId: ids.bindingId, repositoryId: ids.repositoryId, installationRecordId: ids.installationRecordId,
    owner: "octo", name: "demo" }, patch: { filePath: "config/observability/metrics.yaml", title: "t", body: "b", commitMessage: "m", summary: "s" } };
const planHash = createHash("sha256").update(JSON.stringify(planSnapshot)).digest("hex");
const approvedAt = new Date("2026-11-05T00:00:00.000Z");
const artifact = renderExecutionArtifact({
  scope: { proposalId: lease.id, tenantId: lease.tenantId, organizationId: ids.organizationId, projectId: lease.projectId,
    repositoryBindingId: ids.bindingId, githubRepositoryId: ids.repositoryId, installationRecordId: ids.installationRecordId, planHash },
  finding, snapshot: { immutableRepositoryId: ids.repositoryId, baseRef: "main", baseCommitSha: "b".repeat(40),
    filePath: "config/observability/metrics.yaml", file: { content: null, contentBase64: null, blobSha: null,
      mode: null, fileType: null, isRegularFile: true } }, createdAt: approvedAt
});

function state() {
  return {
    remediation: { id: lease.id, tenantId: lease.tenantId, organizationId: ids.organizationId, projectId: lease.projectId,
      scanId: ids.scanId, findingId: ids.findingId, status: "running", workerId: lease.workerId, leaseToken: lease.leaseToken,
      leaseExpiresAt: new Date(Date.now() + 120_000), approvalState: "approved", requestedByIdentityUserId: ids.requesterId,
      approvedByIdentityUserId: ids.approverId, approvedAt, repositoryBindingId: ids.bindingId,
      githubRepositoryId: BigInt(ids.repositoryId), planHash, planSnapshot: structuredClone(planSnapshot),
      executionArtifact: structuredClone(artifact.artifact), executionArtifactHash: artifact.artifactHash,
      approvedArtifactHash: artifact.artifactHash },
    organizationStatus: "active",
    project: { id: lease.projectId, tenantId: lease.tenantId, organizationId: ids.organizationId },
    scan: { id: ids.scanId, tenantId: lease.tenantId, projectId: lease.projectId }, finding: { ...finding, tenantId: lease.tenantId,
      projectId: lease.projectId }, adoptionStatus: "approved",
    binding: { id: ids.bindingId, tenantId: lease.tenantId, organizationId: ids.organizationId, projectId: lease.projectId,
      installationRecordId: ids.installationRecordId, githubRepositoryId: BigInt(ids.repositoryId), ownerLogin: "octo",
      repositoryName: "demo", status: "active", installation: { organizationId: ids.organizationId, status: "active",
        githubInstallationId: BigInt(ids.installationId) } }, requesterStatus: "active", approverStatus: "active",
    approverMembership: { role: "admin", status: "active", userStatus: "active", organizationStatus: "active" }
  };
}

function setup(options: { mutate?: (s: ReturnType<typeof state>) => void; tokenMutate?: (t: GitHubInstallationToken) => GitHubInstallationToken;
  now?: () => number; repositoryOwner?: string } = {}) {
  const persisted = state(); options.mutate?.(persisted);
  const lockRow = [{ id: "locked" }];
  const tx = {
    $queryRaw: async (parts: TemplateStringsArray) => {
      const sql = parts.join(" ");
      if (sql.includes("FROM remediations")) return [{ ...persisted.remediation }];
      if (sql.includes("cloudpilot_lock_active_organization") || sql.includes("cloudpilot_lock_scoped_finding") ||
          sql.includes("cloudpilot_lock_active_binding_installation")) return [{ locked: true }];
      if (sql.includes("cloudpilot_lock_active_member") || sql.includes("cloudpilot_lock_active_actor_for_update")) {
        return [{ role: persisted.approverMembership?.role ?? null }];
      }
      return lockRow;
    },
    organization: { findUnique: async () => ({ status: persisted.organizationStatus }) },
    project: { findFirst: async () => persisted.project }, scan: { findFirst: async () => persisted.scan },
    finding: { findFirst: async () => persisted.finding },
    projectOrganizationAdoption: { findFirst: async () => persisted.adoptionStatus === "approved" ? { status: "approved" } : null },
    projectGitHubRepository: { findFirst: async () => persisted.binding },
    identityUser: { findMany: async () => [
      { id: ids.requesterId, status: persisted.requesterStatus }, { id: ids.approverId, status: persisted.approverStatus }
    ] },
    organizationMember: { findFirst: async () => persisted.approverMembership ? {
      role: persisted.approverMembership.role, status: persisted.approverMembership.status,
      user: { status: persisted.approverMembership.userStatus }, organization: { status: persisted.approverMembership.organizationStatus }
    } : null }
  };
  const prisma = { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
  const contexts = new TrustedClaimExecutionContextService(prisma);
  let tokenRequests = 0; let invalidations = 0; let requests = 0;
  const now = options.now ?? Date.now;
  const minted: GitHubInstallationToken = Object.freeze({ token: "test-token-hidden", expiresAt: new Date(now() + 90_000).toISOString(),
    installationId: ids.installationId, repositoryId: ids.repositoryId, permissions: GITHUB_ARTIFACT_WRITER_PERMISSIONS });
  const tokens = { async getArtifactWriterInstallationToken(input: { installationId: string; repositoryId: string }) {
    tokenRequests++; assert.equal(input.installationId, ids.installationId); assert.equal(input.repositoryId, ids.repositoryId);
    return options.tokenMutate ? options.tokenMutate(minted) : minted;
  }, async getDraftPullRequestInstallationToken(input: { installationId: string; repositoryId: string }) {
    tokenRequests++; assert.equal(input.installationId, ids.installationId); assert.equal(input.repositoryId, ids.repositoryId);
    return { ...minted, permissions: { pull_requests: "write", metadata: "read" } } as GitHubInstallationToken;
  }, invalidate() { invalidations++; } };
  const fetchImpl = (async (input: string | URL | Request) => {
    requests++;
    const url = String(input);
    if (url === `https://api.github.com/repositories/${ids.repositoryId}`) return new Response(
      `{"id":${ids.repositoryId},"name":"demo","owner":{"login":"${options.repositoryOwner ?? "octo"}"},"default_branch":"main","archived":false,"disabled":false}`,
      { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ ref: "refs/heads/main", object: { type: "commit", sha: "b".repeat(40) } }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const service = new GitHubExecutionCapabilityService(contexts, tokens, { now, clientOptions: { fetchImpl } });
  return { service, persisted, contexts, calls: () => ({ tokenRequests, requests, invalidations }) };
}

test("issues an opaque capability only after persistence, token scope, and immutable GitHub identity agree", async () => {
  const h = setup();
  const otherIssuer = setup();
  const capability = await h.service.issue(lease);
  assert.ok(capability);
  assert.equal(capability.repositoryId, ids.repositoryId);
  assert.equal(capability.installationId, ids.installationId);
  assert.equal(capability.repository.owner, "octo");
  assert.equal(capability.repository.name, "demo");
  assert.deepEqual(capability.permissions, { contents: "write", metadata: "read" });
  assert.equal("token" in capability, false);
  assert.throws(() => JSON.stringify(capability), /serialization is prohibited/u);
  assert.equal(h.service.clientFor({ ...capability }), null);
  assert.equal(otherIssuer.service.clientFor(capability), null, "capabilities cannot cross service/organization boundaries");
  assert.ok(h.service.clientFor(capability));
  assert.deepEqual(h.calls(), { tokenRequests: 1, requests: 1, invalidations: 0 });
});

test("issues a separate pull-request-only capability linked to the exact live artifact capability", async () => {
  const h = setup();
  const capability = await h.service.issue(lease);
  assert.ok(capability);
  const prCapability = await h.service.issueDraftPullRequestCapability(capability);
  assert.ok(prCapability);
  assert.equal(isAuthorizedArtifactPullRequestCapability(prCapability), true);
  assert.deepEqual(prCapability.permissions, { pull_requests: "write", metadata: "read" });
  assert.deepEqual(capability.permissions, { contents: "write", metadata: "read" });
  assert.equal(h.service.pullRequestClientFor(prCapability), h.service.pullRequestClientFor(prCapability));
  assert.equal("token" in prCapability, false);
  assert.throws(() => JSON.stringify(prCapability), /serialization is prohibited/u);
  assert.deepEqual(h.calls(), { tokenRequests: 2, requests: 2, invalidations: 0 });
  h.service.invalidateLease(lease.id);
  assert.equal(h.service.pullRequestClientFor(prCapability), null);
});

test("persisted authorization and lease are rechecked before every GitHub request", async () => {
  const h = setup();
  const capability = await h.service.issue(lease);
  assert.ok(capability);
  const client = h.service.clientFor(capability);
  assert.ok(client);
  h.persisted.approverMembership = { ...h.persisted.approverMembership!, role: "viewer" };
  await assert.rejects(client.readReference(capability.repository, "main"),
    (error: unknown) => error instanceof ArtifactGitHubClientError && error.code === "invalid_token");
  assert.deepEqual(h.calls(), { tokenRequests: 1, requests: 1, invalidations: 1 });
  assert.equal(h.service.clientFor(capability), null);
});

test("request-time revalidation rejects status, scope, artifact, and lease changes before upstream I/O", async () => {
  const mutations: Array<(s: ReturnType<typeof state>) => void> = [
    (s) => { s.requesterStatus = "suspended"; },
    (s) => { s.approverStatus = "suspended"; },
    (s) => { s.approverMembership = { ...s.approverMembership!, role: "viewer" }; },
    (s) => { s.adoptionStatus = "rejected"; },
    (s) => { s.binding!.status = "disconnected"; },
    (s) => { s.binding!.installation.status = "revoked"; },
    (s) => { s.remediation.leaseToken = "ffffffff-ffff-4fff-8fff-ffffffffffff"; },
    (s) => { s.remediation.approvedArtifactHash = "0".repeat(64); },
    (s) => { s.remediation.executionArtifactHash = "0".repeat(64); }
  ];
  for (const mutate of mutations) {
    const h = setup();
    const capability = await h.service.issue(lease);
    assert.ok(capability);
    const client = h.service.clientFor(capability);
    assert.ok(client);
    mutate(h.persisted);
    await assert.rejects(client.readReference(capability.repository, "main"),
      (error: unknown) => error instanceof ArtifactGitHubClientError && error.code === "invalid_token");
    assert.equal(h.calls().requests, 1, "authorization change prevents the next upstream request");
  }
});

test("denied, stale, or mismatched persisted states do not mint tokens", async () => {
  const mutations: Array<(s: ReturnType<typeof state>) => void> = [
    (s) => { s.requesterStatus = "suspended"; },
    (s) => { s.approverStatus = "suspended"; },
    (s) => { s.approverMembership = { ...s.approverMembership!, role: "operator" }; },
    (s) => { s.project!.organizationId = "ffffffff-ffff-4fff-8fff-ffffffffffff"; },
    (s) => { s.adoptionStatus = "rejected"; },
    (s) => { s.binding!.status = "disconnected"; },
    (s) => { s.binding!.githubRepositoryId = 42n; },
    (s) => { s.binding!.installation.status = "suspended"; },
    (s) => { s.binding!.installation.status = "revoked"; },
    (s) => { s.binding!.installation.organizationId = "ffffffff-ffff-4fff-8fff-ffffffffffff"; },
    (s) => { (s.remediation.executionArtifact as unknown as Record<string, unknown>).baseRef = "release"; },
    (s) => { s.binding!.installation.organizationId = "ffffffff-ffff-4fff-8fff-ffffffffffff"; },
    (s) => { s.remediation.approvedArtifactHash = "0".repeat(64); },
    (s) => { s.remediation.leaseToken = "ffffffff-ffff-4fff-8fff-ffffffffffff"; }
  ];
  for (const mutate of mutations) {
    const h = setup({ mutate });
    assert.equal(await h.service.issue(lease), null);
    assert.equal(h.calls().tokenRequests, 0);
  }
});

test("token scope, immutable identity mismatch, and expiry fail closed", async () => {
  const permissionMismatch = setup({ tokenMutate: (t) => ({ ...t, permissions: { ...t.permissions, pull_requests: "read" } as never }) });
  assert.equal(await permissionMismatch.service.issue(lease), null);
  assert.equal(permissionMismatch.calls().requests, 0);
  const idMismatch = setup({ tokenMutate: (t) => ({ ...t, repositoryId: "42" }) });
  assert.equal(await idMismatch.service.issue(lease), null);
  assert.equal(idMismatch.calls().requests, 0);
  const repoMismatch = setup({ repositoryOwner: "attacker" });
  // Wrong owner/name returned for the immutable ID cannot mint a capability.
  assert.equal(await repoMismatch.service.issue(lease), null);
});

test("capability expiry and explicit lifecycle invalidation fence future client requests", async () => {
  let now = Date.now();
  const h = setup({ now: () => now });
  const capability = await h.service.issue(lease);
  assert.ok(capability);
  h.service.invalidateLease(lease.id);
  assert.equal(h.service.clientFor(capability), null);
  assert.equal(h.calls().requests, 1);
  const second = await setup({ now: () => now });
  const next = await second.service.issue(lease);
  assert.ok(next);
  now += 120_000;
  assert.equal(second.service.clientFor(next), null);
});

test("binding, organization, identity, and installation invalidation revoke capabilities and invalidate token cache", async () => {
  const cases: Array<(service: GitHubExecutionCapabilityService) => void> = [
    (service) => service.invalidateBinding(ids.bindingId),
    (service) => service.invalidateOrganization(ids.organizationId),
    (service) => service.invalidateIdentity(ids.approverId),
    (service) => service.invalidateInstallation(ids.installationId)
  ];
  for (const invalidate of cases) {
    const h = setup();
    const capability = await h.service.issue(lease);
    assert.ok(capability);
    invalidate(h.service);
    assert.equal(h.service.clientFor(capability), null);
    assert.equal(h.calls().invalidations, 1);
  }
});

test("accepts monotonic lease heartbeat renewals while keeping capability expiry bounded by installation token expiry", async () => {
  let currentNow = 1_000_000;
  const h = setup({
    now: () => currentNow,
    mutate: (s) => { s.remediation.leaseExpiresAt = new Date(currentNow + 30_000); },
    tokenMutate: (t) => ({ ...t, expiresAt: new Date(currentNow + 90_000).toISOString() })
  });
  const capability = await h.service.issue(lease);
  assert.ok(capability);
  const initialTokenExpiry = new Date(currentNow + 90_000).getTime();
  assert.equal(new Date(capability.expiresAt).getTime(), currentNow + 30_000);

  // First heartbeat renewal: extends lease to +60s
  currentNow += 15_000;
  h.persisted.remediation.leaseExpiresAt = new Date(currentNow + 45_000);
  const client1 = h.service.clientFor(capability);
  assert.ok(client1);
  await client1.readReference(capability.repository, "main");

  // Second consecutive renewal: extends lease past installation-token expiry (+150s),
  // capability expiry must remain bounded by token expiry.
  currentNow += 15_000;
  h.persisted.remediation.leaseExpiresAt = new Date(currentNow + 150_000);
  await client1.readReference(capability.repository, "main");
  assert.ok(h.service.clientFor(capability));

  // Once installation-token expiry is reached, capability is expired even if DB lease is still in the future.
  currentNow = initialTokenExpiry;
  assert.equal(h.service.clientFor(capability), null);
});

test("rejects shortened or expired lease renewals, changed workerId or leaseToken, and changed immutable scope", async () => {
  // 1. Shortened lease renewal (monotonicity violation)
  {
    let currentNow = 2_000_000;
    const h = setup({
      now: () => currentNow,
      mutate: (s) => { s.remediation.leaseExpiresAt = new Date(currentNow + 60_000); }
    });
    const capability = await h.service.issue(lease);
    assert.ok(capability);
    const client = h.service.clientFor(capability);
    assert.ok(client);
    currentNow += 5_000;
    h.persisted.remediation.leaseExpiresAt = new Date(2_000_000 + 30_000);
    await assert.rejects(client.readReference(capability.repository, "main"),
      (error: unknown) => error instanceof ArtifactGitHubClientError && error.code === "invalid_token");
    assert.equal(h.service.clientFor(capability), null);
  }

  // 2. Expired lease (leaseExpiresAt <= now)
  {
    let currentNow = 3_000_000;
    const h = setup({
      now: () => currentNow,
      mutate: (s) => { s.remediation.leaseExpiresAt = new Date(currentNow + 30_000); }
    });
    const capability = await h.service.issue(lease);
    assert.ok(capability);
    const client = h.service.clientFor(capability);
    assert.ok(client);
    h.persisted.remediation.leaseExpiresAt = new Date(currentNow);
    await assert.rejects(client.readReference(capability.repository, "main"),
      (error: unknown) => error instanceof ArtifactGitHubClientError && error.code === "invalid_token");
    assert.equal(h.service.clientFor(capability), null);
  }

  // 3. Changed workerId or leaseToken
  for (const mutateField of [
    (s: ReturnType<typeof state>) => { s.remediation.workerId = "worker-other"; },
    (s: ReturnType<typeof state>) => { s.remediation.leaseToken = "00000000-0000-4000-8000-000000000000"; }
  ]) {
    const h = setup();
    const capability = await h.service.issue(lease);
    assert.ok(capability);
    const client = h.service.clientFor(capability);
    assert.ok(client);
    mutateField(h.persisted);
    await assert.rejects(client.readReference(capability.repository, "main"),
      (error: unknown) => error instanceof ArtifactGitHubClientError && error.code === "invalid_token");
    assert.equal(h.service.clientFor(capability), null);
  }

  // 4. Changed immutable scope (approvedArtifactHash / baseCommitSha)
  {
    const h = setup();
    const capability = await h.service.issue(lease);
    assert.ok(capability);
    const client = h.service.clientFor(capability);
    assert.ok(client);
    const alteredArtifact = renderExecutionArtifact({
      scope: { proposalId: lease.id, tenantId: lease.tenantId, organizationId: ids.organizationId, projectId: lease.projectId,
        repositoryBindingId: ids.bindingId, githubRepositoryId: ids.repositoryId, installationRecordId: ids.installationRecordId, planHash },
      finding,
      snapshot: { immutableRepositoryId: ids.repositoryId, baseRef: "main", baseCommitSha: "c".repeat(40),
        filePath: "config/observability/metrics.yaml", file: { content: null, contentBase64: null, blobSha: null,
          mode: null, fileType: null, isRegularFile: true } },
      createdAt: approvedAt
    });
    h.persisted.remediation.executionArtifact = structuredClone(alteredArtifact.artifact);
    h.persisted.remediation.executionArtifactHash = alteredArtifact.artifactHash;
    h.persisted.remediation.approvedArtifactHash = alteredArtifact.artifactHash;
    await assert.rejects(client.readReference(capability.repository, "main"),
      (error: unknown) => error instanceof ArtifactGitHubClientError && error.code === "invalid_token");
    assert.equal(h.service.clientFor(capability), null);
  }
});

test("issue refreshes the initial capability expiry from the confirmed lease, bounded by installation-token expiry", async () => {
  for (const extensionMs of [60_000, 200_000]) {
    const start = 5_000_000;
    let currentNow = start;
    const h = setup({
      now: () => currentNow,
      mutate: (s) => { s.remediation.leaseExpiresAt = new Date(start + 30_000); },
      tokenMutate: (t) => ({ ...t, expiresAt: new Date(start + 90_000).toISOString() })
    });
    const original = h.contexts.prepare.bind(h.contexts);
    let extended = false;
    h.contexts.prepare = async (value) => {
      // Only the post-resolution confirmation read (after the repository fetch) observes the heartbeat renewal.
      if (!extended && h.calls().requests >= 1) {
        extended = true;
        h.persisted.remediation.leaseExpiresAt = new Date(start + extensionMs);
      }
      return original(value);
    };
    const capability = await h.service.issue(lease);
    assert.ok(capability);
    assert.equal(extended, true);
    currentNow = start + 45_000;
    assert.ok(h.service.clientFor(capability), "confirmed renewal must extend the internal capability expiry");
    if (extensionMs === 60_000) {
      currentNow = start + 60_000;
      assert.equal(h.service.clientFor(capability), null);
    } else {
      currentNow = start + 89_999;
      assert.ok(h.service.clientFor(capability));
      currentNow = start + 90_000;
      assert.equal(h.service.clientFor(capability), null, "renewal can never exceed installation-token expiry");
    }
  }
});

test("an older in-flight lease snapshot cannot revoke a capability after a newer renewal was accepted", async () => {
  const h = setup();
  const capability = await h.service.issue(lease);
  assert.ok(capability);
  const guard = h.service.leaseGuardFor(capability);
  assert.ok(guard);
  const original = h.contexts.prepare.bind(h.contexts);
  const base = h.persisted.remediation.leaseExpiresAt.getTime();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markTaken!: () => void;
  const taken = new Promise<void>((resolve) => { markTaken = resolve; });
  let call = 0;
  h.contexts.prepare = async (value) => {
    call++;
    if (call === 1) {
      h.persisted.remediation.leaseExpiresAt = new Date(base + 15_000);
      const older = await original(value);
      markTaken();
      await gate;
      return older;
    }
    h.persisted.remediation.leaseExpiresAt = new Date(base + 30_000);
    return original(value);
  };
  const olderCheck = guard.assertOwned();
  await taken;
  await guard.assertOwned();
  release();
  await olderCheck;
  assert.ok(h.service.clientFor(capability), "superseded snapshot must not revoke");
  assert.equal(h.calls().invalidations, 0);

  // A read that starts after the accepted renewal and reports a shorter lease is still a shortening and fails closed.
  h.contexts.prepare = async (value) => {
    h.persisted.remediation.leaseExpiresAt = new Date(base + 15_000);
    return original(value);
  };
  await assert.rejects(guard.assertOwned());
  assert.equal(h.service.clientFor(capability), null);
  assert.equal(h.calls().invalidations, 1);
});

test("a superseded lease snapshot with changed immutable scope still revokes the capability", async () => {
  const h = setup();
  const capability = await h.service.issue(lease);
  assert.ok(capability);
  const guard = h.service.leaseGuardFor(capability);
  assert.ok(guard);
  const original = h.contexts.prepare.bind(h.contexts);
  const base = h.persisted.remediation.leaseExpiresAt.getTime();
  const altered = renderExecutionArtifact({
    scope: { proposalId: lease.id, tenantId: lease.tenantId, organizationId: ids.organizationId, projectId: lease.projectId,
      repositoryBindingId: ids.bindingId, githubRepositoryId: ids.repositoryId, installationRecordId: ids.installationRecordId, planHash },
    finding,
    snapshot: { immutableRepositoryId: ids.repositoryId, baseRef: "main", baseCommitSha: "c".repeat(40),
      filePath: "config/observability/metrics.yaml", file: { content: null, contentBase64: null, blobSha: null,
        mode: null, fileType: null, isRegularFile: true } },
    createdAt: approvedAt
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markTaken!: () => void;
  const taken = new Promise<void>((resolve) => { markTaken = resolve; });
  let call = 0;
  h.contexts.prepare = async (value) => {
    call++;
    if (call === 1) {
      const saved = { ...h.persisted.remediation };
      h.persisted.remediation.executionArtifact = structuredClone(altered.artifact);
      h.persisted.remediation.executionArtifactHash = altered.artifactHash;
      h.persisted.remediation.approvedArtifactHash = altered.artifactHash;
      h.persisted.remediation.leaseExpiresAt = new Date(base + 15_000);
      const older = await original(value);
      Object.assign(h.persisted.remediation, saved);
      markTaken();
      await gate;
      return older;
    }
    h.persisted.remediation.leaseExpiresAt = new Date(base + 30_000);
    return original(value);
  };
  const olderCheck = guard.assertOwned();
  await taken;
  await guard.assertOwned();
  release();
  await assert.rejects(olderCheck);
  assert.equal(h.service.clientFor(capability), null);
});

test("currentDeadlineFor follows accepted renewals, never moves backwards, and never exceeds token expiry", async () => {
  const start = 7_000_000;
  let currentNow = start;
  const h = setup({
    now: () => currentNow,
    mutate: (s) => { s.remediation.leaseExpiresAt = new Date(start + 30_000); },
    tokenMutate: (t) => ({ ...t, expiresAt: new Date(start + 90_000).toISOString() })
  });
  const capability = await h.service.issue(lease);
  assert.ok(capability);
  const guard = h.service.leaseGuardFor(capability);
  assert.ok(guard);
  assert.equal(h.service.currentDeadlineFor(capability), start + 30_000);
  assert.equal(h.service.currentDeadlineFor({ ...capability }), null, "copied capabilities have no deadline");

  currentNow = start + 20_000;
  h.persisted.remediation.leaseExpiresAt = new Date(start + 50_000);
  await guard.assertOwned();
  assert.equal(h.service.currentDeadlineFor(capability), start + 50_000);

  // Out-of-order: an older read resolving after a newer accepted renewal cannot move the deadline backwards.
  const original = h.contexts.prepare.bind(h.contexts);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markTaken!: () => void;
  const taken = new Promise<void>((resolve) => { markTaken = resolve; });
  let call = 0;
  h.contexts.prepare = async (value) => {
    call++;
    if (call === 1) {
      h.persisted.remediation.leaseExpiresAt = new Date(start + 55_000);
      const older = await original(value);
      markTaken();
      await gate;
      return older;
    }
    h.persisted.remediation.leaseExpiresAt = new Date(start + 70_000);
    return original(value);
  };
  const olderCheck = guard.assertOwned();
  await taken;
  await guard.assertOwned();
  assert.equal(h.service.currentDeadlineFor(capability), start + 70_000);
  release();
  await olderCheck;
  assert.equal(h.service.currentDeadlineFor(capability), start + 70_000, "deadline never moves backwards");

  // No renewal can extend authorization beyond installation-token expiry.
  h.contexts.prepare = original;
  h.persisted.remediation.leaseExpiresAt = new Date(start + 500_000);
  await guard.assertOwned();
  assert.equal(h.service.currentDeadlineFor(capability), start + 90_000);
  currentNow = start + 90_000;
  assert.equal(h.service.currentDeadlineFor(capability), null);
  await assert.rejects(guard.assertOwned());
});

test("watchDeadline fires once on revocation or deadline expiry and is disposable", async () => {
  // Revocation fires immediately, exactly once.
  {
    const h = setup();
    const capability = await h.service.issue(lease);
    assert.ok(capability);
    let fired = 0;
    const stop = h.service.watchDeadline(capability, () => { fired++; });
    h.service.invalidateLease(lease.id);
    h.service.invalidateLease(lease.id);
    assert.equal(fired, 1);
    stop();
  }
  // Deadline expiry fires via a single re-armed timer (real clock, short lease).
  {
    const h = setup({ mutate: (s) => { s.remediation.leaseExpiresAt = new Date(Date.now() + 150); } });
    const capability = await h.service.issue(lease);
    assert.ok(capability);
    let fired = 0;
    const stop = h.service.watchDeadline(capability, () => { fired++; });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(fired, 1);
    assert.equal(h.service.currentDeadlineFor(capability), null);
    stop();
  }
  // A disposed watcher never fires, and forged capabilities fire immediately (fail closed).
  {
    const h = setup();
    const capability = await h.service.issue(lease);
    assert.ok(capability);
    let fired = 0;
    const stop = h.service.watchDeadline(capability, () => { fired++; });
    stop();
    h.service.invalidateLease(lease.id);
    assert.equal(fired, 0);
    let forgedFired = 0;
    h.service.watchDeadline({ ...capability }, () => { forgedFired++; });
    assert.equal(forgedFired, 1);
  }
});
