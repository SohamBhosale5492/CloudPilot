import { GitHubAppTokenError, GITHUB_APP_INSTALLATION_PERMISSIONS, createGitHubAppJwt } from "./app-token-service.js";
import type { GitHubAppAuthenticationCredentialProvider } from "./credential-provider.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

export type GitHubInstallationVerificationErrorCode =
  | "credentials_unavailable"
  | "request_timeout"
  | "network_failure"
  | "github_unauthorized"
  | "github_forbidden"
  | "github_not_found"
  | "rate_limited"
  | "github_unavailable"
  | "github_request_failed"
  | "invalid_response"
  | "installation_suspended"
  | "insufficient_permissions";

/** Fixed messages only; never retains response bodies, JWTs, credentials, or headers. */
export class GitHubInstallationVerificationError extends Error {
  constructor(readonly code: GitHubInstallationVerificationErrorCode) {
    super(messageFor(code));
    this.name = "GitHubInstallationVerificationError";
  }
}

function messageFor(code: GitHubInstallationVerificationErrorCode): string {
  switch (code) {
    case "credentials_unavailable": return "GitHub App authentication credentials are unavailable.";
    case "request_timeout": return "GitHub installation verification timed out.";
    case "network_failure": return "GitHub installation verification could not connect.";
    case "github_unauthorized": return "GitHub rejected CloudPilot App authentication.";
    case "github_forbidden": return "GitHub denied CloudPilot App access.";
    case "github_not_found": return "The GitHub installation was not found or is inaccessible.";
    case "rate_limited": return "GitHub rate limited installation verification.";
    case "github_unavailable": return "GitHub is temporarily unavailable.";
    case "github_request_failed": return "GitHub could not verify the installation.";
    case "invalid_response": return "GitHub returned an invalid installation response.";
    case "installation_suspended": return "The GitHub App installation is suspended.";
    case "insufficient_permissions": return "The GitHub App installation lacks the required permissions.";
  }
}

export interface VerifiedGitHubInstallation {
  installationId: bigint;
  accountId: bigint;
  accountLogin: string;
  accountType: "User" | "Organization";
  permissions: Readonly<Record<string, string>>;
}

export interface GitHubInstallationVerifierOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** Uses an App JWT to independently verify one installation through GitHub's read-only API. */
export class GitHubAppInstallationVerifier {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly credentials: GitHubAppAuthenticationCredentialProvider,
    options: GitHubInstallationVerifierOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error("GitHub installation verification timeout must be between 1 and 120000 milliseconds.");
    }
  }

  async verify(installationIdInput: string): Promise<VerifiedGitHubInstallation> {
    const installationId = parsePositiveBigInt(installationIdInput);
    if (installationId === null) throw new GitHubInstallationVerificationError("invalid_response");

    let appJwt: string;
    try {
      const credentials = await this.credentials.getAppAuthenticationCredentials();
      if (!credentials || !Number.isSafeInteger(credentials.appId) || credentials.appId <= 0 ||
          typeof credentials.privateKeyPem !== "string" || credentials.privateKeyPem.length === 0) throw new Error();
      appJwt = createGitHubAppJwt(credentials.appId, credentials.privateKeyPem, this.now());
    } catch (error) {
      if (error instanceof GitHubAppTokenError && error.code === "credentials_unavailable") {
        throw new GitHubInstallationVerificationError("credentials_unavailable");
      }
      throw new GitHubInstallationVerificationError("credentials_unavailable");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${GITHUB_API}/app/installations/${installationId.toString()}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${appJwt}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
            "User-Agent": "CloudPilot-GitHub-App"
          },
          redirect: "error",
          signal: controller.signal
        });
      } catch {
        throw new GitHubInstallationVerificationError(controller.signal.aborted ? "request_timeout" : "network_failure");
      }

      if (!response.ok) {
        await cancelBody(response);
        throw statusError(response.status);
      }

      const body = await readBoundedJson(response, controller.signal);
      return validateInstallation(body, installationId);
    } catch (error) {
      if (error instanceof GitHubInstallationVerificationError) throw error;
      if (controller.signal.aborted) throw new GitHubInstallationVerificationError("request_timeout");
      throw new GitHubInstallationVerificationError("invalid_response");
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parsePositiveBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= MAX_POSTGRES_BIGINT ? parsed : null;
  } catch { return null; }
}

function parseApiId(value: unknown): bigint | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  const parsed = BigInt(value);
  return parsed <= MAX_POSTGRES_BIGINT ? parsed : null;
}

function validateInstallation(value: unknown, expectedId: bigint): VerifiedGitHubInstallation {
  if (!isRecord(value) || parseApiId(value.id) !== expectedId) {
    throw new GitHubInstallationVerificationError("invalid_response");
  }
  if (value.suspended_at !== null) {
    if (typeof value.suspended_at === "string" && value.suspended_at.length > 0) {
      throw new GitHubInstallationVerificationError("installation_suspended");
    }
    throw new GitHubInstallationVerificationError("invalid_response");
  }
  if (!isRecord(value.account)) throw new GitHubInstallationVerificationError("invalid_response");
  const accountId = parseApiId(value.account.id);
  const accountLogin = value.account.login;
  const accountType = value.account.type;
  if (accountId === null || typeof accountLogin !== "string" ||
      accountLogin.length < 1 || accountLogin.length > 100 || accountLogin !== accountLogin.trim() ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/.test(accountLogin) ||
      (accountType !== "User" && accountType !== "Organization")) {
    throw new GitHubInstallationVerificationError("invalid_response");
  }
  if (!hasRequiredPermissions(value.permissions)) {
    throw new GitHubInstallationVerificationError("insufficient_permissions");
  }
  return {
    installationId: expectedId,
    accountId,
    accountLogin,
    accountType,
    permissions: Object.freeze({ ...value.permissions })
  };
}

function hasRequiredPermissions(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  const required = GITHUB_APP_INSTALLATION_PERMISSIONS;
  const keys = Object.keys(value).sort();
  const expectedKeys = Object.keys(required).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return false;
  return Object.entries(required).every(([name, permission]) => value[name] === permission);
}

function statusError(status: number): GitHubInstallationVerificationError {
  if (status === 401) return new GitHubInstallationVerificationError("github_unauthorized");
  if (status === 403) return new GitHubInstallationVerificationError("github_forbidden");
  if (status === 404) return new GitHubInstallationVerificationError("github_not_found");
  if (status === 429) return new GitHubInstallationVerificationError("rate_limited");
  if (status >= 500) return new GitHubInstallationVerificationError("github_unavailable");
  return new GitHubInstallationVerificationError("github_request_failed");
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new GitHubInstallationVerificationError("invalid_response");
  const reader = response.body.getReader();
  const cancelOnAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new GitHubInstallationVerificationError("request_timeout");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new GitHubInstallationVerificationError("invalid_response");
      }
      chunks.push(Buffer.from(value));
    }
    if (signal.aborted) throw new GitHubInstallationVerificationError("request_timeout");
    try { return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown; }
    catch { throw new GitHubInstallationVerificationError("invalid_response"); }
  } catch (error) {
    if (error instanceof GitHubInstallationVerificationError) throw error;
    if (signal.aborted) throw new GitHubInstallationVerificationError("request_timeout");
    throw new GitHubInstallationVerificationError("invalid_response");
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    try { reader.releaseLock(); } catch { /* stream may already be cancelled */ }
  }
}

async function cancelBody(response: Response): Promise<void> {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* body is intentionally discarded */ }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
