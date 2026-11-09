import { createHash } from "node:crypto";
import {
  GITHUB_APP_INSTALLATION_PERMISSIONS,
  GITHUB_ARTIFACT_WRITER_PERMISSIONS,
  GITHUB_DRAFT_PR_PERMISSIONS,
  type GitHubInstallationPermissions,
  type GitHubInstallationToken
} from "./app-token-service.js";
import { extractJsonIntegerToken } from "./exact-json-integer.js";

const API_ORIGIN = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TREE_ENTRIES = 10_000;
const MAX_WRITE_TREE_ENTRIES = 3;
const GIT_SHA = /^[0-9a-f]{40}$/i;
const DECIMAL_ID = /^[1-9]\d{0,18}$/;
const ALLOWED_ARTIFACT_PATHS = new Set([
  "config/observability/metrics.yaml",
  "config/observability/health-checks.yaml",
  "config/observability/alert-rules.yaml"
]);
const SAFE_OWNER = /^[A-Za-z0-9_-]{1,100}$/;
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;
const SAFE_BRANCH = /^[A-Za-z0-9_.\/-]{1,250}$/;
export const ARTIFACT_COMMIT_MESSAGE = "CloudPilot: apply approved observability remediation";

export type GitHubMutationStage = "blob" | "tree" | "commit" | "branch" | "pull_request" | "pull_request_close";
export interface GitHubMutationCorrelation {
  readonly executionId: string;
  readonly attempt: number;
  readonly operationKey: string;
  readonly stage: GitHubMutationStage;
  readonly requestHash: string;
  /** Fingerprint committed with the intent: method + target + exact serialized body hash. */
  readonly requestFingerprint: string;
}

export interface GitHubMutationRejectionEvidence extends GitHubMutationCorrelation {
  readonly rejection: "primary_rate_limit" | "secondary_rate_limit";
  readonly retryAfterMs?: number;
}

export type ArtifactGitHubClientErrorCode =
  | "invalid_input"
  | "invalid_token"
  | "not_found"
  | "conflict"
  | "repository_unavailable"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "upstream_failure"
  | "network_failure"
  | "timeout"
  | "aborted"
  | "response_too_large"
  | "invalid_response";

/** Errors contain fixed messages only; upstream bodies and credentials are discarded. */
export class ArtifactGitHubClientError extends Error {
  constructor(
    readonly code: ArtifactGitHubClientErrorCode,
    readonly retryAfterMs?: number,
    readonly rejectionEvidence?: GitHubMutationRejectionEvidence
  ) {
    super(messageFor(code));
    this.name = "ArtifactGitHubClientError";
  }
}

function messageFor(code: ArtifactGitHubClientErrorCode): string {
  switch (code) {
    case "invalid_input": return "The GitHub artifact request is invalid.";
    case "invalid_token": return "A valid repository-scoped GitHub token is required.";
    case "not_found": return "The GitHub resource was not found or is inaccessible.";
    case "conflict": return "The GitHub resource conflicts with the requested immutable state.";
    case "repository_unavailable": return "The bound GitHub repository is unavailable for writes.";
    case "unauthorized": return "GitHub rejected the repository token.";
    case "forbidden": return "The GitHub App installation lacks access or permission.";
    case "rate_limited": return "GitHub rate limited the repository request.";
    case "upstream_failure": return "The GitHub repository request failed.";
    case "network_failure": return "The GitHub repository request could not be completed.";
    case "timeout": return "The GitHub repository request timed out.";
    case "aborted": return "The GitHub repository request was cancelled.";
    case "response_too_large": return "GitHub returned a response larger than allowed.";
    case "invalid_response": return "GitHub returned an invalid repository response.";
  }
}

export const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;

export interface ArtifactGitHubClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  /** Additional fail-closed guard run before every upstream request. */
  beforeRequest?: () => Promise<void>;
  maxRetryAfterMs?: number;
}

export interface GitHubRepositoryIdentity {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
}

export interface GitHubReference {
  readonly name: string;
  readonly sha: string;
}

export interface GitHubCommit {
  readonly sha: string;
  readonly treeSha: string;
  readonly parentShas: readonly string[];
}

export type GitHubTreeEntryType = "blob" | "tree" | "commit";
export type GitHubTreeEntryMode = "100644" | "100755" | "120000" | "160000" | "040000" | "40000";

export interface GitHubTreeEntry {
  readonly path: string;
  readonly mode: GitHubTreeEntryMode;
  readonly type: GitHubTreeEntryType;
  readonly sha: string;
}

export interface GitHubTree {
  readonly sha: string;
  readonly entries: readonly GitHubTreeEntry[];
  readonly baseCommitSha?: string;
}

export interface GitHubBlob {
  readonly sha: string;
  readonly size: number;
  readonly contentBase64: string;
  /** A fresh byte array is returned on every access. */
  readonly bytes: Uint8Array;
}

export interface GitHubTreeChange {
  readonly path: string;
  readonly mode: "100644";
  readonly blob: GitHubBlob;
}

export interface GitHubPullRequest {
  readonly number: number;
  readonly url: string;
  readonly draft: boolean;
  readonly state: "open" | "closed";
  readonly headRef: string;
  readonly headSha: string;
  readonly headRepositoryId: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly baseRepositoryId: string;
}

