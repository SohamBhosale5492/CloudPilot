import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { planRemediation } from "../../../phase-07/src/remediation/planner.js";
import {
  RemediationExecutionAuthorizationService,
  type PersistedExecutionState
} from "../../src/remediation/execution-authorization.js";
import { renderExecutionArtifact, type TrustedRepositorySnapshot } from "../../src/remediation/execution-artifact.js";

const issuer = "https://issuer.example.test";
const tenantId = "tenant-1";
const orgId = "org-1";
const projectId = "project-1";
const scanId = "scan-1";
const findingId = "finding-1";
const proposalId = "proposal-1";
const bindingId = "binding-1";
const installationRecordId = "installation-1";
const repositoryId = "9007199254740993";
const identityUserId = "executor-user";
const requesterId = "requester-user";
const approverId = "approver-user";

const finding = {
  id: findingId, scanId, tenantId, projectId,
  requirementId: "http-requests", ruleId: "request-rate", ruleVersion: "1",
  signal: "metric", outcome: "gap", expected: "minimumCount >= 1", observed: "0", reason: "No request metric was observed."
};
const planned = planRemediation(finding);
const planSnapshot = {
  schemaVersion: 1,
  plannerVersion: "phase07-planner-v1",
  projectId,
  finding: {
    id: finding.id, scanId: finding.scanId, requirementId: finding.requirementId, ruleId: finding.ruleId,
    ruleVersion: finding.ruleVersion, signal: finding.signal, outcome: finding.outcome,
    expected: finding.expected, observed: finding.observed, reason: finding.reason
  },
  repository: { bindingId, repositoryId, installationRecordId, owner: "octo", name: "demo" },
  patch: { filePath: planned.filePath, title: planned.prTitle, body: planned.prBody,
    commitMessage: planned.commitMessage, summary: planned.summary }
};
const planHash = createHash("sha256").update(JSON.stringify(planSnapshot), "utf8").digest("hex");
const repositorySnapshot: TrustedRepositorySnapshot = {
  immutableRepositoryId: repositoryId, baseRef: "main", baseCommitSha: "b".repeat(40), filePath: planned.filePath,
  file: { content: null, contentBase64: null, blobSha: null, mode: null, fileType: null, isRegularFile: true }
};
const sealed = renderExecutionArtifact({
  scope: { proposalId, tenantId, organizationId: orgId, projectId, repositoryBindingId: bindingId,
    githubRepositoryId: repositoryId, installationRecordId, planHash },
  finding, snapshot: repositorySnapshot, createdAt: new Date("2026-11-05T00:00:00.000Z")
});

function baseState(): PersistedExecutionState {
  return {
    proposal: {
      id: proposalId, tenantId, organizationId: orgId, projectId, findingId, scanId,
      requesterIdentityUserId: requesterId, approverIdentityUserId: approverId,
      repositoryBindingId: bindingId, githubRepositoryId: repositoryId,
      approvalState: "approved", status: "pending_approval", planHash, planSnapshot: structuredClone(planSnapshot),
      executionArtifact: structuredClone(sealed.artifact), executionArtifactHash: sealed.artifactHash,
      approvedArtifactHash: sealed.artifactHash
    },
    identities: new Map([[requesterId, "active"], [approverId, "active"], [identityUserId, "active"]]),
    organizationStatus: "active",
    membership: { role: "admin", status: "active", userStatus: "active", organizationStatus: "active" },
    project: { id: projectId, tenantId, organizationId: orgId },
    scan: { id: scanId, tenantId, projectId },
    adoptionStatus: "approved",
    binding: {
      id: bindingId, tenantId, organizationId: orgId, projectId, installationRecordId,
      githubRepositoryId: repositoryId, ownerLogin: "octo", repositoryName: "demo", status: "active",
      installationOrganizationId: orgId, installationStatus: "active"
    },
    finding: structuredClone(finding)
  };
}

