import { createPrivateKey, createSign } from "node:crypto";
import type { GitHubAppAuthenticationCredentialProvider } from "./credential-provider.js";
import type { AuthorizedGitHubRepositoryAccess } from "./organization-authorization-contract.js";
import { extractJsonIntegerToken } from "./exact-json-integer.js";

const GITHUB_API = "https://api.github.com";
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_MAX_CACHE_ENTRIES = 256;
const MAX_CACHE_ENTRIES = 1024;
const MAX_GITHUB_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** The only permission scope this service can request. Callers cannot override it. */
export const GITHUB_APP_INSTALLATION_PERMISSIONS = Object.freeze({
  contents: "write",
  pull_requests: "write",
  metadata: "read"
} as const);
/** Minimum scope for the artifact-only Git object writer; it does not create pull requests. */
export const GITHUB_ARTIFACT_WRITER_PERMISSIONS = Object.freeze({
  contents: "write",
  metadata: "read"
} as const);
/** Pull-request-only capability; it cannot create or change Git objects. */
export const GITHUB_DRAFT_PR_PERMISSIONS = Object.freeze({
  pull_requests: "write",
  metadata: "read"
} as const);
export type GitHubInstallationPermissions = typeof GITHUB_APP_INSTALLATION_PERMISSIONS |
  typeof GITHUB_ARTIFACT_WRITER_PERMISSIONS | typeof GITHUB_DRAFT_PR_PERMISSIONS;

export interface GitHubAppTokenServiceOptions {
  /** Injected transport for tests; production defaults to Node's fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  refreshMarginMs?: number;
  /** Cache bound: 1 through MAX_CACHE_ENTRIES. Defaults to 256. */
  maxCacheEntries?: number;
  /** Milliseconds since epoch; injectable to make expiry behavior deterministic in tests. */
  now?: () => number;
}

export interface GitHubInstallationToken {
  readonly token: string;
  readonly expiresAt: string;
  readonly installationId: string;
  readonly repositoryId: string;
  readonly permissions: GitHubInstallationPermissions;
}

export type GitHubAppTokenErrorCode =
  | "invalid_installation_id"
  | "invalid_repository_id"
  | "credentials_unavailable"
  | "github_unauthorized"
  | "github_forbidden"
  | "github_not_found"
  | "rate_limited"
  | "github_unavailable"
  | "github_request_failed"
  | "request_timeout"
  | "network_failure"
  | "invalid_github_response"
  | "token_expired_or_too_short"
  | "token_invalidated";

/** Fixed messages only: no response body, credential, JWT, or token is retained. */
export class GitHubAppTokenError extends Error {
  constructor(
    readonly code: GitHubAppTokenErrorCode,
    readonly retryAfterMs?: number
  ) {
    super(messageFor(code));
    this.name = "GitHubAppTokenError";
  }
}

function messageFor(code: GitHubAppTokenErrorCode): string {
  switch (code) {
    case "invalid_installation_id": return "A valid GitHub installation ID is required.";
    case "invalid_repository_id": return "A valid GitHub repository ID is required.";
    case "credentials_unavailable": return "GitHub App credentials are unavailable or invalid.";
    case "github_unauthorized": return "GitHub rejected GitHub App authentication.";
    case "github_forbidden": return "The GitHub App installation lacks access or required permissions.";
    case "github_not_found": return "The GitHub installation or repository was not found or is inaccessible.";
    case "rate_limited": return "GitHub rate limited the token request.";
    case "github_unavailable": return "GitHub is temporarily unavailable.";
    case "github_request_failed": return "GitHub could not create the installation token.";
    case "request_timeout": return "The GitHub token request timed out.";
    case "network_failure": return "The GitHub token request could not be completed.";
    case "invalid_github_response": return "GitHub returned an invalid installation-token response.";
    case "token_expired_or_too_short": return "GitHub returned a token that is expired or too close to expiration.";
    case "token_invalidated": return "The GitHub installation token was invalidated while being created.";
  }
}

