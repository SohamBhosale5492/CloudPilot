import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gitBlobSha } from "../../src/github/contents-read-token-service.js";
import {
  renderExecutionArtifact, sealExecutionArtifact, validateApprovedArtifactForExecution,
  verifyExecutionArtifact, EXECUTION_ARTIFACT_ORIGINAL_FILE_MAX_BYTES
} from "../../src/remediation/execution-artifact.js";

const scope = {
  proposalId: "p-1", tenantId: "t-1", organizationId: "o-1", projectId: "pjt-1",
  repositoryBindingId: "b-1", githubRepositoryId: "987654321012345", installationRecordId: "i-1",
  planHash: "a".repeat(64)
};
const finding = {
  requirementId: "http-requests", ruleId: "request-rate", ruleVersion: "1",
  signal: "metric", outcome: "gap", expected: "minimumCount >= 1", observed: "0", reason: "missing"
};
const snapshot = {
  immutableRepositoryId: scope.githubRepositoryId, baseRef: "main", baseCommitSha: "b".repeat(40),
  filePath: "config/observability/metrics.yaml",
  file: { content: null, contentBase64: null, blobSha: null, mode: null, fileType: null, isRegularFile: true }
};
function makeArtifact() {
  return renderExecutionArtifact({
    scope, finding, snapshot,
    createdAt: new Date("2026-11-05T00:00:00.000Z")
  });
}

test("identical trusted inputs produce deterministic rendered artifact and hash", () => {
  const one = makeArtifact();
  const two = makeArtifact();
  assert.deepEqual(one, two);
  assert.equal(verifyExecutionArtifact(one.artifact, one.artifactHash, scope), true);
});

test("artifact hash binds scope, base, planner output, original evidence, and rendered content", () => {
  const original = makeArtifact();
  const modified = structuredClone(original.artifact);
  modified.baseCommitSha = "c".repeat(40);
  assert.equal(verifyExecutionArtifact(modified, original.artifactHash), false);
  const rendered = structuredClone(original.artifact);
  rendered.renderedContent += "# change\n";
  assert.throws(() => sealExecutionArtifact(rendered), /integrity validation failed/);
  for (const key of ["repositoryBindingId", "githubRepositoryId", "installationRecordId", "planHash"] as const) {
    const altered = structuredClone(original.artifact);
    altered[key] = key === "githubRepositoryId" ? "987654321012346" :
      key === "planHash" ? "c".repeat(64) : "changed";
    assert.equal(verifyExecutionArtifact(altered, original.artifactHash), false);
  }
});

const exactOriginalText = "# note: café  \t\r\nmetrics: []\r\n";
const exactOriginalBytes = Buffer.from(exactOriginalText, "utf8");
const existingFileSnapshot = {
  ...snapshot,
  file: {
    content: exactOriginalText,
    contentBase64: exactOriginalBytes.toString("base64"),
    blobSha: gitBlobSha(exactOriginalBytes),
    mode: "100644" as const,
    fileType: "blob" as const,
    isRegularFile: true
  }
};

test("update artifact preserves exact original bytes and hashes the original evidence", () => {
  const sealed = renderExecutionArtifact({
    scope, finding, snapshot: existingFileSnapshot,
    createdAt: new Date("2026-11-05T00:00:00.000Z")
  });
  assert.equal(sealed.artifact.operation, "update");
  assert.equal(sealed.artifact.originalContentBase64, exactOriginalBytes.toString("base64"));
  assert.deepEqual(Buffer.from(sealed.artifact.originalContentBase64!, "base64"), exactOriginalBytes);
  assert.equal(sealed.artifact.originalContentSha256, createHash("sha256").update(exactOriginalBytes).digest("hex"));
  assert.equal(sealed.artifact.originalBlobSha, gitBlobSha(exactOriginalBytes));
  assert.equal(sealed.artifact.originalMode, "100644");
  assert.equal(sealed.artifact.originalFileType, "blob");
  assert.equal(verifyExecutionArtifact(sealed.artifact, sealed.artifactHash, scope), true);
  const approvedContext = {
    artifact: sealed.artifact, artifactHash: sealed.artifactHash, approvedArtifactHash: sealed.artifactHash,
    approvalState: "approved", planHash: scope.planHash, repositoryBindingId: scope.repositoryBindingId,
    githubRepositoryId: scope.githubRepositoryId, installationRecordId: scope.installationRecordId,
    currentBaseCommitSha: snapshot.baseCommitSha, currentRenderedContent: sealed.artifact.renderedContent
  };
  assert.equal(validateApprovedArtifactForExecution(approvedContext), true);
  assert.equal(validateApprovedArtifactForExecution({ ...approvedContext, currentBaseCommitSha: "c".repeat(40) }), false);
});