function harness(options: {
  state?: PersistedExecutionState; identityStatus?: string; identityFailure?: boolean;
  snapshot?: TrustedRepositorySnapshot; snapshotFailure?: boolean; now?: () => Date;
} = {}) {
  const state = options.state ?? baseState();
  const calls = { identity: 0, load: 0, snapshot: 0 };
  const service = new RemediationExecutionAuthorizationService(
    { async resolve(identity: { issuer: string; subject: string }, allowProvisioning: boolean) {
      calls.identity++;
      assert.equal(allowProvisioning, false);
      assert.equal(identity.issuer, issuer);
      if (options.identityFailure) throw new Error("private internal identity error");
      return { id: identityUserId, status: options.identityStatus ?? "active" } as never;
    } } as never,
    { async load(input) {
      calls.load++;
      assert.equal(input.tenantId, tenantId);
      assert.equal(input.remediationId, proposalId);
      assert.equal(input.identityUserId, identityUserId);
      return state;
    } },
    { async readSnapshot(request: { immutableRepositoryId: string; repositoryBindingId: string; installationRecordId: string; filePath: string }) {
      calls.snapshot++;
      assert.equal(request.immutableRepositoryId, repositoryId);
      assert.equal(request.repositoryBindingId, bindingId);
      assert.equal(request.installationRecordId, installationRecordId);
      assert.equal(request.filePath, planned.filePath);
      if (options.snapshotFailure) throw new Error("upstream response includes a fake token");
      return options.snapshot ?? repositorySnapshot;
    } } as never,
    issuer,
    options.now ?? (() => new Date("2026-11-05T01:00:00.000Z"))
  );
  return { service, state, calls };
}

const request = { identity: { issuer, subject: "verified-subject" }, tenantId, remediationId: proposalId };

test("authorized execution returns a frozen artifact-bound result after fresh repository validation", async () => {
  const h = harness();
  const result = await h.service.authorize(request);
  assert.equal(result.kind, "authorized");
  if (result.kind !== "authorized") return;
  const value = result.authorization;
  assert.equal(Object.isFrozen(value), true);
  assert.deepEqual({
    proposalId: value.proposalId, artifactHash: value.artifactHash, tenantId: value.tenantId,
    organizationId: value.organizationId, projectId: value.projectId, repositoryBindingId: value.repositoryBindingId,
    githubRepositoryId: value.githubRepositoryId, installationRecordId: value.installationRecordId,
    baseCommitSha: value.baseCommitSha, filePath: value.filePath, operation: value.operation,
    mode: value.mode, validatedAt: value.validatedAt
  }, {
    proposalId, artifactHash: sealed.artifactHash, tenantId, organizationId: orgId, projectId,
    repositoryBindingId: bindingId, githubRepositoryId: repositoryId, installationRecordId,
    baseCommitSha: repositorySnapshot.baseCommitSha, filePath: planned.filePath, operation: "create",
    mode: "100644", validatedAt: "2026-11-05T01:00:00.000Z"
  });
  assert.equal(value.originalContentBase64, null);
  assert.equal(value.renderedContent, sealed.artifact.renderedContent);
  assert.equal("token" in value, false);
  assert.equal("privateKey" in value, false);
  assert.equal("ownerLogin" in value, false);
  assert.equal("repositoryUrl" in value, false);
  assert.deepEqual(h.calls, { identity: 1, load: 1, snapshot: 1 });
});

test("missing, wrong-issuer, unresolved, and inactive identities fail before persistence or GitHub reads", async () => {
  for (const options of [{ identityFailure: true }, { identityStatus: "suspended" }]) {
    const h = harness(options);
    const result = await h.service.authorize(request);
    assert.deepEqual(result, { kind: "denied", reason: "identity_not_authorized" });
    assert.equal(h.calls.load, 0);
    assert.equal(h.calls.snapshot, 0);
  }
  const missing = harness();
  assert.deepEqual(await missing.service.authorize({ ...request, identity: null }), { kind: "denied", reason: "identity_required" });
  const wrongIssuer = harness();
  assert.deepEqual(await wrongIssuer.service.authorize({ ...request, identity: { issuer: "https://wrong.test", subject: "s" } }),
    { kind: "denied", reason: "identity_required" });
});

