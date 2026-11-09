import type { Prisma, PrismaClient } from "@prisma/client";
import { hasOrganizationPermission } from "../organizations/permissions.js";
import type { TrustedRepositorySnapshot, RepositoryFileSnapshot } from "../remediation/execution-artifact.js";
import type { TrustedRepositorySnapshotReader, TrustedRepositorySnapshotRequest } from "../remediation/execution-artifact-preparation.js";
import { ContentsReadInstallationTokenService, gitBlobSha } from "./contents-read-token-service.js";

const API = "https://api.github.com";
const HTTP_TIMEOUT_MS = 10_000;
const JSON_BODY_LIMIT = 1024 * 1024;
export const SNAPSHOT_FILE_LIMIT_BYTES = 512 * 1024;
export const SNAPSHOT_TOTAL_LIMIT_BYTES = 512 * 1024;
const ALLOWED_PATHS = new Set([
  "config/observability/metrics.yaml",
  "config/observability/health-checks.yaml",
  "config/observability/alert-rules.yaml"
]);
const SHA = /^[0-9a-f]{40}$/i;
const DECIMAL_ID = /^[1-9]\d{0,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RepositorySnapshotErrorCode = "unauthorized" | "not_found" | "binding_changed" | "invalid_path" |
  "missing_file" | "invalid_github_response" | "too_large" | "timeout" | "network_failure" | "upstream_failure";

export class RepositorySnapshotError extends Error {
  constructor(readonly code: RepositorySnapshotErrorCode) {
    super("A trusted GitHub repository snapshot could not be read.");
    this.name = "RepositorySnapshotError";
  }
}

interface BindingSnapshot {
  repositoryId: string;
  installationRecordId: string;
  installationId: string;
  owner: string;
  name: string;
}

function exactRequest(value: TrustedRepositorySnapshotRequest): boolean {
  return !!value && UUID.test(value.identityUserId) && UUID.test(value.organizationId) && UUID.test(value.projectId) &&
    UUID.test(value.repositoryBindingId) && UUID.test(value.installationRecordId) &&
    typeof value.tenantId === "string" && value.tenantId.length > 0 && value.tenantId.length <= 128 &&
    DECIMAL_ID.test(value.immutableRepositoryId) && ALLOWED_PATHS.has(value.filePath);
}

async function readBody(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new RepositorySnapshotError("invalid_github_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let abortListener!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => reject(new RepositorySnapshotError("timeout"));
    if (signal.aborted) abortListener();
    else signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    for (;;) {
      const item = await Promise.race([reader.read(), aborted]);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => undefined);
        throw new RepositorySnapshotError("too_large");
      }
      chunks.push(item.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof RepositorySnapshotError) throw error;
    throw new RepositorySnapshotError(signal.aborted ? "timeout" : "network_failure");
  } finally { signal.removeEventListener("abort", abortListener); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function safeUrlPart(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Persistence-backed, read-only GitHub snapshot provider. Every request is
 * authorized from current DB state; callers cannot supply URLs or file paths
 * outside the planner allowlist.
 */
export class GitHubTrustedRepositorySnapshotReader implements TrustedRepositorySnapshotReader {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly tokens: ContentsReadInstallationTokenService,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = HTTP_TIMEOUT_MS
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("Repository snapshot timeout is invalid.");
  }

  async readSnapshot(request: TrustedRepositorySnapshotRequest): Promise<TrustedRepositorySnapshot> {
    if (!exactRequest(request)) throw new RepositorySnapshotError("invalid_path");
    const first = await this.authorize(request);
    const token = await this.tokens.token(first.installationId, first.repositoryId);

    const repository = await this.getJson(`/repositories/${first.repositoryId}`, token, first.installationId);
    const repo = asRecord(repository);
    const repoId = repo ? githubId(repo.id) : null;
    const ownerRecord = repo ? asRecord(repo.owner) : null;
    const owner = ownerRecord && typeof ownerRecord.login === "string" ? ownerRecord.login : null;
    const name = repo && typeof repo.name === "string" ? repo.name : null;
    const defaultBranch = repo && typeof repo.default_branch === "string" ? repo.default_branch : null;
    if (repoId !== first.repositoryId || owner !== first.owner || name !== first.name || !defaultBranch ||
        defaultBranch.length > 256 || /[\u0000-\u001f\u007f]/.test(defaultBranch) || repo?.archived === true || repo?.disabled === true) {
      throw new RepositorySnapshotError("binding_changed");
    }

    const commitValue = await this.getJson(`/repos/${safeUrlPart(first.owner)}/${safeUrlPart(first.name)}/commits/${safeUrlPart(defaultBranch)}`, token, first.installationId);
    const commit = asRecord(commitValue);
    const commitSha = commit ? githubSha(commit.sha) : null;
    const commitData = commit ? asRecord(commit.commit) : null;
    const treeData = commitData ? asRecord(commitData.tree) : null;
    const rootTreeSha = treeData ? githubSha(treeData.sha) : null;
    if (!commitSha || !rootTreeSha) throw new RepositorySnapshotError("invalid_github_response");

    // The REST commit route uses owner/name. Recheck the immutable-ID lookup
    // after resolution so a concurrent repository transfer/rename fails closed.
    const repositoryAfterCommit = asRecord(await this.getJson(`/repositories/${first.repositoryId}`, token, first.installationId));
    const ownerAfterCommit = asRecord(repositoryAfterCommit?.owner);
    if (!repositoryAfterCommit || githubId(repositoryAfterCommit.id) !== first.repositoryId ||
        ownerAfterCommit?.login !== first.owner || repositoryAfterCommit.name !== first.name ||
        repositoryAfterCommit.default_branch !== defaultBranch)
      throw new RepositorySnapshotError("binding_changed");

    // Revalidate membership, project/adoption, binding and installation immediately
    // before traversing the pinned Git tree and again before reading its blob.
    const beforeTree = await this.authorize(request);
    assertSameBinding(first, beforeTree);
    const pathParts = request.filePath.split("/");
    let treeSha = rootTreeSha;
    let fileEntry: { sha: string; mode: string } | null = null;
    let fileAbsent = false;
    for (let index = 0; index < pathParts.length; index++) {
      const treeValue = await this.getJson(`/repos/${safeUrlPart(first.owner)}/${safeUrlPart(first.name)}/git/trees/${treeSha}`, token, first.installationId);
      const treeObject = asRecord(treeValue);
      if (!treeObject || !Array.isArray(treeObject.tree)) throw new RepositorySnapshotError("invalid_github_response");
      const matchingEntries = treeObject.tree.map(asRecord).filter((item) => item?.path === pathParts[index]);
      if (matchingEntries.length === 0) { fileAbsent = true; break; }
      if (matchingEntries.length !== 1) throw new RepositorySnapshotError("invalid_github_response");
      const entry = matchingEntries[0]!;
      const sha = githubSha(entry.sha);
      if (!sha) throw new RepositorySnapshotError("invalid_github_response");
      if (index < pathParts.length - 1) {
        if (entry.type !== "tree" || (entry.mode !== "040000" && entry.mode !== "40000"))
          throw new RepositorySnapshotError("invalid_github_response");
        treeSha = sha;
      } else {
        if (entry.type !== "blob" || entry.mode !== "100644") throw new RepositorySnapshotError("invalid_github_response");
        fileEntry = { sha, mode: entry.mode };
      }
    }
    const beforeBlob = await this.authorize(request);
    assertSameBinding(first, beforeBlob);
    let file: RepositoryFileSnapshot;
    if (fileAbsent && !fileEntry) {
      file = { content: null, contentBase64: null, blobSha: null, mode: null, fileType: null, isRegularFile: true };
    } else {
      if (!fileEntry) throw new RepositorySnapshotError("invalid_github_response");
      const blobValue = await this.getJson(`/repos/${safeUrlPart(first.owner)}/${safeUrlPart(first.name)}/git/blobs/${fileEntry.sha}`, token, first.installationId);
      const blob = asRecord(blobValue);
      if (!blob || githubSha(blob.sha) !== fileEntry.sha || blob.encoding !== "base64" || typeof blob.content !== "string" ||
          !Number.isSafeInteger(blob.size) || (blob.size as number) < 0 || (blob.size as number) > SNAPSHOT_FILE_LIMIT_BYTES ||
          (blob.size as number) > SNAPSHOT_TOTAL_LIMIT_BYTES) throw new RepositorySnapshotError("too_large");
      const compactBase64 = blob.content.replace(/[\r\n\t ]/g, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compactBase64))
        throw new RepositorySnapshotError("invalid_github_response");
      const contentBytes = Buffer.from(compactBase64, "base64");
      if (contentBytes.toString("base64") !== compactBase64 || contentBytes.byteLength !== blob.size ||
          contentBytes.byteLength > SNAPSHOT_FILE_LIMIT_BYTES || gitBlobSha(contentBytes) !== fileEntry.sha)
        throw new RepositorySnapshotError("invalid_github_response");
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(contentBytes); }
      catch { throw new RepositorySnapshotError("invalid_github_response"); }
      file = {
        content, contentBase64: compactBase64, blobSha: fileEntry.sha,
        mode: "100644", fileType: "blob", isRegularFile: true
      };
    }
    // Resolve the mutable branch once more after reading the immutable tree/blob.
    // This proves the head had not advanced during snapshot acquisition. A later
    // race remains possible and must be closed by a future conditional GitHub write.
    const finalCommitValue = await this.getJson(
      `/repos/${safeUrlPart(first.owner)}/${safeUrlPart(first.name)}/commits/${safeUrlPart(defaultBranch)}`,
      token, first.installationId
    );
    const finalCommit = asRecord(finalCommitValue);
    if (!finalCommit || githubSha(finalCommit.sha) !== commitSha) throw new RepositorySnapshotError("binding_changed");
    const finalAuthorization = await this.authorize(request);
    assertSameBinding(first, finalAuthorization);
    return Object.freeze({
      immutableRepositoryId: first.repositoryId,
      baseRef: defaultBranch,
      baseCommitSha: commitSha,
      filePath: request.filePath,
      file: Object.freeze(file)
    });
  }

  private async authorize(request: TrustedRepositorySnapshotRequest): Promise<BindingSnapshot> {
    return this.prisma.$transaction(async (tx) => {
      const member = await tx.organizationMember.findFirst({
        where: {
          organizationId: request.organizationId, userId: request.identityUserId, status: "active",
          user: { is: { status: "active" } }, organization: { is: { status: "active" } }
        }, select: { role: true }
      });
      if (!member || !hasOrganizationPermission(member.role, "organization:integrations"))
        throw new RepositorySnapshotError("unauthorized");
      const project = await tx.project.findFirst({
        where: { id: request.projectId, tenantId: request.tenantId, organizationId: request.organizationId },
        select: { id: true }
      });
      if (!project) throw new RepositorySnapshotError("not_found");
      const adoption = await tx.projectOrganizationAdoption.findFirst({
        where: { tenantId: request.tenantId, organizationId: request.organizationId, projectId: request.projectId, status: "approved" },
        select: { id: true }
      });
      if (!adoption) throw new RepositorySnapshotError("not_found");
      const binding = await tx.projectGitHubRepository.findFirst({
        where: {
          id: request.repositoryBindingId, tenantId: request.tenantId, organizationId: request.organizationId,
          projectId: request.projectId, installationRecordId: request.installationRecordId, status: "active",
          installation: { is: { organizationId: request.organizationId, status: "active", organization: { is: { status: "active" } } } }
        },
        select: {
          id: true, githubRepositoryId: true, installationRecordId: true, ownerLogin: true, repositoryName: true,
          installation: { select: { id: true, githubInstallationId: true, organizationId: true, status: true } }
        }
      });
      if (!binding || binding.installation.status !== "active" || binding.installation.organizationId !== request.organizationId)
        throw new RepositorySnapshotError("not_found");
      const result: BindingSnapshot = {
        repositoryId: binding.githubRepositoryId.toString(),
        installationRecordId: binding.installationRecordId,
        installationId: binding.installation.githubInstallationId.toString(),
        owner: binding.ownerLogin,
        name: binding.repositoryName
      };
      if (result.repositoryId !== request.immutableRepositoryId || result.installationRecordId !== request.installationRecordId)
        throw new RepositorySnapshotError("binding_changed");
      return result;
    }, { isolationLevel: "Serializable" });
  }

  private async getJson(path: string, token: string, installationId: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetcher(`${API}${path}`, {
          method: "GET", redirect: "error", signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
        });
      } catch { throw new RepositorySnapshotError(controller.signal.aborted ? "timeout" : "network_failure"); }
      if (!response.ok) {
        try { void response.body?.cancel().catch(() => undefined); } catch { /* do not consume error bodies */ }
        if (response.status === 401) this.tokens.invalidate(installationId);
        throw new RepositorySnapshotError(response.status === 404 ? "missing_file" : response.status === 401 || response.status === 403 ? "unauthorized" : "upstream_failure");
      }
      const bytes = await readBody(response, JSON_BODY_LIMIT, controller.signal);
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new RepositorySnapshotError("invalid_github_response"); }
    } finally { clearTimeout(timeout); }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function githubSha(value: unknown): string | null { return typeof value === "string" && SHA.test(value) ? value.toLowerCase() : null; }
function githubId(value: unknown): string | null {
  if (typeof value === "string" && DECIMAL_ID.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}
function assertSameBinding(a: BindingSnapshot, b: BindingSnapshot): void {
  if (a.repositoryId !== b.repositoryId || a.installationId !== b.installationId ||
      a.installationRecordId !== b.installationRecordId || a.owner !== b.owner || a.name !== b.name)
    throw new RepositorySnapshotError("binding_changed");
}
