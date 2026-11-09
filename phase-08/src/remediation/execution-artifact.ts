import { createHash } from "node:crypto";
import { planRemediation, type FindingSummary } from "../../../phase-07/src/remediation/planner.js";

export const EXECUTION_ARTIFACT_SCHEMA_VERSION = 2 as const;
export const EXECUTION_ARTIFACT_MAX_BYTES = 2_097_152;
export const EXECUTION_ARTIFACT_ORIGINAL_FILE_MAX_BYTES = 512 * 1024;
export const REMEDIATION_PLANNER_VERSION = "phase07-planner-v1" as const;

export interface RepositoryFileSnapshot {
  content: string | null;
  contentBase64: string | null;
  blobSha: string | null;
  mode: "100644" | null;
  fileType: "blob" | null;
  isRegularFile: boolean;
}
export interface TrustedRepositorySnapshot {
  immutableRepositoryId: string;
  baseRef: string;
  baseCommitSha: string;
  filePath: string;
  file: RepositoryFileSnapshot;
}
export interface RemediationExecutionArtifact {
  schemaVersion: typeof EXECUTION_ARTIFACT_SCHEMA_VERSION;
  proposalId: string;
  tenantId: string;
  organizationId: string;
  projectId: string;
  repositoryBindingId: string;
  githubRepositoryId: string;
  installationRecordId: string;
  baseRef: string;
  baseCommitSha: string;
  planHash: string;
  plannerVersion: typeof REMEDIATION_PLANNER_VERSION;
  filePath: string;
  operation: "create" | "update";
  originalBlobSha: string | null;
  originalContentSha256: string | null;
  originalContentBase64: string | null;
  originalMode: "100644" | null;
  originalFileType: "blob" | null;
  renderedMode: "100644";
  renderedContent: string;
  renderedContentSha256: string;
  canonicalPatchHash: string;
  createdAt: string;
}
export interface SealedExecutionArtifact {
  artifact: RemediationExecutionArtifact;
  artifactHash: string;
}
export interface ArtifactScope {
  proposalId: string;
  tenantId: string;
  organizationId: string;
  projectId: string;
  repositoryBindingId: string;
  githubRepositoryId: string;
  installationRecordId: string;
  planHash: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function gitBlobSha(value: Uint8Array): string {
  return createHash("sha1").update(`blob ${value.byteLength}\0`, "utf8").update(value).digest("hex");
}
function decodeOriginalBase64(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length > Math.ceil(EXECUTION_ARTIFACT_ORIGINAL_FILE_MAX_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > EXECUTION_ARTIFACT_ORIGINAL_FILE_MAX_BYTES || bytes.toString("base64") !== value) return null;
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return null; }
  return bytes;
}
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + stableJson(record[key])).join(",") + "}";
}
function safePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 256 ||
      !/^[A-Za-z0-9_./-]+$/.test(path) || path.startsWith("/")) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
function validSha(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}
function exactArtifact(value: unknown): value is RemediationExecutionArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const a = value as Record<string, unknown>;
  const fields = ["schemaVersion", "proposalId", "tenantId", "organizationId", "projectId", "repositoryBindingId",
    "githubRepositoryId", "installationRecordId", "baseRef", "baseCommitSha", "planHash", "plannerVersion",
    "filePath", "operation", "originalBlobSha", "originalContentSha256", "originalContentBase64", "originalMode", "originalFileType", "renderedMode",
    "renderedContent", "renderedContentSha256", "canonicalPatchHash", "createdAt"];
  if (Object.keys(a).length !== fields.length || fields.some((field) => !Object.hasOwn(a, field))) return false;
  if (a.schemaVersion !== EXECUTION_ARTIFACT_SCHEMA_VERSION || a.plannerVersion !== REMEDIATION_PLANNER_VERSION) return false;
  for (const field of ["proposalId", "tenantId", "organizationId", "projectId", "repositoryBindingId", "installationRecordId", "baseRef", "createdAt"])
    if (typeof a[field] !== "string" || !(a[field] as string).length) return false;
  if ((a.baseRef as string).length > 256 || /[\u0000-\u001f\u007f]/.test(a.baseRef as string)) return false;
  if (typeof a.githubRepositoryId !== "string" || !/^[1-9]\d*$/.test(a.githubRepositoryId)) return false;
  if (!validSha(a.baseCommitSha) || typeof a.planHash !== "string" || !/^[0-9a-f]{64}$/.test(a.planHash)) return false;
  if (!safePath(a.filePath) || (a.operation !== "create" && a.operation !== "update")) return false;
  if (a.operation === "create" && (a.originalBlobSha !== null || a.originalContentSha256 !== null ||
      a.originalContentBase64 !== null || a.originalMode !== null || a.originalFileType !== null)) return false;
  if (a.operation === "update") {
    const originalBytes = decodeOriginalBase64(a.originalContentBase64);
    if (!validSha(a.originalBlobSha) || typeof a.originalContentSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(a.originalContentSha256) || a.originalMode !== "100644" ||
        a.originalFileType !== "blob" || !originalBytes || sha256Bytes(originalBytes) !== a.originalContentSha256 ||
        gitBlobSha(originalBytes) !== a.originalBlobSha) return false;
  }
  if (a.renderedMode !== "100644" || typeof a.renderedContent !== "string" ||
      Buffer.byteLength(a.renderedContent, "utf8") > EXECUTION_ARTIFACT_MAX_BYTES) return false;
  if (typeof a.renderedContentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.renderedContentSha256) ||
      typeof a.canonicalPatchHash !== "string" || !/^[0-9a-f]{64}$/.test(a.canonicalPatchHash)) return false;
  const date = new Date(a.createdAt as string);
  return Number.isFinite(date.getTime()) && date.toISOString() === a.createdAt;
}