test("current membership and remediation approval permission are required", async () => {
  for (const change of [
    (s: PersistedExecutionState) => { s.membership = null; },
    (s: PersistedExecutionState) => { s.membership!.status = "inactive"; },
    (s: PersistedExecutionState) => { s.membership!.userStatus = "suspended"; },
    (s: PersistedExecutionState) => { s.membership!.organizationStatus = "inactive"; },
    (s: PersistedExecutionState) => { s.organizationStatus = "suspended"; },
    (s: PersistedExecutionState) => { s.membership!.role = "operator"; },
    (s: PersistedExecutionState) => { s.membership!.role = "viewer"; }
  ]) {
    const state = baseState(); change(state);
    const h = harness({ state });
    assert.deepEqual(await h.service.authorize(request), { kind: "denied", reason: "execution_permission_denied" });
    assert.equal(h.calls.snapshot, 0);
  }
  for (const role of ["owner", "admin"]) {
    const state = baseState(); state.membership!.role = role;
    assert.equal((await harness({ state }).service.authorize(request)).kind, "authorized");
  }
});

test("tenant, organization, project, scan, adoption, installation, and binding scope are revalidated", async () => {
  const cases: Array<(state: PersistedExecutionState) => void> = [
    (s) => { s.proposal.tenantId = "other-tenant"; },
    (s) => { s.project!.organizationId = "other-org"; },
    (s) => { s.project = null; },
    (s) => { s.scan = null; },
    (s) => { s.scan!.projectId = "other-project"; },
    (s) => { s.adoptionStatus = "rejected"; },
    (s) => { s.binding!.status = "disconnected"; },
    (s) => { s.binding!.projectId = "other-project"; },
    (s) => { s.binding!.organizationId = "other-org"; },
    (s) => { s.binding!.installationRecordId = "other-installation"; },
    (s) => { s.binding!.installationStatus = "suspended"; },
    (s) => { s.binding!.installationOrganizationId = "other-org"; },
    (s) => { s.binding!.githubRepositoryId = "42"; },
    (s) => { s.proposal.githubRepositoryId = "42"; },
    (s) => { s.identities = new Map([...s.identities, [requesterId, "suspended"]]); },
    (s) => { s.identities = new Map([...s.identities, [approverId, "suspended"]]); }
  ];
  for (const change of cases) {
    const state = baseState(); change(state);
    const result = await harness({ state }).service.authorize(request);
    assert.equal(result.kind, "denied", String(change));
  }
  const noLegacyFallback = baseState() as PersistedExecutionState & { legacyRepositoryUrl?: string };
  noLegacyFallback.legacyRepositoryUrl = "https://attacker.invalid/repo.git";
  assert.equal((await harness({ state: noLegacyFallback }).service.authorize(request)).kind, "authorized");
});

test("only an approved proposal with verified plan, artifact, and approval hash can authorize", async () => {
  const cases: Array<(state: PersistedExecutionState) => void> = [
    (s) => { s.proposal.approvalState = "pending"; },
    (s) => { s.proposal.approvalState = "rejected"; },
    (s) => { s.proposal.approvalState = "invalidated"; },
    (s) => { s.proposal.executionArtifact = null; },
    (s) => { s.proposal.planSnapshot = { ...(s.proposal.planSnapshot as object), tampered: true }; },
    (s) => { s.proposal.planHash = "0".repeat(64); },
    (s) => { s.finding!.reason = "changed after approval"; },
    (s) => { (s.proposal.executionArtifact as Record<string, unknown>).renderedContent = "tampered"; },
    (s) => { s.proposal.approvedArtifactHash = "0".repeat(64); },
    (s) => { (s.proposal.executionArtifact as Record<string, unknown>).proposalId = "other-proposal"; },
    (s) => { s.proposal.status = "failed"; },
    (s) => { s.proposal.requesterIdentityUserId = null; },
    (s) => { s.proposal.approverIdentityUserId = null; }
  ];
  for (const change of cases) {
    const state = baseState(); change(state);
    assert.equal((await harness({ state }).service.authorize(request)).kind, "denied");
  }
  const legacy = baseState();
  legacy.proposal.approvalState = null;
  assert.equal((await harness({ state: legacy }).service.authorize(request)).kind, "denied");
});