export interface DraftPullRequestInput {
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

const resolvedRepositories = new WeakMap<object, { client: object; id: string }>();
const readCommits = new WeakMap<object, { client: object; repositoryId: string; sha: string; treeSha: string }>();
const trees = new WeakMap<object, { client: object; repositoryId: string; sha: string; baseCommitSha?: string }>();
const blobs = new WeakMap<object, { client: object; repositoryId: string; sha: string; size: number }>();
const mutationRequestBindings = new WeakMap<object, string>();
const mutationRejectionEvidenceBrands = new WeakMap<object, GitHubMutationRejectionEvidence>();

export function githubMutationRequestFingerprint(method: "POST" | "PATCH", target: string, serializedBody: string): string {
  const bodyHash = createHash("sha256").update(serializedBody, "utf8").digest("hex");
  return createHash("sha256").update(JSON.stringify([method, target, bodyHash]), "utf8").digest("hex");
}

export function githubMutationTarget(repository: GitHubRepositoryIdentity, suffix: string): string {
  return `${API_ORIGIN}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}${suffix}`;
}

/** Verification capability only; a structurally identical caller object is not trusted. */
export function isTrustedGitHubMutationRejectionEvidence(value: unknown,
  expected: GitHubMutationCorrelation): value is GitHubMutationRejectionEvidence {
  if (!value || typeof value !== "object") return false;
  const branded = mutationRejectionEvidenceBrands.get(value as object);
  return !!branded && branded === value && branded.executionId === expected.executionId &&
    branded.attempt === expected.attempt && branded.operationKey === expected.operationKey &&
    branded.stage === expected.stage && branded.requestHash === expected.requestHash &&
    branded.requestFingerprint === expected.requestFingerprint;
}

interface JsonResponse {
  readonly value: unknown;
  readonly raw: string;
}

/**
 * Narrow GitHub REST client for artifact execution foundations. One instance is
 * bound to the single repository scope of one short-lived installation token.
 * It does not select paths, modes, content, parent commits, or repository URLs.
 */
export class ArtifactOnlyGitHubClient {
  readonly #clientMarker = {};
  readonly #token: string;
  readonly #repositoryId: string;
  readonly #permissions: GitHubInstallationPermissions;
  readonly #expiresAtMs: number;
  readonly #fetchImpl: typeof fetch;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #beforeRequest?: () => Promise<void>;
  readonly #maxRetryAfterMs: number;