export function sealExecutionArtifact(artifact: RemediationExecutionArtifact): SealedExecutionArtifact {
  if (!exactArtifact(artifact)) throw new Error("Execution artifact is invalid.");
  const patch = stableJson({
    githubRepositoryId: artifact.githubRepositoryId, baseCommitSha: artifact.baseCommitSha,
    filePath: artifact.filePath, operation: artifact.operation, originalBlobSha: artifact.originalBlobSha,
    originalContentSha256: artifact.originalContentSha256, originalContentBase64: artifact.originalContentBase64,
    originalMode: artifact.originalMode, originalFileType: artifact.originalFileType,
    renderedMode: artifact.renderedMode, renderedContent: artifact.renderedContent
  });
  if (sha256(patch) !== artifact.canonicalPatchHash || sha256(artifact.renderedContent) !== artifact.renderedContentSha256)
    throw new Error("Execution artifact integrity validation failed.");
  if (Buffer.byteLength(stableJson(artifact), "utf8") > EXECUTION_ARTIFACT_MAX_BYTES)
    throw new Error("Execution artifact exceeds the supported size.");
  return { artifact: structuredClone(artifact), artifactHash: sha256(stableJson(artifact)) };
}
export function verifyExecutionArtifact(value: unknown, expectedHash: unknown, scope?: ArtifactScope): value is RemediationExecutionArtifact {
  try {
    if (typeof expectedHash !== "string" || !/^[0-9a-f]{64}$/.test(expectedHash) || !exactArtifact(value)) return false;
    if (sealExecutionArtifact(value).artifactHash !== expectedHash) return false;
    return !scope || (value.proposalId === scope.proposalId && value.tenantId === scope.tenantId &&
      value.organizationId === scope.organizationId && value.projectId === scope.projectId &&
      value.repositoryBindingId === scope.repositoryBindingId && value.githubRepositoryId === scope.githubRepositoryId &&
      value.installationRecordId === scope.installationRecordId && value.planHash === scope.planHash);
  } catch { return false; }
}
export function renderExecutionArtifact(input: {
  scope: ArtifactScope; finding: FindingSummary; snapshot: TrustedRepositorySnapshot; createdAt?: Date;
}): SealedExecutionArtifact {
  const { scope, snapshot } = input;
  const patch = planRemediation(input.finding);
  if (snapshot.immutableRepositoryId !== scope.githubRepositoryId || !validSha(snapshot.baseCommitSha) ||
      !snapshot.baseRef || snapshot.baseRef.length > 256 || /[\u0000-\u001f\u007f]/.test(snapshot.baseRef) ||
      !safePath(snapshot.filePath) || snapshot.filePath !== patch.filePath ||
      !snapshot.file || snapshot.file.isRegularFile !== true)
    throw new Error("Trusted repository snapshot is invalid.");
  if (!safePath(patch.filePath)) throw new Error("Execution artifact file path is invalid.");
  let originalBytes: Uint8Array | null = null;
  let originalContentBase64: string | null = null;
  let originalContentSha256: string | null = null;
  let originalFileType: "blob" | null = null;
  if (snapshot.file.content === null) {
    if (snapshot.file.contentBase64 !== null || snapshot.file.blobSha !== null || snapshot.file.mode !== null || snapshot.file.fileType !== null)
      throw new Error("Missing repository file metadata is inconsistent.");
  } else {
    if (typeof snapshot.file.content !== "string" || typeof snapshot.file.contentBase64 !== "string" ||
        snapshot.file.mode !== "100644" || snapshot.file.fileType !== "blob" || !validSha(snapshot.file.blobSha))
      throw new Error("Trusted original file metadata is invalid.");
    const decodedOriginalBytes = decodeOriginalBase64(snapshot.file.contentBase64);
    if (!decodedOriginalBytes) throw new Error("Trusted original file bytes are invalid.");
    originalBytes = decodedOriginalBytes;
    let decodedContent: string;
    try { decodedContent = new TextDecoder("utf-8", { fatal: true }).decode(originalBytes); }
    catch { throw new Error("Trusted original file encoding is invalid."); }
    if (decodedContent !== snapshot.file.content || gitBlobSha(originalBytes) !== snapshot.file.blobSha)
      throw new Error("Trusted original file digest is invalid.");
    originalContentBase64 = snapshot.file.contentBase64;
    originalContentSha256 = sha256Bytes(originalBytes);
    originalFileType = "blob";
  }
  const before = snapshot.file.content ?? patch.initialFileContent;
  if (typeof before !== "string") throw new Error("A trusted initial file template is required.");
  const renderedContent = patch.applyPatch(before);
  const operation = snapshot.file.content === null ? "create" : "update";
  const canonicalPatchHash = sha256(stableJson({
    githubRepositoryId: scope.githubRepositoryId, baseCommitSha: snapshot.baseCommitSha,
    filePath: patch.filePath, operation, originalBlobSha: snapshot.file.blobSha,
    originalContentSha256, originalContentBase64, originalMode: snapshot.file.mode,
    originalFileType, renderedMode: "100644", renderedContent
  }));
  const artifact: RemediationExecutionArtifact = {
    schemaVersion: EXECUTION_ARTIFACT_SCHEMA_VERSION,
    proposalId: scope.proposalId, tenantId: scope.tenantId, organizationId: scope.organizationId,
    projectId: scope.projectId, repositoryBindingId: scope.repositoryBindingId,
    githubRepositoryId: scope.githubRepositoryId, installationRecordId: scope.installationRecordId,
    baseRef: snapshot.baseRef, baseCommitSha: snapshot.baseCommitSha, planHash: scope.planHash,
    plannerVersion: REMEDIATION_PLANNER_VERSION, filePath: patch.filePath, operation,
    originalBlobSha: snapshot.file.blobSha, originalContentSha256, originalContentBase64,
    originalMode: snapshot.file.mode, originalFileType,
    renderedMode: "100644", renderedContent, renderedContentSha256: sha256(renderedContent),
    canonicalPatchHash, createdAt: (input.createdAt ?? new Date()).toISOString()
  };
  return sealExecutionArtifact(artifact);
}
export function executionArtifactMetadata(artifact: RemediationExecutionArtifact, artifactHash: string): Record<string, unknown> {
  return {
    schemaVersion: artifact.schemaVersion, artifactHash, planHash: artifact.planHash,
    repositoryBindingId: artifact.repositoryBindingId, githubRepositoryId: artifact.githubRepositoryId,
    installationRecordId: artifact.installationRecordId, baseRef: artifact.baseRef,
    baseCommitSha: artifact.baseCommitSha, plannerVersion: artifact.plannerVersion,
    filePath: artifact.filePath, operation: artifact.operation, renderedMode: artifact.renderedMode,
    originalBlobSha: artifact.originalBlobSha, originalContentSha256: artifact.originalContentSha256,
    originalMode: artifact.originalMode, originalFileType: artifact.originalFileType,
    renderedContentSha256: artifact.renderedContentSha256, canonicalPatchHash: artifact.canonicalPatchHash,
    createdAt: artifact.createdAt
  };
}

/** Future worker gate. This is a pure contract and is not wired to any worker in this stage. */
export function validateApprovedArtifactForExecution(input: {
  artifact: unknown;
  artifactHash: unknown;
  approvedArtifactHash: unknown;
  approvalState: string;
  planHash: string;
  repositoryBindingId: string;
  githubRepositoryId: string;
  installationRecordId: string;
  currentBaseCommitSha: string;
  currentRenderedContent: string;
}): boolean {
  if (input.approvalState !== "approved" || typeof input.artifactHash !== "string" ||
      input.approvedArtifactHash !== input.artifactHash ||
      !verifyExecutionArtifact(input.artifact, input.artifactHash)) return false;
  const artifact = input.artifact;
  return artifact.planHash === input.planHash &&
    artifact.repositoryBindingId === input.repositoryBindingId &&
    artifact.githubRepositoryId === input.githubRepositoryId &&
    artifact.installationRecordId === input.installationRecordId &&
    artifact.baseCommitSha === input.currentBaseCommitSha &&
    artifact.renderedContent === input.currentRenderedContent &&
    sha256(input.currentRenderedContent) === artifact.renderedContentSha256;
}