test("fresh repository state must match immutable repository, base commit, path, and original bytes", async () => {
  const changedHead = { ...repositorySnapshot, baseCommitSha: "c".repeat(40) };
  assert.deepEqual(await harness({ snapshot: changedHead }).service.authorize(request),
    { kind: "denied", reason: "repository_state_stale" });
  assert.deepEqual(await harness({ snapshot: { ...repositorySnapshot, immutableRepositoryId: "42" } }).service.authorize(request),
    { kind: "denied", reason: "repository_state_stale" });
  assert.deepEqual(await harness({ snapshot: { ...repositorySnapshot, baseCommitSha: "bad" } }).service.authorize(request),
    { kind: "denied", reason: "repository_state_stale" });
  const unavailable = harness({ snapshotFailure: true });
  assert.deepEqual(await unavailable.service.authorize(request), { kind: "denied", reason: "repository_state_unavailable" });
  assert.equal(unavailable.calls.snapshot, 1);
});

test("update authorization rejects changed source bytes and unsupported file metadata", async () => {
  const bytes = Buffer.from("metrics: []\r\n", "utf8");
  const updateSnapshot: TrustedRepositorySnapshot = {
    ...repositorySnapshot,
    file: { content: bytes.toString("utf8"), contentBase64: bytes.toString("base64"),
      blobSha: createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex"),
      mode: "100644", fileType: "blob", isRegularFile: true }
  };
  const updateArtifact = renderExecutionArtifact({
    scope: { proposalId, tenantId, organizationId: orgId, projectId, repositoryBindingId: bindingId,
      githubRepositoryId: repositoryId, installationRecordId, planHash }, finding, snapshot: updateSnapshot
  });
  const state = baseState();
  state.proposal.executionArtifact = updateArtifact.artifact;
  state.proposal.executionArtifactHash = updateArtifact.artifactHash;
  state.proposal.approvedArtifactHash = updateArtifact.artifactHash;
  const changed = { ...updateSnapshot, file: { ...updateSnapshot.file, contentBase64: Buffer.from("changed").toString("base64") } };
  assert.deepEqual(await harness({ state, snapshot: changed }).service.authorize(request),
    { kind: "denied", reason: "repository_state_stale" });
  for (const badFile of [
    { ...updateSnapshot.file, mode: "100755" as never },
    { ...updateSnapshot.file, fileType: "tree" as never },
    { ...updateSnapshot.file, isRegularFile: false }
  ]) assert.deepEqual(await harness({ state, snapshot: { ...updateSnapshot, file: badFile } }).service.authorize(request),
    { kind: "denied", reason: "repository_state_stale" });
});

test("contract never invokes GitHub write operations and caller fields cannot substitute trusted data", async () => {
  const h = harness();
  const result = await h.service.authorize({
    ...request,
    repositoryUrl: "https://attacker.invalid/repo.git", githubRepositoryId: "42", path: "../../evil",
    artifact: { renderedContent: "forged" }, installationToken: "secret-token", artifactHash: "0".repeat(64)
  } as never);
  assert.equal(result.kind, "authorized");
  if (result.kind === "authorized") {
    assert.equal(result.authorization.githubRepositoryId, repositoryId);
    assert.equal(result.authorization.filePath, planned.filePath);
    assert.equal(result.authorization.baseCommitSha, repositorySnapshot.baseCommitSha);
    assert.equal(result.authorization.renderedContent, sealed.artifact.renderedContent);
    assert.equal(JSON.stringify(result).includes("secret-token"), false);
    assert.equal(JSON.stringify(result).includes("attacker.invalid"), false);
  }
  assert.deepEqual(h.calls, { identity: 1, load: 1, snapshot: 1 });
});