  constructor(token: GitHubInstallationToken, options: ArtifactGitHubClientOptions = {}) {
    const validInstallationId = decimalId(token?.installationId);
    const repositoryId = decimalId(token?.repositoryId);
    const tokenValue = token?.token;
    const permissions = token?.permissions;
    const expiresAtValue = token?.expiresAt;
    const expiresAt = typeof expiresAtValue === "string" ? Date.parse(expiresAtValue) : NaN;
    if (!validInstallationId || !repositoryId || !isSupportedPermissionProfile(permissions) ||
        typeof tokenValue !== "string" || !tokenValue.trim() ||
        tokenValue.length > 4096 || /[\u0000-\u001f\u007f]/u.test(tokenValue) || !Number.isFinite(expiresAt)) {
      throw new ArtifactGitHubClientError("invalid_token");
    }
    this.#now = options.now ?? Date.now;
    if (expiresAt <= this.#now()) throw new ArtifactGitHubClientError("invalid_token");
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > MAX_TIMEOUT_MS) {
      throw new ArtifactGitHubClientError("invalid_input");
    }
    this.#maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
    if (!Number.isSafeInteger(this.#maxRetryAfterMs) || this.#maxRetryAfterMs < 0) {
      throw new ArtifactGitHubClientError("invalid_input");
    }
    this.#token = tokenValue;
    this.#repositoryId = repositoryId;
    this.#permissions = Object.freeze({ ...permissions }) as GitHubInstallationPermissions;
    this.#expiresAtMs = expiresAt;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#beforeRequest = options.beforeRequest;
  }

  /** Resolve only the immutable repository ID bound to this token. */
  async resolveRepository(signal?: AbortSignal): Promise<GitHubRepositoryIdentity> {
    const response = await this.requestJson("GET", `/repositories/${this.#repositoryId}`, undefined, signal);
    const value = asRecord(response.value);
    const owner = asRecord(value?.owner);
    const exactId = extractJsonIntegerToken(response.raw, ["id"]);
    const name = value?.name;
    const login = owner?.login;
    const defaultBranch = value?.default_branch;
    if (!value || exactId !== this.#repositoryId || typeof login !== "string" || !SAFE_OWNER.test(login) ||
        typeof name !== "string" || !SAFE_REPOSITORY.test(name) || name === "." || name === ".." || name.endsWith(".git") ||
        typeof defaultBranch !== "string" || !validBranch(defaultBranch) ||
        typeof value.archived !== "boolean" || typeof value.disabled !== "boolean") {
      throw new ArtifactGitHubClientError("invalid_response");
    }
    if (value.archived || value.disabled) throw new ArtifactGitHubClientError("repository_unavailable");
    const result = Object.freeze({ id: exactId, owner: login, name, defaultBranch });
    resolvedRepositories.set(result, { client: this.#clientMarker, id: exactId });
    return result;
  }

  async readReference(repository: GitHubRepositoryIdentity, branch: string, signal?: AbortSignal): Promise<GitHubReference> {
    this.assertRepository(repository);
    this.assertPermission("contents", "read");
    if (!validBranch(branch)) throw new ArtifactGitHubClientError("invalid_input");
    const ref = `heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
    const value = asRecord((await this.requestJson("GET", `${this.repoPath(repository)}/git/ref/${ref}`, undefined, signal)).value);
    const object = asRecord(value?.object);
    const sha = validSha(object?.sha);
    if (value?.ref !== `refs/heads/${branch}` || object?.type !== "commit" || !sha) {
      throw new ArtifactGitHubClientError("invalid_response");
    }
    return Object.freeze({ name: branch, sha });
  }

  /** Creates a ref only with the contents-write artifact-writer token profile. */
  async createBranch(repository: GitHubRepositoryIdentity, branch: string, commitSha: string, correlation: GitHubMutationCorrelation, signal?: AbortSignal): Promise<void> {
    this.assertRepository(repository);
    this.assertPermission("contents", "write");
    if (!validBranch(branch) || !validSha(commitSha)) throw new ArtifactGitHubClientError("invalid_input");
    const value = asRecord((await this.requestJson("POST", `${this.repoPath(repository)}/git/refs`, {
      ref: `refs/heads/${branch}`, sha: commitSha
    }, signal, correlation)).value);
    const object = asRecord(value?.object);
    if (value?.ref !== `refs/heads/${branch}` || object?.type !== "commit" || validSha(object.sha) !== commitSha) {
      throw new ArtifactGitHubClientError("invalid_response");
    }
  }

  async readCommit(repository: GitHubRepositoryIdentity, shaInput: string, signal?: AbortSignal): Promise<GitHubCommit> {
    this.assertRepository(repository);
    this.assertPermission("contents", "read");
    const requestedSha = validSha(shaInput);
    if (!requestedSha) throw new ArtifactGitHubClientError("invalid_input");
    const value = asRecord((await this.requestJson(
      "GET", `${this.repoPath(repository)}/git/commits/${requestedSha}`, undefined, signal
    )).value);
    const returnedSha = validSha(value?.sha);
    const tree = asRecord(value?.tree);
    const treeSha = validSha(tree?.sha);
    if (!value || returnedSha !== requestedSha || !treeSha || !Array.isArray(value.parents)) {
      throw new ArtifactGitHubClientError("invalid_response");
    }
    const parentShas = value.parents.map((parent) => validSha(asRecord(parent)?.sha));
    if (parentShas.some((parent) => !parent)) throw new ArtifactGitHubClientError("invalid_response");
    const result = Object.freeze({ sha: returnedSha, treeSha, parentShas: Object.freeze(parentShas as string[]) });
    readCommits.set(result, { client: this.#clientMarker, repositoryId: repository.id, sha: returnedSha, treeSha });
    return result;
  }

  async readTree(repository: GitHubRepositoryIdentity, shaInput: string, signal?: AbortSignal): Promise<GitHubTree> {
    this.assertRepository(repository);
    this.assertPermission("contents", "read");
    const requestedSha = validSha(shaInput);
    if (!requestedSha) throw new ArtifactGitHubClientError("invalid_input");
    return this.readTreeInternal(repository, requestedSha, signal);
  }

  /** Resolve a file from the tree of the supplied immutable commit, never its moving branch. */
  async resolvePathAtCommit(
    repository: GitHubRepositoryIdentity,
    commitSha: string,
    filePath: string,
    signal?: AbortSignal
  ): Promise<GitHubTreeEntry | null> {
    this.assertRepository(repository);
    this.assertPermission("contents", "read");
    if (!validSha(commitSha) || !ALLOWED_ARTIFACT_PATHS.has(filePath)) throw new ArtifactGitHubClientError("invalid_input");
    const commit = await this.readCommit(repository, commitSha, signal);
    let treeSha = commit.treeSha;
    const segments = filePath.split("/");
    for (let index = 0; index < segments.length; index++) {
      const tree = await this.readTree(repository, treeSha, signal);
      const matches = tree.entries.filter((entry) => entry.path === segments[index]);
      if (matches.length === 0) return null;
      if (matches.length !== 1) throw new ArtifactGitHubClientError("invalid_response");
      const entry = matches[0]!;
      const isLast = index === segments.length - 1;
      if (isLast) {
        if (entry.type !== "blob" || entry.mode !== "100644") throw new ArtifactGitHubClientError("invalid_response");
        return entry;
      }
      if (entry.type !== "tree" || (entry.mode !== "040000" && entry.mode !== "40000")) {
        throw new ArtifactGitHubClientError("invalid_response");
      }
      treeSha = entry.sha;
    }
    return null;
  }

  async readBlob(repository: GitHubRepositoryIdentity, shaInput: string, signal?: AbortSignal): Promise<GitHubBlob> {
    this.assertRepository(repository);
    this.assertPermission("contents", "read");
    const requestedSha = validSha(shaInput);
    if (!requestedSha) throw new ArtifactGitHubClientError("invalid_input");
    const value = asRecord((await this.requestJson(
      "GET", `${this.repoPath(repository)}/git/blobs/${requestedSha}`, undefined, signal
    )).value);
    const returnedSha = validSha(value?.sha);
    const size = value?.size;
    if (!value || returnedSha !== requestedSha || value.encoding !== "base64" || typeof value.content !== "string" ||
        !Number.isSafeInteger(size) || (size as number) < 0 || (size as number) > MAX_FILE_BYTES) {
      throw new ArtifactGitHubClientError("invalid_response");
    }
    const base64 = value.content.replace(/[\r\n\t ]/g, "");
    const bytes = decodeCanonicalBase64(base64);
    if (!bytes || bytes.byteLength !== size || gitBlobSha(bytes) !== returnedSha) {
      throw new ArtifactGitHubClientError("invalid_response");
    }
    return this.makeBlob(repository.id, returnedSha, base64, bytes);
  }

  async createBlob(repository: GitHubRepositoryIdentity, input: Uint8Array, correlation: GitHubMutationCorrelation, signal?: AbortSignal): Promise<GitHubBlob> {
    this.assertRepository(repository);
    this.assertPermission("contents", "write");
    if (!(input instanceof Uint8Array) || input.byteLength > MAX_FILE_BYTES) throw new ArtifactGitHubClientError("invalid_input");
    const bytes = new Uint8Array(input);
    const expectedSha = gitBlobSha(bytes);
    const base64 = Buffer.from(bytes).toString("base64");
    const value = asRecord((await this.requestJson("POST", `${this.repoPath(repository)}/git/blobs`, {
      content: base64,
      encoding: "base64"
    }, signal, correlation)).value);
    const returnedSha = validSha(value?.sha);
    if (returnedSha !== expectedSha) throw new ArtifactGitHubClientError("invalid_response");
    return this.makeBlob(repository.id, returnedSha, base64, bytes);
  }

  /**
   * Creates a tree over the exact tree of a read commit. Entries are restricted
   * to approved configuration paths and regular blobs; mode/type are fixed here.
   */
  async createTree(
    repository: GitHubRepositoryIdentity,
    baseCommit: GitHubCommit,
    changes: readonly GitHubTreeChange[],
    correlation: GitHubMutationCorrelation,
    signal?: AbortSignal
  ): Promise<GitHubTree> {
    this.assertRepository(repository);
    this.assertPermission("contents", "write");
    const base = readCommits.get(baseCommit as object);
    if (!base || base.client !== this.#clientMarker || base.repositoryId !== repository.id ||
        !Array.isArray(changes) || changes.length < 1 || changes.length > MAX_WRITE_TREE_ENTRIES) {
      throw new ArtifactGitHubClientError("invalid_input");
    }
    const suppliedChanges = Array.from(changes);
    const seen = new Set<string>();
    const treeEntries = suppliedChanges.map((change) => {
      if (!change || typeof change !== "object") throw new ArtifactGitHubClientError("invalid_input");
      const path = change.path;
      const blobValue: unknown = change.blob;
      const blob = blobValue && typeof blobValue === "object" ? blobs.get(blobValue) : undefined;
      if (typeof path !== "string" || !ALLOWED_ARTIFACT_PATHS.has(path) || change.mode !== "100644" || seen.has(path) || !blob ||
          blob.client !== this.#clientMarker || blob.repositoryId !== repository.id || blob.sha.length !== 40) {
        throw new ArtifactGitHubClientError("invalid_input");
      }
      seen.add(path);
      return { path, mode: change.mode, type: "blob", sha: blob.sha };
    }).sort((a, b) => a.path.localeCompare(b.path));
    const value = asRecord((await this.requestJson("POST", `${this.repoPath(repository)}/git/trees`, {
      base_tree: base.treeSha,
      tree: treeEntries
    }, signal, correlation)).value);
    const sha = validSha(value?.sha);
    if (!sha) throw new ArtifactGitHubClientError("invalid_response");
    const readBack = await this.readTreeInternal(repository, sha, signal);
    const result = Object.freeze({ sha: readBack.sha, entries: readBack.entries, baseCommitSha: base.sha });
    trees.set(result, { client: this.#clientMarker, repositoryId: repository.id, sha, baseCommitSha: base.sha });
    return result;
  }

  /** Creates a commit with exactly the supplied, read-back tree and its approved base as sole parent. */
  async createCommit(
    repository: GitHubRepositoryIdentity,
    tree: GitHubTree,
    parent: GitHubCommit,
    correlation: GitHubMutationCorrelation,
    signal?: AbortSignal
  ): Promise<GitHubCommit> {
    this.assertRepository(repository);
    this.assertPermission("contents", "write");
    const treeRecord = trees.get(tree as object);
    const parentRecord = readCommits.get(parent as object);
    if (!treeRecord || treeRecord.client !== this.#clientMarker || treeRecord.repositoryId !== repository.id ||
        !parentRecord || parentRecord.client !== this.#clientMarker || parentRecord.repositoryId !== repository.id ||
        treeRecord.baseCommitSha !== parentRecord.sha || parentRecord.treeSha.length !== 40) {
      throw new ArtifactGitHubClientError("invalid_input");
    }
    const value = asRecord((await this.requestJson("POST", `${this.repoPath(repository)}/git/commits`, {
      message: ARTIFACT_COMMIT_MESSAGE,
      tree: treeRecord.sha,
      parents: [parentRecord.sha]
    }, signal, correlation)).value);
    const sha = validSha(value?.sha);
    const responseTree = asRecord(value?.tree);
    const responseParents = value?.parents;
    if (!sha || validSha(responseTree?.sha) !== treeRecord.sha || !Array.isArray(responseParents) ||
        responseParents.length !== 1 || validSha(asRecord(responseParents[0])?.sha) !== parentRecord.sha) {
      throw new ArtifactGitHubClientError("invalid_response");
    }
    const result = Object.freeze({ sha, treeSha: treeRecord.sha, parentShas: Object.freeze([parentRecord.sha]) });
    readCommits.set(result, { client: this.#clientMarker, repositoryId: repository.id, sha, treeSha: treeRecord.sha });
    return result;
  }

  /** One bounded page only; callers fail closed if the page is full. */
  async listPullRequestsForHead(repository: GitHubRepositoryIdentity, headBranch: string, baseBranch: string,
    signal?: AbortSignal): Promise<readonly GitHubPullRequest[]> {
    this.assertRepository(repository);
    this.assertPermission("pull_requests", "write");
    if (!validBranch(headBranch) || !validBranch(baseBranch)) throw new ArtifactGitHubClientError("invalid_input");
    const query = `?head=${encodeURIComponent(`${repository.owner}:${headBranch}`)}&base=${encodeURIComponent(baseBranch)}&state=all&per_page=100`;
    const response = await this.requestJson("GET", `${this.repoPath(repository)}/pulls${query}`, undefined, signal);
    if (!Array.isArray(response.value) || response.value.length > 100 || response.value.length === 100) {
      throw new ArtifactGitHubClientError("invalid_response");
    }
    const prs = response.value.map((value, index) => parsePullRequest(value, response.raw, [index], repository));
    if (prs.some((pr) => !pr)) throw new ArtifactGitHubClientError("invalid_response");
    return Object.freeze(prs as GitHubPullRequest[]);
  }

  async createDraftPullRequest(repository: GitHubRepositoryIdentity, input: DraftPullRequestInput,
    correlation: GitHubMutationCorrelation, signal?: AbortSignal): Promise<GitHubPullRequest> {
    this.assertRepository(repository);
    this.assertPermission("pull_requests", "write");
    if (!validBranch(input?.head) || !validBranch(input?.base) || !validPullRequestText(input?.title, 1, 200) ||
        !validPullRequestText(input?.body, 1, 20_000)) throw new ArtifactGitHubClientError("invalid_input");
    const response = await this.requestJson("POST", `${this.repoPath(repository)}/pulls`, {
      head: input.head, base: input.base, title: input.title, body: input.body, draft: true
    }, signal, correlation);
    const pr = parsePullRequest(response.value, response.raw, [], repository);
    if (!pr) throw new ArtifactGitHubClientError("invalid_response");
    return pr;
  }

  async readPullRequest(repository: GitHubRepositoryIdentity, number: number, signal?: AbortSignal): Promise<GitHubPullRequest> {
    this.assertRepository(repository);
    this.assertPermission("pull_requests", "write");
    if (!Number.isSafeInteger(number) || number < 1) throw new ArtifactGitHubClientError("invalid_input");
    const response = await this.requestJson("GET", `${this.repoPath(repository)}/pulls/${number}`, undefined, signal);
    const pr = parsePullRequest(response.value, response.raw, [], repository);
    if (!pr || pr.number !== number) throw new ArtifactGitHubClientError("invalid_response");
    return pr;
  }

  async closePullRequest(repository: GitHubRepositoryIdentity, number: number, correlation: GitHubMutationCorrelation, signal?: AbortSignal): Promise<GitHubPullRequest> {
    this.assertRepository(repository);
    this.assertPermission("pull_requests", "write");
    if (!Number.isSafeInteger(number) || number < 1) throw new ArtifactGitHubClientError("invalid_input");
    const response = await this.requestJson("PATCH", `${this.repoPath(repository)}/pulls/${number}`, { state: "closed" }, signal, correlation);
    const pr = parsePullRequest(response.value, response.raw, [], repository);
    if (!pr || pr.number !== number) throw new ArtifactGitHubClientError("invalid_response");
    return pr;
  }

  private async readTreeInternal(repository: GitHubRepositoryIdentity, requestedSha: string, signal?: AbortSignal): Promise<GitHubTree> {
    const value = asRecord((await this.requestJson(
      "GET", `${this.repoPath(repository)}/git/trees/${requestedSha}`, undefined, signal
    )).value);
    const sha = validSha(value?.sha);
    if (!value || sha !== requestedSha || value.truncated !== false || !Array.isArray(value.tree) || value.tree.length > MAX_TREE_ENTRIES) {
      throw new ArtifactGitHubClientError("invalid_response");
    }
    const entries = value.tree.map((item) => {
      const entry = asRecord(item);
      const path = entry?.path;
      const mode = entry?.mode;
      const type = entry?.type;
      const entrySha = validSha(entry?.sha);
      if (typeof path !== "string" || path.length < 1 || path.length > 255 || path.includes("/") || path.includes("\\") ||
          path === "." || path === ".." || /[\u0000-\u001f\u007f]/u.test(path) ||
          (mode !== "100644" && mode !== "100755" && mode !== "120000" && mode !== "160000" && mode !== "040000" && mode !== "40000") ||
          (type !== "blob" && type !== "tree" && type !== "commit") || !entrySha || !validModeType(mode, type)) {
        throw new ArtifactGitHubClientError("invalid_response");
      }
      return Object.freeze({ path, mode, type, sha: entrySha }) as GitHubTreeEntry;
    });
    const result = Object.freeze({ sha, entries: Object.freeze(entries) });
    trees.set(result, { client: this.#clientMarker, repositoryId: repository.id, sha });
    return result;
  }

  private makeBlob(repositoryId: string, sha: string, contentBase64: string, sourceBytes: Uint8Array): GitHubBlob {
    const retainedBytes = new Uint8Array(sourceBytes);
    const result = Object.freeze({
      sha,
      size: retainedBytes.byteLength,
      contentBase64,
      get bytes(): Uint8Array { return new Uint8Array(retainedBytes); }
    });
    blobs.set(result, { client: this.#clientMarker, repositoryId, sha, size: retainedBytes.byteLength });
    return result;
  }

  private assertRepository(repository: GitHubRepositoryIdentity): void {
    const record = repository && typeof repository === "object" ? resolvedRepositories.get(repository as object) : undefined;
    if (!record || record.client !== this.#clientMarker || record.id !== this.#repositoryId) {
      throw new ArtifactGitHubClientError("invalid_input");
    }
  }

  private assertPermission(name: "contents" | "pull_requests" | "metadata", level: "read" | "write"): void {
    const granted = (this.#permissions as unknown as Record<string, unknown>)[name];
    if (granted !== level && !(level === "read" && granted === "write")) {
      throw new ArtifactGitHubClientError("invalid_token");
    }
  }

  private repoPath(repository: GitHubRepositoryIdentity): string {
    this.assertRepository(repository);
    return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  }

  private async requestJson(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, externalSignal?: AbortSignal,
    correlation?: GitHubMutationCorrelation): Promise<JsonResponse> {
    if (method === "GET" ? correlation !== undefined : !validMutationCorrelation(correlation)) {
      throw new ArtifactGitHubClientError("invalid_input");
    }
    const controller = new AbortController();
    let abortReason: "timeout" | "aborted" | undefined;
    const onExternalAbort = () => { abortReason = "aborted"; controller.abort(); };
    if (externalSignal?.aborted) onExternalAbort();
    else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    const timer = setTimeout(() => { abortReason = "timeout"; controller.abort(); }, this.#timeoutMs);
    const url = `${API_ORIGIN}${path}`;
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    const requestFingerprint = method === "GET" ? undefined :
      githubMutationRequestFingerprint(method, url, serializedBody ?? "");
    if (correlation) {
      if (correlation.requestFingerprint !== requestFingerprint) throw new ArtifactGitHubClientError("invalid_input");
      const binding = createHash("sha256").update(JSON.stringify([correlation.executionId, correlation.attempt,
        correlation.operationKey, correlation.stage, correlation.requestHash, requestFingerprint])).digest("hex");
      const priorBinding = mutationRequestBindings.get(correlation);
      if (priorBinding && priorBinding !== binding) throw new ArtifactGitHubClientError("invalid_input");
      mutationRequestBindings.set(correlation, binding);
    }
    try {
      if (this.#expiresAtMs <= this.#now()) throw new ArtifactGitHubClientError("invalid_token");
      if (controller.signal.aborted) throw new ArtifactGitHubClientError(abortReason ?? "aborted");
      if (this.#beforeRequest) {
        try { await this.#beforeRequest(); }
        catch { throw new ArtifactGitHubClientError("invalid_token"); }
      }
      if (this.#expiresAtMs <= this.#now()) throw new ArtifactGitHubClientError("invalid_token");
      if (controller.signal.aborted) throw new ArtifactGitHubClientError(abortReason ?? "aborted");
      let response: Response;
      try {
        response = await raceAbort(this.#fetchImpl(url, {
          method,
          redirect: "error",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.#token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(method !== "GET" ? { "Content-Type": "application/json" } : {})
          },
          ...(serializedBody === undefined ? {} : { body: serializedBody })
        }), controller.signal, () => abortReason ?? "aborted");
      } catch (error) {
        if (error instanceof ArtifactGitHubClientError) throw error;
        if (abortReason) throw new ArtifactGitHubClientError(abortReason);
        throw new ArtifactGitHubClientError("network_failure");
      }
      if (!response.ok) {
        if (response.status === 429) {
          const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), this.#now(), this.#maxRetryAfterMs);
          if (!correlation) {
            cancelResponseBody(response);
            throw new ArtifactGitHubClientError("rate_limited", retryAfterMs);
          }
          const completedBody = await readCompletedErrorBody(response, controller.signal, () => abortReason ?? "timeout");
          const evidence = correlation && completedBody
            ? createMutationRejectionEvidence(correlation, "primary_rate_limit", retryAfterMs) : undefined;
          throw new ArtifactGitHubClientError("rate_limited", retryAfterMs, evidence);
        }
        if (response.status === 403) {
          const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), this.#now(), this.#maxRetryAfterMs);
          if (!correlation && retryAfterMs !== undefined) {
            cancelResponseBody(response);
            throw new ArtifactGitHubClientError("rate_limited", retryAfterMs);
          }
          const body = await readRateLimitErrorSnippet(response, controller.signal, () => abortReason ?? "timeout");
          const isSecondaryRateLimit = !!body && isSecondaryRateLimitMessage(body.text);
          if (isSecondaryRateLimit) {
            const evidence = correlation && body?.complete && body.jsonObject
              ? createMutationRejectionEvidence(correlation, "secondary_rate_limit", retryAfterMs) : undefined;
            throw new ArtifactGitHubClientError("rate_limited", retryAfterMs, evidence);
          }
          if (retryAfterMs !== undefined) throw new ArtifactGitHubClientError("rate_limited", retryAfterMs);
          throw new ArtifactGitHubClientError("forbidden");
        }
        cancelResponseBody(response);
        throw statusError(response.status);
      }
      const bytes = await readBoundedBody(response, MAX_RESPONSE_BYTES, controller.signal, () => abortReason ?? "timeout");
      let raw: string;
      let value: unknown;
      try {
        raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        value = JSON.parse(raw);
      } catch {
        throw new ArtifactGitHubClientError("invalid_response");
      }
      return { value, raw };
    } catch (error) {
      if (error instanceof ArtifactGitHubClientError) throw error;
      if (abortReason) throw new ArtifactGitHubClientError(abortReason);
      throw new ArtifactGitHubClientError("network_failure");
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

function decimalId(value: unknown): string | undefined {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) return undefined;
    value = String(value);
  }
  if (typeof value !== "string" || !DECIMAL_ID.test(value)) return undefined;
  try { return BigInt(value) <= 9_223_372_036_854_775_807n ? value : undefined; }
  catch { return undefined; }
}

function validMutationCorrelation(value: GitHubMutationCorrelation | undefined): value is GitHubMutationCorrelation {
  return !!value && typeof value.executionId === "string" && value.executionId.length > 0 &&
    Number.isSafeInteger(value.attempt) && value.attempt > 0 &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(value.operationKey) && /^[a-f0-9]{64}$/.test(value.requestHash) &&
    /^[a-f0-9]{64}$/.test(value.requestFingerprint) &&
    ["blob", "tree", "commit", "branch", "pull_request", "pull_request_close"].includes(value.stage);
}

function validSha(value: unknown): string | undefined {
  return typeof value === "string" && GIT_SHA.test(value) ? value.toLowerCase() : undefined;
}

function validBranch(value: string): boolean {
  return typeof value === "string" && SAFE_BRANCH.test(value) && !value.startsWith("/") &&
    !value.startsWith(".") && !value.startsWith("-") && !value.endsWith("/") && !value.endsWith(".") &&
    !value.endsWith(".lock") && !value.includes("..") && !value.includes("//") && !value.includes("@{") &&
    value.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

function validModeType(mode: string, type: string): boolean {
  return (mode === "040000" || mode === "40000") ? type === "tree" :
    mode === "160000" ? type === "commit" : type === "blob";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`, "utf8").update(bytes).digest("hex");
}

function decodeCanonicalBase64(value: string): Uint8Array | undefined {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? new Uint8Array(bytes) : undefined;
}

function statusError(status: number): ArtifactGitHubClientError {
  if (status === 401) return new ArtifactGitHubClientError("unauthorized");
  if (status === 403) return new ArtifactGitHubClientError("forbidden");
  if (status === 404) return new ArtifactGitHubClientError("not_found");
  if (status === 429) return new ArtifactGitHubClientError("rate_limited");
  if (status === 409 || status === 422) return new ArtifactGitHubClientError("conflict");
  return new ArtifactGitHubClientError(status >= 500 ? "upstream_failure" : "upstream_failure");
}

function isSupportedPermissionProfile(value: unknown): value is GitHubInstallationPermissions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const permissions = value as Record<string, unknown>;
  const same = (expected: object) => Object.keys(permissions).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, level]) => permissions[key] === level);
  return same(GITHUB_APP_INSTALLATION_PERMISSIONS) || same(GITHUB_ARTIFACT_WRITER_PERMISSIONS) ||
    same(GITHUB_DRAFT_PR_PERMISSIONS);
}

