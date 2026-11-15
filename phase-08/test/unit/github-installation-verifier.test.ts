import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { GitHubAppAuthenticationCredentialProvider } from "../../src/github/credential-provider.js";
import { GITHUB_APP_INSTALLATION_PERMISSIONS } from "../../src/github/app-token-service.js";
import { GitHubAppInstallationVerifier, GitHubInstallationVerificationError } from "../../src/github/installation-verifier.js";

const FIXED_NOW = Date.parse("2026-11-05T12:00:00.000Z");
const INSTALLATION_ID = "12345678";
const account = { id: 987654, login: "cloudpilot-org", type: "Organization" };

function provider(): GitHubAppAuthenticationCredentialProvider {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  return { async getAppAuthenticationCredentials() { return { appId: 12345, privateKeyPem: pair.privateKey }; } };
}

function response(overrides: Record<string, unknown> = {}, status = 200): Response {
  return new Response(JSON.stringify({
    id: Number(INSTALLATION_ID), account, suspended_at: null,
    permissions: GITHUB_APP_INSTALLATION_PERMISSIONS,
    ...overrides
  }), { status, headers: { "content-type": "application/json" } });
}

function verifier(fetchImpl: typeof fetch, timeoutMs = 1000) {
  return new GitHubAppInstallationVerifier(provider(), { fetchImpl, timeoutMs, now: () => FIXED_NOW });
}

test("verifies the exact installation with fixed HTTPS endpoint, headers, and read-only GET", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const subject = verifier((async (input, init) => {
    requestUrl = String(input); requestInit = init; return response();
  }) as typeof fetch);
  const result = await subject.verify(INSTALLATION_ID);
  assert.equal(requestUrl, `https://api.github.com/app/installations/${INSTALLATION_ID}`);
  assert.equal(requestInit?.method, "GET");
  assert.equal(requestInit?.redirect, "error");
  assert.equal((requestInit?.headers as Record<string, string>).Accept, "application/vnd.github+json");
  assert.equal((requestInit?.headers as Record<string, string>)["X-GitHub-Api-Version"], "2022-11-28");
  assert.match((requestInit?.headers as Record<string, string>).Authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  assert.deepEqual(result, {
    installationId: 12345678n, accountId: 987654n, accountLogin: "cloudpilot-org",
    accountType: "Organization", permissions: GITHUB_APP_INSTALLATION_PERMISSIONS
  });
});

test("rejects mismatched IDs, malformed JSON, and malformed account fields", async () => {
  await assert.rejects(verifier((async () => response({ id: 99 })) as typeof fetch).verify(INSTALLATION_ID),
    (error: unknown) => error instanceof GitHubInstallationVerificationError && error.code === "invalid_response");
  await assert.rejects(verifier((async () => new Response("not-json")) as typeof fetch).verify(INSTALLATION_ID),
    (error: unknown) => error instanceof GitHubInstallationVerificationError && error.code === "invalid_response");
  await assert.rejects(verifier((async () => response({ account: { ...account, id: Number.MAX_SAFE_INTEGER + 1 } })) as typeof fetch).verify(INSTALLATION_ID),
    (error: unknown) => error instanceof GitHubInstallationVerificationError && error.code === "invalid_response");
  await assert.rejects(verifier((async () => response({ account: { ...account, login: "not a login" } })) as typeof fetch).verify(INSTALLATION_ID),
    (error: unknown) => error instanceof GitHubInstallationVerificationError && error.code === "invalid_response");
});

test("accepts required permissions with optional checks:read", async () => {
  const permissionsWithChecks = {
    ...GITHUB_APP_INSTALLATION_PERMISSIONS,
    checks: "read"
  };
  const subject = verifier((async () => response({ permissions: permissionsWithChecks })) as typeof fetch);
  const result = await subject.verify(INSTALLATION_ID);
  assert.deepEqual(result, {
    installationId: 12345678n,
    accountId: 987654n,
    accountLogin: "cloudpilot-org",
    accountType: "Organization",
    permissions: permissionsWithChecks
  });
});

