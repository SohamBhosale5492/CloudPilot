/**
 * GitHubConnector — minimal GitHub REST API adapter for CloudPilot remediation.
 *
 * Scope: read repo content, create/update sandbox branches, open PRs,
 *        check existing open PRs for idempotency.
 *
 * Security controls:
 *  - Uses a pre-supplied token; never logs or exposes it in errors.
 *  - Validates all owner/repo/branch/path inputs before use.
 *  - Enforces bounded response sizes (1 MB JSON, 2 MB content).
 *  - Enforces a configurable network timeout on every request.
 *  - Never follows redirects to off-GitHub hosts.
 *  - Operates only against the configured GitHub API base URL.
 */

import { URL } from "node:url";

// ── Input validation ─────────────────────────────────────────────────────────

const SAFE_OWNER_RE = /^[a-zA-Z0-9_-]+$/;
const SAFE_REPO_RE  = /^[a-zA-Z0-9_.-]+$/;
const SAFE_BRANCH_RE = /^[a-zA-Z0-9_.\-/]+$/;
const MAX_PATH_LEN = 256;
const MAX_OWNER_REPO_LEN = 100;
const MAX_BRANCH_LEN = 250;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;      // 1 MB for JSON
const MAX_CONTENT_BYTES  = 2 * 1024 * 1024;      // 2 MB for file content
const DEFAULT_TIMEOUT_MS = 10_000;

export class GitHubInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubInputError";
  }
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
    public readonly retryAfter?: string
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export class GitHubConflictError extends GitHubApiError {
  constructor(message: string, body: string) {
    super(message, 422, body);
    this.name = "GitHubConflictError";
  }
}

export class GitHubNotFoundError extends GitHubApiError {
  constructor(message: string, body: string) {
    super(message, 404, body);
    this.name = "GitHubNotFoundError";
  }
}

/**
 * Redacts known secret and token patterns from strings, errors, and response bodies.
 */
export function redactSecrets(text: string): string {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]+/g, "[REDACTED]")
    .replace(/(?:Bearer\s+)[a-zA-Z0-9_.\-]+/gi, "Bearer [REDACTED]")
    .replace(/(?:token\s*[:=]\s*)[^\s"'&,]+/gi, "token=[REDACTED]");
}

export function assertSafeOwner(owner: string): void {
  if (
    !owner ||
    typeof owner !== "string" ||
    owner.length > MAX_OWNER_REPO_LEN ||
    !SAFE_OWNER_RE.test(owner) ||
    owner.startsWith("-") ||
    owner.startsWith(".") ||
    owner.includes("/")
  ) {
    throw new GitHubInputError(
      `Invalid owner name: must be 1–${MAX_OWNER_REPO_LEN} chars, alphanumeric, hyphens, and underscores only (no slashes).`
    );
  }
}

export function assertSafeRepo(repo: string): void {
  if (
    !repo ||
    typeof repo !== "string" ||
    repo.length > MAX_OWNER_REPO_LEN ||
    !SAFE_REPO_RE.test(repo) ||
    repo.includes("/") ||
    repo === "." ||
    repo === ".." ||
    repo.endsWith(".git")
  ) {
    throw new GitHubInputError(
      `Invalid repository name: must be 1–${MAX_OWNER_REPO_LEN} chars, alphanumeric, hyphens, underscores, dots only (no slashes, no .git).`
    );
  }
}

export function assertSafePath(value: string): void {
  if (!value || typeof value !== "string" || value.length > MAX_PATH_LEN) {
    throw new GitHubInputError(`Invalid file path: must be 1–${MAX_PATH_LEN} chars.`);
  }
  if (value.startsWith("/") || value.endsWith("/")) {
    throw new GitHubInputError(`Invalid file path: must not start or end with '/'.`);
  }
  if (value.includes("..") || value.includes("//") || value.includes("\\")) {
    throw new GitHubInputError(`Invalid file path: must not contain '..', '//', or '\\'.`);
  }
  const segments = value.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === ".." || !SAFE_REPO_RE.test(seg)) {
      throw new GitHubInputError(`Invalid file path segment: '${seg}'.`);
    }
  }
}