function parsePullRequest(value: unknown, raw: string, path: readonly (string | number)[],
  repository: GitHubRepositoryIdentity): GitHubPullRequest | undefined {
  const pr = asRecord(value); const head = asRecord(pr?.head); const base = asRecord(pr?.base);
  const headRepo = asRecord(head?.repo); const baseRepo = asRecord(base?.repo);
  const headRef = head?.ref; const headSha = validSha(head?.sha);
  const baseRef = base?.ref; const baseSha = validSha(base?.sha);
  const number = pr?.number; const url = pr?.html_url; const draft = pr?.draft; const state = pr?.state;
  const headRepositoryId = extractJsonIntegerToken(raw, [...path, "head", "repo", "id"]);
  const baseRepositoryId = extractJsonIntegerToken(raw, [...path, "base", "repo", "id"]);
  if (!Number.isSafeInteger(number) || (number as number) < 1 || typeof url !== "string" ||
      !validGitHubPullRequestUrl(url, repository, number as number) || typeof draft !== "boolean" ||
      (state !== "open" && state !== "closed") || typeof headRef !== "string" || !validBranch(headRef) || !headSha ||
      typeof baseRef !== "string" || !validBranch(baseRef) || !baseSha || !headRepo || !baseRepo ||
      headRepositoryId !== repository.id || baseRepositoryId !== repository.id) return undefined;
  return Object.freeze({ number: number as number, url, draft, state, headRef, headSha, headRepositoryId,
    baseRef, baseSha, baseRepositoryId });
}