interface CacheEntry {
  readonly token: GitHubInstallationToken;
  readonly expiresAtMs: number;
  readonly generation: number;
}

interface InFlightEntry {
  readonly generation: number;
  readonly promise: Promise<GitHubInstallationToken>;
}

/**
 * Backend-only GitHub App token service. It creates short-lived, repository-scoped
 * tokens and holds them only in memory. It does not persist credentials or tokens.
 */
export class GitHubAppTokenService {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly refreshMarginMs: number;
  private readonly maxCacheEntries: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly installationGenerations = new Map<string, number>();

  constructor(
    private readonly credentialProvider: GitHubAppAuthenticationCredentialProvider,
    options: GitHubAppTokenServiceOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.refreshMarginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new Error("GitHub token request timeout must be between 1 and 120000 milliseconds.");
    }
    if (!Number.isSafeInteger(this.refreshMarginMs) || this.refreshMarginMs < 0 || this.refreshMarginMs > 10 * 60_000) {
      throw new Error("GitHub token refresh margin is invalid.");
    }
    if (!Number.isSafeInteger(this.maxCacheEntries) || this.maxCacheEntries < 1 || this.maxCacheEntries > MAX_CACHE_ENTRIES) {
      throw new Error(`GitHub token cache size must be between 1 and ${MAX_CACHE_ENTRIES}.`);
    }
  }

  async getInstallationToken(input: AuthorizedGitHubRepositoryAccess): Promise<GitHubInstallationToken> {
    return this.getScopedInstallationToken(input, GITHUB_APP_INSTALLATION_PERMISSIONS);
  }

  async getArtifactWriterInstallationToken(input: AuthorizedGitHubRepositoryAccess): Promise<GitHubInstallationToken> {
    return this.getScopedInstallationToken(input, GITHUB_ARTIFACT_WRITER_PERMISSIONS);
  }

  async getDraftPullRequestInstallationToken(input: AuthorizedGitHubRepositoryAccess): Promise<GitHubInstallationToken> {
    return this.getScopedInstallationToken(input, GITHUB_DRAFT_PR_PERMISSIONS);
  }

  private async getScopedInstallationToken(input: AuthorizedGitHubRepositoryAccess,
    permissions: GitHubInstallationPermissions): Promise<GitHubInstallationToken> {
    const installationId = normalizeId(input?.installationId, "invalid_installation_id");
    const repositoryId = normalizeId(input?.repositoryId, "invalid_repository_id");
    const permissionScopeKey = JSON.stringify(permissions);
    const key = `${installationId}:${repositoryId}:${permissionScopeKey}`;
    const generation = this.installationGenerations.get(installationId) ?? 0;
    this.removeExpiredEntries(this.now());
    const cached = this.cache.get(key);
    if (cached && cached.generation === generation && cached.expiresAtMs > this.now() + this.refreshMarginMs) {
      // Map insertion order is the LRU order; refresh on use.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.token;
    }
    if (cached) this.cache.delete(key);

    const pending = this.inFlight.get(key);
    if (pending?.generation === generation) return pending.promise;

    const promise = this.createToken(installationId, repositoryId, generation, permissions).then((token) => {
      if ((this.installationGenerations.get(installationId) ?? 0) !== generation) {
        throw new GitHubAppTokenError("token_invalidated");
      }
      const expiresAtMs = Date.parse(token.expiresAt);
      const cacheNow = this.now();
      this.removeExpiredEntries(cacheNow);
      if (expiresAtMs <= cacheNow + this.refreshMarginMs) {
        throw new GitHubAppTokenError("token_expired_or_too_short");
      }
      this.evictLeastRecentlyUsedIfFull();
      this.cache.set(key, { token, expiresAtMs, generation });
      return token;
    }).finally(() => {
      if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, { generation, promise });
    return promise;
  }

  /**
   * Invalidate one installation or all cached tokens for it. An in-flight token
   * minted before invalidation is rejected rather than returned or cached.
   */
  invalidate(installationIdInput: string | number): void {
    const installationId = normalizeId(installationIdInput, "invalid_installation_id");
    this.installationGenerations.set(installationId, (this.installationGenerations.get(installationId) ?? 0) + 1);
    const prefix = `${installationId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  private async createToken(
    installationId: string,
    repositoryId: string,
    generation: number,
    permissions: GitHubInstallationPermissions
  ): Promise<GitHubInstallationToken> {
    let credentials;
    try {
      credentials = await this.credentialProvider.getAppAuthenticationCredentials();
      if (!credentials || !Number.isSafeInteger(credentials.appId) || credentials.appId <= 0 ||
          typeof credentials.privateKeyPem !== "string" || !credentials.privateKeyPem) {
        throw new Error();
      }
    } catch {
      throw new GitHubAppTokenError("credentials_unavailable");
    }

    const jwt = createGitHubAppJwt(credentials.appId, credentials.privateKeyPem, this.now());
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(
          `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${jwt}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "Content-Type": "application/json",
              "User-Agent": "CloudPilot-GitHub-App"
            },
            // IDs are decimal strings internally. Emit validated digits as a
            // JSON integer token so large GitHub IDs are never rounded by JS.
            body: `{"repository_ids":[${repositoryId}],"permissions":${JSON.stringify(permissions)}}`,
            redirect: "error",
            signal: controller.signal
          }
        );
      } catch {
        if (controller.signal.aborted) throw new GitHubAppTokenError("request_timeout");
        throw new GitHubAppTokenError("network_failure");
      }

      if (!response.ok) {
        await cancelBody(response);
        throw statusError(response, this.now());
      }

      const bodyText = await readBoundedBody(response, controller.signal);
      let body: unknown;
      try { body = JSON.parse(bodyText); } catch { throw new GitHubAppTokenError("invalid_github_response"); }
      const exactRepositoryId = extractJsonIntegerToken(bodyText, ["repositories", 0, "id"]);
      const token = validateTokenResponse(body, exactRepositoryId, installationId, repositoryId, permissions,
        this.now(), this.refreshMarginMs);
      if ((this.installationGenerations.get(installationId) ?? 0) !== generation) {
        throw new GitHubAppTokenError("token_invalidated");
      }
      return token;
    } catch (error) {
      if (error instanceof GitHubAppTokenError) throw error;
      if (controller.signal.aborted) throw new GitHubAppTokenError("request_timeout");
      throw new GitHubAppTokenError("invalid_github_response");
    } finally {
      clearTimeout(timeout);
    }
  }

  private removeExpiredEntries(nowMs: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAtMs <= nowMs ||
          entry.generation !== (this.installationGenerations.get(entry.token.installationId) ?? 0)) {
        this.cache.delete(key);
      }
    }
  }

  /** Map order is least-recently-used first; expired entries are pruned first. */
  private evictLeastRecentlyUsedIfFull(): void {
    if (this.cache.size < this.maxCacheEntries) return;
    const oldest = this.cache.keys().next();
    if (!oldest.done) this.cache.delete(oldest.value);
  }
}