export function assertSafeBranch(value: string): void {
  if (!value || typeof value !== "string" || value.length > MAX_BRANCH_LEN) {
    throw new GitHubInputError(`Invalid branch name: must be 1–${MAX_BRANCH_LEN} chars.`);
  }
  if (value.startsWith("/") || value.startsWith(".") || value.startsWith("-")) {
    throw new GitHubInputError("Invalid branch name: must not start with '/', '.', or '-'.");
  }
  if (value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) {
    throw new GitHubInputError("Invalid branch name: must not end with '/', '.', or '.lock'.");
  }
  if (
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.includes("\\") ||
    !SAFE_BRANCH_RE.test(value)
  ) {
    throw new GitHubInputError("Invalid branch name: contains disallowed characters or traversal sequences.");
  }
  const segments = value.split("/");
  for (const seg of segments) {
    if (!seg || seg.startsWith(".") || seg.endsWith(".lock")) {
      throw new GitHubInputError(`Invalid branch name segment: '${seg}'.`);
    }
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface GitHubConnectorConfig {
  /** GitHub API base URL — must be https://api.github.com or a GitHub Enterprise URL. */
  apiBaseUrl?: string;
  /** GitHub token (App installation token or PAT). Never logged. */
  token: string;
  /** Request timeout in milliseconds. Default: 10 000. */
  timeoutMs?: number;
  /** Injected fetch implementation for testing. */
  fetchImpl?: typeof fetch;
  /** Allow HTTP (for local test mock servers only). Default: false. */
  allowHttp?: boolean;
}

export interface FileContent {
  path: string;
  content: string;      // raw UTF-8 content
  sha: string;          // current blob SHA (required for updates)
  encoding: string;
}

export interface BranchInfo {
  name: string;
  sha: string;          // commit SHA at branch tip
}

export interface PullRequest {
  number: number;
  url: string;
  title: string;
  state: string;        // "open" | "closed" | "merged"
  headBranch: string;
  baseBranch: string;
}

export interface CreatePrInput {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;         // source branch
  base: string;         // target branch (usually "main")
  draft?: boolean;
}

export interface UpdateFileInput {
  owner: string;
  repo: string;
  path: string;
  message: string;
  content: string;      // UTF-8 content to write
  sha: string;          // current blob SHA
  branch: string;
}

// ── GitHubConnector ──────────────────────────────────────────────────────────

export class GitHubConnector {
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: GitHubConnectorConfig) {
    const base = config.apiBaseUrl ?? "https://api.github.com";
    // Validate: must be https
    const parsed = new URL(base);
    if (parsed.protocol !== "https:" && !config.allowHttp) {
      throw new GitHubInputError("GitHub API base URL must use HTTPS.");
    }
    this.apiBase = base.replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  // ── Private fetch helper ─────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    maxBytes = MAX_RESPONSE_BYTES,
    signal?: AbortSignal
  ): Promise<T> {
    const url = `${this.apiBase}${path}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const res = await this.fetchImpl(url, {
        method,
        signal: controller.signal as AbortSignal,
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "CloudPilot-Remediation/1.0"
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "error"    // never follow redirects
      });
      // Keep both caller cancellation and the request timeout active while the
      // bounded response body is read, not just until fetch() returns headers.
      const text = await this.readBoundedBody(res, maxBytes);

      if (!res.ok) {
        const safeBody = redactSecrets(text);
        const safeMsg = redactSecrets(text.slice(0, 512));
        if (res.status === 404) throw new GitHubNotFoundError(`GitHub 404: ${safeMsg}`, safeBody);
        if (res.status === 422) throw new GitHubConflictError(`GitHub 422: ${safeMsg}`, safeBody);
        throw new GitHubApiError(
          `GitHub ${res.status}: ${safeMsg}`,
          res.status,
          safeBody,
          res.status === 429 ? res.headers.get("retry-after") ?? undefined : undefined
        );
      }

      if (!text) return {} as T;
      return JSON.parse(text) as T;
    } catch (err) {
      if (err instanceof GitHubApiError) throw err;
      const rawMsg = err instanceof Error ? err.message : String(err);
      const safeMsg = redactSecrets(rawMsg);
      throw new GitHubApiError(`GitHub request failed: ${safeMsg}`, 0, "");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async readBoundedBody(res: Response, maxBytes: number): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) return await res.text();

    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          throw new GitHubApiError(
            `GitHub response exceeded ${maxBytes} bytes — possible misconfigured endpoint.`,
            0,
            ""
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const buf = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buf.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(buf);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Resolves the current SHA of the default branch tip (typically "main").
   */
  async getBranchSha(owner: string, repo: string, branch: string, signal?: AbortSignal): Promise<BranchInfo> {
    assertSafeOwner(owner);
    assertSafeRepo(repo);
    assertSafeBranch(branch);

    const safeBranchPath = branch.split("/").map(encodeURIComponent).join("/");
    const data = await this.request<{ object: { sha: string } }>(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${safeBranchPath}`,
      undefined,
      MAX_RESPONSE_BYTES,
      signal
    );
    return { name: branch, sha: data.object.sha };
  }

  /**
   * Creates a new branch from a given commit SHA.
   * Throws GitHubConflictError if branch already exists.
   */
  async createBranch(owner: string, repo: string, branch: string, fromSha: string, signal?: AbortSignal): Promise<void> {
    assertSafeOwner(owner);
    assertSafeRepo(repo);
    assertSafeBranch(branch);
    if (!fromSha || !/^[0-9a-f]{40}$/i.test(fromSha)) {
      throw new GitHubInputError("Invalid SHA: must be a 40-character hex string.");
    }

    await this.request(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
      { ref: `refs/heads/${branch}`, sha: fromSha },
      MAX_RESPONSE_BYTES,
      signal
    );
  }

  /**
   * Reads a file's content and current SHA. Decodes base64 GitHub response.
   * Throws GitHubNotFoundError if path does not exist on the branch.
   */
  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    branch: string,
    signal?: AbortSignal
  ): Promise<FileContent> {
    assertSafeOwner(owner);
    assertSafeRepo(repo);
    assertSafePath(path);
    assertSafeBranch(branch);

    const safeFilePath = path.split("/").map(encodeURIComponent).join("/");
    const data = await this.request<{
      path: string;
      content: string;
      sha: string;
      encoding: string;
    }>(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${safeFilePath}?ref=${encodeURIComponent(branch)}`,
      undefined,
      MAX_CONTENT_BYTES,
      signal
    );

    const raw = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
    return { path: data.path, content: raw, sha: data.sha, encoding: data.encoding };
  }

  /**
   * Creates or updates a file on a branch.
   * Requires the current blob SHA for updates (prevents lost-update races).
   */
  async updateFile(input: UpdateFileInput, signal?: AbortSignal): Promise<string> {
    assertSafeOwner(input.owner);
    assertSafeRepo(input.repo);
    assertSafePath(input.path);
    assertSafeBranch(input.branch);

    const encoded = Buffer.from(input.content, "utf8").toString("base64");
    const safeFilePath = input.path.split("/").map(encodeURIComponent).join("/");

    const data = await this.request<{ content: { sha: string } }>(
      "PUT",
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${safeFilePath}`,
      {
        message: input.message,
        content: encoded,
        sha: input.sha,
        branch: input.branch
      },
      MAX_RESPONSE_BYTES,
      signal
    );
    return data.content.sha;
  }

  /**
   * Opens a pull request. Returns the PR number and URL.
   * Throws GitHubConflictError if an identical PR already exists.
   */
  async createPullRequest(input: CreatePrInput, signal?: AbortSignal): Promise<PullRequest> {
    assertSafeOwner(input.owner);
    assertSafeRepo(input.repo);
    assertSafeBranch(input.head);
    assertSafeBranch(input.base);

    const data = await this.request<{
      number: number;
      html_url: string;
      title: string;
      state: string;
      head: { ref: string };
      base: { ref: string };
    }>(
      "POST",
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`,
      {
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: input.draft ?? false
      },
      MAX_RESPONSE_BYTES,
      signal
    );

    return {
      number: data.number,
      url: data.html_url,
      title: data.title,
      state: data.state,
      headBranch: data.head.ref,
      baseBranch: data.base.ref
    };
  }

  /**
   * Finds an existing open PR for a given head branch.
   * Returns null if no open PR exists.
   */
  async findOpenPullRequest(
    owner: string,
    repo: string,
    head: string,
    base: string,
    signal?: AbortSignal
  ): Promise<PullRequest | null> {
    assertSafeOwner(owner);
    assertSafeRepo(repo);
    assertSafeBranch(head);
    assertSafeBranch(base);

    const data = await this.request<Array<{
      number: number;
      html_url: string;
      title: string;
      state: string;
      head: { ref: string };
      base: { ref: string };
    }>>(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&head=${encodeURIComponent(owner + ":" + head)}&base=${encodeURIComponent(base)}&per_page=5`,
      undefined,
      MAX_RESPONSE_BYTES,
      signal
    );

    if (!Array.isArray(data) || data.length === 0) return null;

    const match = data.find((pr) => pr.head.ref === head);
    if (!match) return null;

    return {
      number: match.number,
      url: match.html_url,
      title: match.title,
      state: match.state,
      headBranch: match.head.ref,
      baseBranch: match.base.ref
    };
  }

  /**
   * Finds a PR for the deterministic head/base pair in any state. GitHub's
   * `state=closed` response includes merged PRs, distinguished by merged_at.
   * Existing findOpenPullRequest behavior is intentionally unchanged.
   */
  async findPullRequestByHead(
    owner: string,
    repo: string,
    head: string,
    base: string,
    signal?: AbortSignal
  ): Promise<PullRequest | null> {
    assertSafeOwner(owner);
    assertSafeRepo(repo);
    assertSafeBranch(head);
    assertSafeBranch(base);

    type PullRequestRecord = {
      number: number;
      html_url: string;
      title: string;
      state: string;
      merged_at?: string | null;
      head: { ref: string };
      base: { ref: string };
    };
    const matches: PullRequestRecord[] = [];
    const maxPages = 100;
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.request<PullRequestRecord[]>(
        "GET",
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=all&head=${encodeURIComponent(owner + ":" + head)}&base=${encodeURIComponent(base)}&per_page=100&page=${page}`,
        undefined,
        MAX_RESPONSE_BYTES,
        signal
      );
      if (!Array.isArray(data)) {
        throw new Error("GitHub returned an invalid pull request history response.");
      }
      matches.push(...data.filter((pr) => pr.head?.ref === head && pr.base?.ref === base));
      if (data.length < 100) break;
      if (page === maxPages) {
        // Fail closed rather than creating a PR without having enumerated all
        // historical PRs for this deterministic branch.
        throw new Error("Pull request history exceeds the reconciliation limit.");
      }
    }

    const match = matches.find((pr) => pr.state === "open") ??
      matches.find((pr) => Boolean(pr.merged_at) || pr.state === "merged") ??
      matches.find((pr) => pr.state === "closed") ??
      matches[0];
    if (!match) return null;

    return {
      number: match.number,
      url: match.html_url,
      title: match.title,
      state: match.merged_at || match.state === "merged" ? "merged" : match.state,
      headBranch: match.head.ref,
      baseBranch: match.base.ref
    };
  }
}
