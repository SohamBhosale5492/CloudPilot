import { createHash } from "node:crypto";
import { createGitHubAppJwt } from "./app-token-service.js";
import type { GitHubAppAuthenticationCredentialProvider } from "./credential-provider.js";

const API = "https://api.github.com";
const TOKEN_RESPONSE_LIMIT = 64 * 1024;
const TOKEN_TTL_MS = 60 * 60_000;
const MAX_CACHE_ENTRIES = 128;
const REFRESH_MARGIN_MS = 60_000;

/**
 * Deliberately separate from the remediation token service's write scope.
 * contents:read retrieves pinned Git trees/blobs; metadata:read resolves the
 * immutable repository's default branch and verifies its persisted identity.
 */
export const CONTENTS_READ_TOKEN_PERMISSIONS = Object.freeze({ contents: "read", metadata: "read" } as const);

export type ContentsReadTokenErrorCode = "credentials_unavailable" | "unauthorized" | "forbidden" | "not_found" |
  "upstream_failure" | "timeout" | "network_failure" | "invalid_response";

export class ContentsReadTokenError extends Error {
  constructor(readonly code: ContentsReadTokenErrorCode) {
    super("A read-only GitHub repository token could not be obtained.");
    this.name = "ContentsReadTokenError";
  }
}

interface CachedToken { readonly value: string; readonly expiresAt: number }

async function boundedBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new ContentsReadTokenError("invalid_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let abortListener!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => reject(new ContentsReadTokenError("timeout"));
    if (signal.aborted) abortListener();
    else signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    for (;;) {
      if (signal.aborted) throw new ContentsReadTokenError("timeout");
      const result = await Promise.race([reader.read(), aborted]);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > TOKEN_RESPONSE_LIMIT) {
        void reader.cancel().catch(() => undefined);
        throw new ContentsReadTokenError("invalid_response");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof ContentsReadTokenError) throw error;
    throw new ContentsReadTokenError(signal.aborted ? "timeout" : "network_failure");
  } finally { signal.removeEventListener("abort", abortListener); }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

function safeId(value: string): boolean {
  if (!/^[1-9]\d{0,18}$/.test(value)) return false;
  try { return BigInt(value) <= 9_223_372_036_854_775_807n; } catch { return false; }
}
function responseId(value: unknown): string | null {
  if (typeof value === "string" && safeId(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

/** Short-lived in-memory cache dedicated exclusively to contents:read + metadata:read tokens. */
export class ContentsReadInstallationTokenService {
  private readonly cache = new Map<string, CachedToken>();
  private readonly inFlight = new Map<string, { generation: number; promise: Promise<CachedToken> }>();
  private readonly generation = new Map<string, number>();

  constructor(
    private readonly credentials: GitHubAppAuthenticationCredentialProvider,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("Contents token timeout is invalid.");
  }

  invalidate(installationId: string): void {
    if (!safeId(installationId)) throw new ContentsReadTokenError("invalid_response");
    this.generation.set(installationId, (this.generation.get(installationId) ?? 0) + 1);
    for (const key of this.cache.keys()) if (key.startsWith(`${installationId}:`)) this.cache.delete(key);
  }

  async token(installationId: string, repositoryId: string): Promise<string> {
    if (!safeId(installationId) || !safeId(repositoryId)) throw new ContentsReadTokenError("invalid_response");
    const key = `${installationId}:${repositoryId}`;
    const currentGeneration = this.generation.get(installationId) ?? 0;
    const now = this.now();
    for (const [cachedKey, cached] of this.cache) if (cached.expiresAt <= now + REFRESH_MARGIN_MS) this.cache.delete(cachedKey);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now + REFRESH_MARGIN_MS) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.value;
    }
    const pending = this.inFlight.get(key);
    if (pending?.generation === currentGeneration) return (await pending.promise).value;

    const task = this.mint(installationId, repositoryId).then((result) => {
      if ((this.generation.get(installationId) ?? 0) !== currentGeneration) throw new ContentsReadTokenError("invalid_response");
      const currentTime = this.now();
      if (result.expiresAt <= currentTime + REFRESH_MARGIN_MS) throw new ContentsReadTokenError("invalid_response");
      for (const [cachedKey, cachedToken] of this.cache) if (cachedToken.expiresAt <= currentTime + REFRESH_MARGIN_MS) this.cache.delete(cachedKey);
      while (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
      this.cache.delete(key);
      this.cache.set(key, result);
      return result;
    }).finally(() => { if (this.inFlight.get(key)?.promise === task) this.inFlight.delete(key); });
    this.inFlight.set(key, { generation: currentGeneration, promise: task });
    return (await task).value;
  }

  private async mint(installationId: string, repositoryId: string): Promise<CachedToken> {
    let credentials;
    try { credentials = await this.credentials.getAppAuthenticationCredentials(); }
    catch { throw new ContentsReadTokenError("credentials_unavailable"); }
    let jwt: string;
    try { jwt = createGitHubAppJwt(credentials.appId, credentials.privateKeyPem, this.now()); }
    catch { throw new ContentsReadTokenError("credentials_unavailable"); }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // GitHub accepts JSON integer IDs. Keep the persisted decimal ID exact; Number() can round BIGINT values.
      const body = `{"repository_ids":[${repositoryId}],"permissions":{"contents":"read","metadata":"read"}}`;
      let response: Response;
      try {
        response = await this.fetcher(`${API}/app/installations/${installationId}/access_tokens`, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
          body
        });
      } catch { throw new ContentsReadTokenError(controller.signal.aborted ? "timeout" : "network_failure"); }
      if (!response.ok) {
        try { void response.body?.cancel().catch(() => undefined); } catch { /* response contents are not needed */ }
        throw new ContentsReadTokenError(response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : response.status === 404 ? "not_found" : "upstream_failure");
      }
      let data: unknown;
      try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(response, controller.signal))); }
      catch (error) { if (error instanceof ContentsReadTokenError) throw error; throw new ContentsReadTokenError("invalid_response"); }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new ContentsReadTokenError("invalid_response");
      const value = data as Record<string, unknown>;
      const expiry = typeof value.expires_at === "string" ? Date.parse(value.expires_at) : NaN;
      const permissions = value.permissions;
      if (typeof value.token !== "string" || !value.token || value.token.trim() !== value.token || value.token.length > 4096 || /[\u0000-\u001f\u007f]/.test(value.token) ||
          !Number.isFinite(expiry) || expiry <= this.now() + REFRESH_MARGIN_MS || expiry > this.now() + TOKEN_TTL_MS + 60_000 ||
          !permissions || typeof permissions !== "object" || Array.isArray(permissions) ||
          Object.keys(permissions).length !== 2 ||
          (permissions as Record<string, unknown>).contents !== "read" ||
          (permissions as Record<string, unknown>).metadata !== "read" ||
          !Array.isArray(value.repositories) || value.repositories.length !== 1 ||
          !value.repositories[0] || typeof value.repositories[0] !== "object" ||
          responseId((value.repositories[0] as Record<string, unknown>).id) !== repositoryId) {
        throw new ContentsReadTokenError("invalid_response");
      }
      return { value: value.token, expiresAt: expiry };
    } finally { clearTimeout(timer); }
  }
}

/** Useful for verifying GitHub blob bytes without trusting a response's declared digest. */
export function gitBlobSha(content: Uint8Array): string {
  return createHash("sha1").update(`blob ${content.byteLength}\0`, "utf8").update(content).digest("hex");
}
