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
    $queryRaw: async (parts: TemplateStringsArray) => parts.join(" ").includes("FROM remediations")
      ? [{ ...persisted.remediation }] : lockRow,
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
  return { service, persisted, calls: () => ({ tokenRequests, requests, invalidations }) };
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