function normalizeId(value: unknown, code: "invalid_installation_id" | "invalid_repository_id"): string {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9]\d{0,18}$/.test(text)) {
    throw new GitHubAppTokenError(code);
  }
  try {
    if (BigInt(text) > 9_223_372_036_854_775_807n) throw new Error();
  } catch {
    throw new GitHubAppTokenError(code);
  }
  return text;
}

/** Shared backend-only RS256 App JWT signer for GitHub App-authenticated API calls. */
export function createGitHubAppJwt(appId: number, privateKeyPem: string, nowMs: number): string {
  try {
    const key = createPrivateKey(privateKeyPem);
    const modulusLength = key.asymmetricKeyDetails?.modulusLength;
    if (key.asymmetricKeyType !== "rsa" || typeof modulusLength !== "number" || modulusLength < 2048) {
      throw new Error();
    }
    const nowSeconds = Math.floor(nowMs / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64url(JSON.stringify({ iat: nowSeconds - 30, exp: nowSeconds + 540, iss: String(appId) }));
    const signingInput = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    return `${signingInput}.${signer.sign(key).toString("base64url")}`;
  } catch {
    throw new GitHubAppTokenError("credentials_unavailable");
  }
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const cancelOnAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new GitHubAppTokenError("request_timeout");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new GitHubAppTokenError("invalid_github_response");
      }
      chunks.push(Buffer.from(value));
    }
    if (signal.aborted) throw new GitHubAppTokenError("request_timeout");
    return Buffer.concat(chunks, total).toString("utf8");
  } catch (error) {
    if (error instanceof GitHubAppTokenError) throw error;
    if (signal.aborted) throw new GitHubAppTokenError("request_timeout");
    throw new GitHubAppTokenError("invalid_github_response");
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    try { reader.releaseLock(); } catch { /* reader may have been cancelled */ }
  }
}