test("original bytes and digest tampering fail verification", () => {
  const sealed = renderExecutionArtifact({ scope, finding, snapshot: existingFileSnapshot });
  const bytesChanged = structuredClone(sealed.artifact);
  bytesChanged.originalContentBase64 = Buffer.from("different original\n").toString("base64");
  assert.equal(verifyExecutionArtifact(bytesChanged, sealed.artifactHash), false);
  assert.throws(() => sealExecutionArtifact(bytesChanged), /invalid|integrity/i);
  const digestChanged = structuredClone(sealed.artifact);
  digestChanged.originalContentSha256 = "0".repeat(64);
  assert.equal(verifyExecutionArtifact(digestChanged, sealed.artifactHash), false);
  assert.throws(() => sealExecutionArtifact(digestChanged), /invalid|integrity/i);
  const blobChanged = structuredClone(sealed.artifact);
  blobChanged.originalBlobSha = "0".repeat(40);
  assert.equal(verifyExecutionArtifact(blobChanged, sealed.artifactHash), false);
});

test("original evidence rejects path, commit, repository, mode, type, encoding, and size mismatches", () => {
  const sealed = renderExecutionArtifact({ scope, finding, snapshot: existingFileSnapshot });
  for (const mutation of [
    (value: typeof existingFileSnapshot) => { value.filePath = "config/other.yaml"; },
    (value: typeof existingFileSnapshot) => { value.baseCommitSha = "not-a-commit-sha"; },
    (value: typeof existingFileSnapshot) => { value.immutableRepositoryId = "987654321012346"; },
    (value: typeof existingFileSnapshot) => { value.file.mode = "100755" as never; },
    (value: typeof existingFileSnapshot) => { value.file.fileType = "tree" as never; },
    (value: typeof existingFileSnapshot) => { value.file.contentBase64 = "%%%"; },
    (value: typeof existingFileSnapshot) => {
      const bytes = Buffer.alloc(EXECUTION_ARTIFACT_ORIGINAL_FILE_MAX_BYTES + 1, 0x61);
      value.file.content = bytes.toString("utf8");
      value.file.contentBase64 = bytes.toString("base64");
      value.file.blobSha = gitBlobSha(bytes);
    }
  ]) {
    const changed = structuredClone(existingFileSnapshot);
    mutation(changed);
    assert.throws(() => renderExecutionArtifact({ scope, finding, snapshot: changed }));
  }
  assert.equal(verifyExecutionArtifact(sealed.artifact, sealed.artifactHash), true);
});

test("tampered or malformed artifacts fail integrity validation", () => {
  const sealed = makeArtifact();
  for (const path of ["../outside.yaml", "config//metrics.yaml", "config/./metrics.yaml"]) {
    const tampered = structuredClone(sealed.artifact);
    tampered.filePath = path;
    assert.equal(verifyExecutionArtifact(tampered, sealed.artifactHash), false);
  }
  assert.equal(verifyExecutionArtifact(null, sealed.artifactHash), false);
  assert.equal(verifyExecutionArtifact(sealed.artifact, "0".repeat(64)), false);
});

test("future execution gate rejects unapproved artifacts and all bound-context drift", () => {
  const sealed = makeArtifact();
  const base = {
    artifact: sealed.artifact, artifactHash: sealed.artifactHash, approvedArtifactHash: sealed.artifactHash,
    approvalState: "approved", planHash: scope.planHash, repositoryBindingId: scope.repositoryBindingId,
    githubRepositoryId: scope.githubRepositoryId, installationRecordId: scope.installationRecordId,
    currentBaseCommitSha: snapshot.baseCommitSha, currentRenderedContent: sealed.artifact.renderedContent
  };
  assert.equal(validateApprovedArtifactForExecution(base), true);
  for (const change of [
    { approvalState: "pending" }, { approvedArtifactHash: "0".repeat(64) },
    { currentBaseCommitSha: "c".repeat(40) }, { repositoryBindingId: "other" },
    { githubRepositoryId: "123" }, { installationRecordId: "other" },
    { planHash: "0".repeat(64) }, { currentRenderedContent: "different" }
  ]) assert.equal(validateApprovedArtifactForExecution({ ...base, ...change }), false);
});

test("artifact creation rejects an unexpected immutable repository or non-regular file", () => {
  assert.throws(() => renderExecutionArtifact({
    scope, finding, snapshot: { ...snapshot, immutableRepositoryId: "wrong" }
  }));
  assert.throws(() => renderExecutionArtifact({
    scope, finding, snapshot: { ...snapshot, file: { ...snapshot.file, isRegularFile: false } }
  }));
});