function validGitHubPullRequestUrl(value: string, repository: GitHubRepositoryIdentity, number: number): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password &&
      url.port === "" && url.search === "" && url.hash === "" &&
      url.pathname === `/${repository.owner}/${repository.name}/pull/${number}`;
  } catch { return false; }
}

function validPullRequestText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

const SECONDARY_RATE_LIMIT_PATTERN = /secondary rate limit|abuse detection|please wait a few minutes/i;

export function parseRetryAfter(
  value: string | null | undefined,
  nowMs: number,
  maxDelayMs = DEFAULT_MAX_RETRY_AFTER_MS
): number | undefined {
  if (!value || typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  let delayMs: number;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds) || seconds < 0) return undefined;
    delayMs = seconds * 1000;
  } else {
    const timestamp = Date.parse(trimmed);
    if (!Number.isFinite(timestamp)) return undefined;
    delayMs = timestamp - nowMs;
    if (delayMs < 0) return undefined;
  }

  if (!Number.isFinite(delayMs) || delayMs < 0) return undefined;
  const bound = Number.isSafeInteger(maxDelayMs) && maxDelayMs >= 0 ? maxDelayMs : DEFAULT_MAX_RETRY_AFTER_MS;
  return Math.min(Math.floor(delayMs), bound);
}