test("rejects suspended installations and missing, insufficient, or unexpected permissions", async () => {
  await assert.rejects(verifier((async () => response({ suspended_at: "2026-01-01T00:00:00Z" })) as typeof fetch).verify(INSTALLATION_ID),
    (error: unknown) => error instanceof GitHubInstallationVerificationError && error.code === "installation_suspended");
  await assert.rejects(verifier((async () => response({ permissions: { metadata: "read" } })) as typeof fetch).verify(INSTALLATION_ID),
    (error: unknown) => error instanceof GitHubInstallationVerificationError && error.code === "insufficient_permissions");
  await assert.rejects(verifier((async () => response({ permissions: { contents: "write", metadata: "read" } })) as typeof fetch).verify(INSTALLATION_ID),
    (error: unknown) => error instanceof GitHubInstallationVerificationError && error.code === "insufficient_permissions");
  await assert.rejects(verifier((async () => response({ permissions: { ...GITHUB_APP_INSTALLATION_PERMISSIONS, contents: "read" } })) as typeof fetch).verify(INSTALLATION_ID),
    (error: unknown) => error instanceof GitHubInstallationVerificationError && error.code === "insufficient_permissions");
  await assert.rejects(verifier((async () => response({ permissions: { ...GITHUB_APP_INSTALLATION_PERMISSIONS, checks: "write" } })) as typeof fetch).verify(INSTALLATION_ID),
    (error: unknown) => error instanceof GitHubInstallationVerificationError && error.code === "insufficient_permissions");
  await assert.rejects(verifier((async () => response({ permissions: { ...GITHUB_APP_INSTALLATION_PERMISSIONS, administration: "write" } })) as typeof fetch).verify(INSTALLATION_ID),
    (error: unknown) => error instanceof GitHubInstallationVerificationError && error.code === "insufficient_permissions");
});

test("rejects unsafe, zero, non-decimal, and out-of-BIGINT installation identifiers", async () => {
  const subject = verifier((async () => { throw new Error("must not request GitHub"); }) as typeof fetch);
  for (const value of ["0", "-1", "01", "1.2", "9223372036854775808", "99999999999999999999"]) {
    await assert.rejects(subject.verify(value), (error: unknown) => error instanceof GitHubInstallationVerificationError && error.code === "invalid_response");
  }
});

test("maps GitHub errors to fixed categories without response details", async () => {
  for (const [status, category] of [[401, "github_unauthorized"], [403, "github_forbidden"], [404, "github_not_found"], [429, "rate_limited"], [503, "github_unavailable"]] as const) {
    await assert.rejects(verifier((async () => new Response("sensitive upstream body", { status })) as typeof fetch).verify(INSTALLATION_ID),
      (error: unknown) => error instanceof GitHubInstallationVerificationError && error.code === category && !error.message.includes("sensitive"));
  }
});

test("bounds response size and covers stalled response-body reads with the timeout", async () => {
  const oversized = new Response("x".repeat(65 * 1024));
  await assert.rejects(verifier((async () => oversized) as typeof fetch).verify(INSTALLATION_ID),
    (error: unknown) => error instanceof GitHubInstallationVerificationError && error.code === "invalid_response");
  const stalled = new Response(new ReadableStream<Uint8Array>({ pull() {} }));
  await assert.rejects(verifier((async () => stalled) as typeof fetch, 15).verify(INSTALLATION_ID),
    (error: unknown) => error instanceof GitHubInstallationVerificationError && error.code === "request_timeout");
});

test("does not call GitHub when App credentials are unavailable", async () => {
  let calls = 0;
  const subject = new GitHubAppInstallationVerifier({ async getAppAuthenticationCredentials() { throw new Error("private key details"); } }, {
    fetchImpl: (async () => { calls += 1; return response(); }) as typeof fetch,
    now: () => FIXED_NOW
  });
  await assert.rejects(subject.verify(INSTALLATION_ID),
    (error: unknown) => error instanceof GitHubInstallationVerificationError && error.code === "credentials_unavailable" && !error.message.includes("private"));
  assert.equal(calls, 0);
});