async function cancelBody(response: Response): Promise<void> {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* no error-body contents are needed */ }
}

function statusError(response: Response, nowMs: number): GitHubAppTokenError {
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), nowMs);
  if (response.status === 401) return new GitHubAppTokenError("github_unauthorized");
  if (response.status === 404) return new GitHubAppTokenError("github_not_found");
  if (response.status === 429 || (response.status === 403 &&
      (retryAfterMs !== undefined || response.headers.get("x-ratelimit-remaining") === "0"))) {
    return new GitHubAppTokenError("rate_limited", retryAfterMs);
  }
  if (response.status === 403) return new GitHubAppTokenError("github_forbidden");
  if (response.status >= 500) return new GitHubAppTokenError("github_unavailable");
  return new GitHubAppTokenError("github_request_failed");
}

function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  let delay: number;
  if (/^\d+$/.test(value)) delay = Number(value) * 1000;
  else {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return undefined;
    delay = timestamp - nowMs;
  }
  return Number.isFinite(delay) && delay >= 0 && delay <= MAX_RETRY_AFTER_MS ? delay : undefined;
}

function validateTokenResponse(
  value: unknown,
  exactRepositoryId: string | undefined,
  installationId: string,
  repositoryId: string,
  permissions: GitHubInstallationPermissions,
  nowMs: number,
  refreshMarginMs: number
): GitHubInstallationToken {
  if (!isRecord(value) || typeof value.token !== "string" || value.token.length < 1 || value.token.length > 4096 ||
      value.token.trim() !== value.token || /[\u0000-\u001f\u007f]/u.test(value.token) ||
      typeof value.expires_at !== "string") {
    throw new GitHubAppTokenError("invalid_github_response");
  }
  const expiresAtMs = Date.parse(value.expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs + refreshMarginMs ||
      expiresAtMs > nowMs + MAX_GITHUB_TOKEN_LIFETIME_MS + 60_000) {
    throw new GitHubAppTokenError("token_expired_or_too_short");
  }
  if (!hasExactPermissions(value.permissions, permissions)) {
    throw new GitHubAppTokenError("invalid_github_response");
  }
  if (!Array.isArray(value.repositories) || value.repositories.length !== 1 ||
      !isRecord(value.repositories[0]) || typeof value.repositories[0].id !== "number" ||
      !Number.isInteger(value.repositories[0].id) || exactRepositoryId !== repositoryId) {
    throw new GitHubAppTokenError("invalid_github_response");
  }
  return Object.freeze({
    token: value.token,
    expiresAt: new Date(expiresAtMs).toISOString(),
    installationId,
    repositoryId,
    permissions
  });
}

function hasExactPermissions(value: unknown, expected: GitHubInstallationPermissions): boolean {
  if (!isRecord(value)) return false;
  const expectedEntries = Object.entries(expected);
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedEntries.length && expectedEntries.every(([key, permission]) =>
    Object.hasOwn(value, key) && value[key] === permission);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