function isSecondaryRateLimitMessage(text: string): boolean {
  if (!text) return false;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof (parsed as { message?: unknown }).message === "string") {
      return SECONDARY_RATE_LIMIT_PATTERN.test((parsed as { message: string }).message);
    }
  } catch {
    // text is not JSON or was truncated
  }
  return SECONDARY_RATE_LIMIT_PATTERN.test(text);
}

async function readCompletedErrorBody(response: Response, signal: AbortSignal,
  abortCode: () => "timeout" | "aborted"): Promise<{ readonly text: string; readonly value: Record<string, unknown> } | null> {
  try {
    const bytes = await readBoundedBody(response, MAX_RESPONSE_BYTES, signal, abortCode);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return { text, value: parsed as Record<string, unknown> };
  } catch (error) {
    if (error instanceof ArtifactGitHubClientError && (error.code === "timeout" || error.code === "aborted")) throw error;
    cancelResponseBody(response);
    return null;
  }
}

async function readRateLimitErrorSnippet(response: Response, signal: AbortSignal,
  abortCode: () => "timeout" | "aborted"): Promise<{ readonly text: string; readonly complete: boolean; readonly jsonObject: boolean } | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const limit = 2048, chunks: Uint8Array[] = [];
  let total = 0, complete = false, onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ArtifactGitHubClientError(abortCode()));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    while (true) {
      const item = await Promise.race([reader.read(), aborted]);
      if (item.done) { complete = true; break; }
      const take = Math.min(item.value.byteLength, Math.max(0, limit - total));
      if (take > 0) { chunks.push(item.value.subarray(0, take)); total += take; }
      if (take !== item.value.byteLength || total === limit) {
        if (total === limit) {
          const finalItem = await Promise.race([reader.read(), aborted]);
          if (finalItem.done) complete = true;
        }
        break;
      }
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof ArtifactGitHubClientError) throw error;
    return null;
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!complete) void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* cancelled stream */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
  let jsonObject = false;
  if (complete) {
    try { const value: unknown = JSON.parse(text); jsonObject = !!value && typeof value === "object" && !Array.isArray(value); }
    catch { /* malformed bodies can classify an error only, never prove rejection */ }
  }
  return { text, complete, jsonObject };
}

function createMutationRejectionEvidence(correlation: GitHubMutationCorrelation,
  rejection: GitHubMutationRejectionEvidence["rejection"], retryAfterMs?: number): GitHubMutationRejectionEvidence {
  const evidence: GitHubMutationRejectionEvidence = Object.freeze({ ...correlation, rejection,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
  mutationRejectionEvidenceBrands.set(evidence, evidence);
  return evidence;
}

function cancelResponseBody(response: Response): void {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* raw error bodies are discarded */ }
}

async function readBoundedBody(
  response: Response,
  limit: number,
  signal: AbortSignal,
  abortCode: () => "timeout" | "aborted"
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new ArtifactGitHubClientError("invalid_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ArtifactGitHubClientError(abortCode()));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    while (true) {
      const item = await Promise.race([reader.read(), aborted]);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => undefined);
        throw new ArtifactGitHubClientError("response_too_large");
      }
      chunks.push(item.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof ArtifactGitHubClientError) throw error;
    throw new ArtifactGitHubClientError("network_failure");
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* cancelled stream */ }
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, abortCode: () => "timeout" | "aborted"): Promise<T> {
  if (signal.aborted) return Promise.reject(new ArtifactGitHubClientError(abortCode()));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ArtifactGitHubClientError(abortCode()));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); }
    );
  });
}
