import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import test from "node:test";
import type {
  GitHubAppAuthenticationCredentialProvider,
  GitHubAppAuthenticationCredentials,
  GitHubAppCredentials
} from "../../src/github/credential-provider.js";
import type { AuthorizedGitHubRepositoryAccess } from "../../src/github/organization-authorization-contract.js";
import {
  GITHUB_APP_INSTALLATION_PERMISSIONS,
  GITHUB_ARTIFACT_WRITER_PERMISSIONS,
  GITHUB_DRAFT_PR_PERMISSIONS,
  GitHubAppTokenError,
  GitHubAppTokenService
} from "../../src/github/app-token-service.js";

const FIXED_NOW = Date.parse("2026-01-02T03:04:05.000Z");

function credentialFixture(): { credentials: GitHubAppCredentials; publicKeyPem: string } {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  return {
    credentials: {
      appId: 123456,
      privateKeyPem: pair.privateKey,
      webhookSecret: randomBytes(32).toString("base64url")
    },
    publicKeyPem: pair.publicKey
  };
}

function provider(credentials: GitHubAppAuthenticationCredentials): GitHubAppAuthenticationCredentialProvider {
  return { async getAppAuthenticationCredentials() { return credentials; } };
}

function authorizedScope(installationId: string | number, repositoryId: string | number): AuthorizedGitHubRepositoryAccess {
  return Object.freeze({ installationId: String(installationId), repositoryId: String(repositoryId) }) as AuthorizedGitHubRepositoryAccess;
}

function githubResponse(
  now = FIXED_NOW,
  options: { token?: string; expiresInMs?: number; repositoryId?: number; permissions?: unknown } = {}
): Response {
  return new Response(JSON.stringify({
    token: options.token ?? `ghs_${randomBytes(24).toString("base64url")}`,
    expires_at: new Date(now + (options.expiresInMs ?? 60 * 60_000)).toISOString(),
    permissions: options.permissions ?? GITHUB_APP_INSTALLATION_PERMISSIONS,
    repositories: [{ id: options.repositoryId ?? 42 }]
  }), { status: 201, headers: { "content-type": "application/json" } });
}

function tokenService(
  credentials: GitHubAppCredentials,
  fetchImpl: typeof fetch,
  options: { now?: () => number; timeoutMs?: number; refreshMarginMs?: number; maxCacheEntries?: number } = {}
): GitHubAppTokenService {
  return new GitHubAppTokenService(provider(credentials), {
    fetchImpl,
    now: options.now ?? (() => FIXED_NOW),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.refreshMarginMs !== undefined ? { refreshMarginMs: options.refreshMarginMs } : {}),
    ...(options.maxCacheEntries !== undefined ? { maxCacheEntries: options.maxCacheEntries } : {})
  });
}

function makeFetcher(responseFactory: () => Response, inspect?: (url: string, init: RequestInit) => void): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    inspect?.(String(input), init ?? {});
    return responseFactory();
  }) as typeof fetch;
}

test("creates a verifiable RS256 GitHub App JWT with a skew allowance and less than ten-minute lifetime", async () => {
  const { credentials, publicKeyPem } = credentialFixture();
  let capturedJwt = "";
  const service = tokenService(credentials, makeFetcher(() => githubResponse(), (_url, init) => {
    capturedJwt = String((init.headers as Record<string, string>).Authorization).slice("Bearer ".length);
  }));

  await service.getInstallationToken(authorizedScope("77", "42"));
  const [encodedHeader, encodedPayload, encodedSignature] = capturedJwt.split(".");
  assert.ok(encodedHeader && encodedPayload && encodedSignature);
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as { alg: string; typ: string };
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as {
    iat: number; exp: number; iss: string;
  };
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  assert.equal(payload.iss, "123456");
  assert.equal(payload.iat, Math.floor(FIXED_NOW / 1000) - 30);
  assert.equal(payload.exp, Math.floor(FIXED_NOW / 1000) + 540);
  assert.ok(payload.exp > Math.floor(FIXED_NOW / 1000));
  assert.ok(payload.exp - payload.iat <= 600);
  assert.equal(verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`), createPublicKey(publicKeyPem), Buffer.from(encodedSignature, "base64url")), true);
});

test("requests a token for the explicit repository and fixed minimum permission scope", async () => {
  const { credentials } = credentialFixture();
  let calls = 0;
  const service = tokenService(credentials, makeFetcher(() => githubResponse(), (url, init) => {
    calls++;
    assert.equal(url, "https://api.github.com/app/installations/77/access_tokens");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.match(String((init.headers as Record<string, string>).Authorization), /^Bearer [^.]+\.[^.]+\.[^.]+$/u);
    assert.equal((init.headers as Record<string, string>).Accept, "application/vnd.github+json");
    assert.equal((init.headers as Record<string, string>)["X-GitHub-Api-Version"], "2022-11-28");
    assert.deepEqual(JSON.parse(String(init.body)), {
      repository_ids: [42],
      permissions: { contents: "write", pull_requests: "write", metadata: "read" }
    });
  }));
  const result = await service.getInstallationToken(authorizedScope(77, 42));
  assert.equal(calls, 1);
  assert.equal(result.installationId, "77");
  assert.equal(result.repositoryId, "42");
  assert.equal(Date.parse(result.expiresAt), FIXED_NOW + 60 * 60_000);
  assert.ok(Object.isFrozen(result));
});

test("artifact writer and PR profiles request and validate their exact minimal permissions", async () => {
  const { credentials } = credentialFixture();
  let body = "";
  const service = tokenService(credentials, makeFetcher(() => githubResponse(FIXED_NOW, {
    permissions: GITHUB_ARTIFACT_WRITER_PERMISSIONS
  }), (_url, init) => { body = String(init.body); }));
  const token = await service.getArtifactWriterInstallationToken(authorizedScope("77", "42"));
  assert.deepEqual(JSON.parse(body), {
    repository_ids: [42],
    permissions: { contents: "write", metadata: "read" }
  });
  assert.deepEqual(token.permissions, { contents: "write", metadata: "read" });

  const overprivileged = tokenService(credentials, makeFetcher(() => githubResponse(FIXED_NOW)));
  await assert.rejects(overprivileged.getArtifactWriterInstallationToken(authorizedScope("77", "42")),
    (error: unknown) => error instanceof GitHubAppTokenError && error.code === "invalid_github_response");

  const overprivilegedPullRequest = tokenService(credentials, makeFetcher(() => githubResponse(FIXED_NOW, {
    permissions: GITHUB_APP_INSTALLATION_PERMISSIONS
  })));
  await assert.rejects(overprivilegedPullRequest.getDraftPullRequestInstallationToken(authorizedScope("77", "42")),
    (error: unknown) => error instanceof GitHubAppTokenError && error.code === "invalid_github_response");
});

test("cache keeps the artifact-writer token separate from the broader pull-request token", async () => {
  const { credentials } = credentialFixture();
  let calls = 0;
  const service = tokenService(credentials, (async (_input: string | URL | Request, init?: RequestInit) => {
    calls++;
    const request = JSON.parse(String(init?.body)) as { permissions: unknown };
    return githubResponse(FIXED_NOW, { permissions: request.permissions });
  }) as typeof fetch);

  const prToken = await service.getInstallationToken(authorizedScope("77", "42"));
  const writerToken = await service.getArtifactWriterInstallationToken(authorizedScope("77", "42"));
  assert.equal(calls, 2);
  assert.deepEqual(prToken.permissions, GITHUB_APP_INSTALLATION_PERMISSIONS);
  assert.deepEqual(writerToken.permissions, GITHUB_ARTIFACT_WRITER_PERMISSIONS);
  const draftToken = await service.getDraftPullRequestInstallationToken(authorizedScope("77", "42"));
  assert.equal(calls, 3);
  assert.deepEqual(draftToken.permissions, GITHUB_DRAFT_PR_PERMISSIONS);
});

test("preserves large decimal installation and repository IDs without Number rounding", async () => {
  const { credentials } = credentialFixture();
  const largeInstallationId = "9223372036854775000";
  const largeRepositoryId = "9007199254740993";
  let requestBody = "";
  let requestUrl = "";
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(input);
    requestBody = String(init?.body);
    return new Response(`{"token":"ghs_large_id_test","expires_at":"${new Date(FIXED_NOW + 3_600_000).toISOString()}","permissions":{"contents":"write","pull_requests":"write","metadata":"read"},"repositories":[{"id":${largeRepositoryId}}]}`, {
      status: 201, headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  const service = tokenService(credentials, fetchImpl);
  const result = await service.getInstallationToken(authorizedScope(largeInstallationId, largeRepositoryId));
  assert.equal(requestUrl, `https://api.github.com/app/installations/${largeInstallationId}/access_tokens`);
  assert.equal(requestBody, `{"repository_ids":[${largeRepositoryId}],"permissions":{"contents":"write","pull_requests":"write","metadata":"read"}}`);
  assert.equal(result.installationId, largeInstallationId);
  assert.equal(result.repositoryId, largeRepositoryId);
});

test("rejects malformed IDs, missing credentials, and invalid private keys without leaking material", async () => {
  const { credentials } = credentialFixture();
  const service = tokenService(credentials, makeFetcher(() => githubResponse()));
  await assert.rejects(service.getInstallationToken(authorizedScope("0", 42)),
    (error: unknown) => error instanceof GitHubAppTokenError && error.code === "invalid_installation_id");
  await assert.rejects(service.getInstallationToken(authorizedScope(1, "1.5")),
    (error: unknown) => error instanceof GitHubAppTokenError && error.code === "invalid_repository_id");

  const missingProvider: GitHubAppAuthenticationCredentialProvider = {
    async getAppAuthenticationCredentials() { throw new Error("credential-secret-value"); }
  };
  const noCredentials = new GitHubAppTokenService(missingProvider, { fetchImpl: makeFetcher(() => githubResponse()) });
  await assert.rejects(noCredentials.getInstallationToken(authorizedScope(1, 2)),
    (error: unknown) => error instanceof GitHubAppTokenError && error.code === "credentials_unavailable" &&
      !error.message.includes("credential-secret-value"));
  const invalidCredentials = { ...credentials, privateKeyPem: "PRIVATE KEY SECRET MATERIAL" };
  const invalidKeyService = tokenService(invalidCredentials, makeFetcher(() => githubResponse()));
  await assert.rejects(invalidKeyService.getInstallationToken(authorizedScope(1, 2)),
    (error: unknown) => error instanceof GitHubAppTokenError && error.code === "credentials_unavailable" &&
      !error.message.includes(invalidCredentials.privateKeyPem));
});

test("revalidates RSA strength immediately before signing", async () => {
  const weak = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  let requests = 0;
  const weakProvider: GitHubAppAuthenticationCredentialProvider = {
    async getAppAuthenticationCredentials() { return { appId: 123456, privateKeyPem: weak.privateKey }; }
  };
  const service = new GitHubAppTokenService(weakProvider, {
    fetchImpl: (async () => { requests++; return githubResponse(); }) as typeof fetch
  });
  await assert.rejects(service.getInstallationToken(authorizedScope(1, 42)),
    (error: unknown) => error instanceof GitHubAppTokenError && error.code === "credentials_unavailable" &&
      !error.message.includes(weak.privateKey));
  assert.equal(requests, 0);
});

test("token minting retrieves only App authentication credentials, never webhook credentials", async () => {
  const { credentials } = credentialFixture();
  let webhookReads = 0;
  const purposeSeparatedProvider = {
    async getAppAuthenticationCredentials() {
      return { appId: credentials.appId, privateKeyPem: credentials.privateKeyPem };
    },
    async getWebhookVerificationSecret() {
      webhookReads++;
      throw new Error("webhook secret must not be requested");
    }
  };
  const service = new GitHubAppTokenService(purposeSeparatedProvider, {
    fetchImpl: makeFetcher(() => githubResponse()),
    now: () => FIXED_NOW
  });
  await service.getInstallationToken(authorizedScope(1, 42));
  assert.equal(webhookReads, 0);
});

test("caches per installation and repository, refreshes before expiry, and reuses concurrent requests", async () => {
  const { credentials } = credentialFixture();
  let now = FIXED_NOW;
  let calls = 0;
  let release!: (response: Response) => void;
  const firstResponse = new Promise<Response>((resolve) => { release = resolve; });
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls++;
    if (calls === 1) return firstResponse;
    const requestedRepositoryId = (JSON.parse(String(init?.body)) as { repository_ids: number[] }).repository_ids[0];
    return githubResponse(now, { expiresInMs: 60 * 60_000, repositoryId: requestedRepositoryId });
  }) as typeof fetch;
  const service = tokenService(credentials, fetchImpl, { now: () => now });
  const first = service.getInstallationToken(authorizedScope(77, 42));
  const concurrent = service.getInstallationToken(authorizedScope(77, 42));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release(githubResponse(now, { expiresInMs: 90_000 }));
  const [token1, token2] = await Promise.all([first, concurrent]);
  assert.equal(token1.token, token2.token);
  assert.equal(calls, 1);
  assert.equal((await service.getInstallationToken(authorizedScope(77, 42))).token, token1.token);
  assert.equal(calls, 1);
  assert.notEqual((await service.getInstallationToken(authorizedScope(77, 43))).token, token1.token);
  assert.equal(calls, 2);
  now += 31_000;
  assert.notEqual((await service.getInstallationToken(authorizedScope(77, 42))).token, token1.token);
  assert.equal(calls, 3);
});

test("cache entries are isolated by installation and immutable repository ID", async () => {
  const { credentials } = credentialFixture();
  let calls = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls++;
    const repositoryId = (JSON.parse(String(init?.body)) as { repository_ids: number[] }).repository_ids[0];
    return githubResponse(FIXED_NOW, { repositoryId });
  }) as typeof fetch;
  const service = tokenService(credentials, fetchImpl);
  const firstInstallation = await service.getInstallationToken(authorizedScope(77, 42));
  const secondInstallation = await service.getInstallationToken(authorizedScope(78, 42));
  const secondRepository = await service.getInstallationToken(authorizedScope(77, 43));
  assert.notEqual(firstInstallation.token, secondInstallation.token);
  assert.notEqual(firstInstallation.token, secondRepository.token);
  assert.equal(calls, 3);
  await service.getInstallationToken(authorizedScope(77, 42));
  await service.getInstallationToken(authorizedScope(78, 42));
  await service.getInstallationToken(authorizedScope(77, 43));
  assert.equal(calls, 3);
});

test("bounded cache evicts least-recently-used live entries after removing expired entries", async () => {
  const { credentials } = credentialFixture();
  assert.throws(() => new GitHubAppTokenService(provider(credentials), {
    fetchImpl: makeFetcher(() => githubResponse()), maxCacheEntries: 0
  }), /cache size/);
  assert.throws(() => new GitHubAppTokenService(provider(credentials), {
    fetchImpl: makeFetcher(() => githubResponse()), maxCacheEntries: 1025
  }), /cache size/);
  let now = FIXED_NOW;
  let calls = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls++;
    const repositoryId = (JSON.parse(String(init?.body)) as { repository_ids: number[] }).repository_ids[0];
    return githubResponse(now, { repositoryId });
  }) as typeof fetch;
  const service = tokenService(credentials, fetchImpl, { maxCacheEntries: 2, now: () => now });
  await service.getInstallationToken(authorizedScope(1, 42));
  await service.getInstallationToken(authorizedScope(1, 43));
  await service.getInstallationToken(authorizedScope(1, 42)); // makes 43 the LRU entry
  await service.getInstallationToken(authorizedScope(1, 44)); // evicts 43
  await service.getInstallationToken(authorizedScope(1, 42));
  assert.equal(calls, 3);
  await service.getInstallationToken(authorizedScope(1, 43));
  assert.equal(calls, 4);
});

test("expired cache entries are removed before inserting new tokens", async () => {
  const { credentials } = credentialFixture();
  let now = FIXED_NOW;
  let calls = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls++;
    const repositoryId = (JSON.parse(String(init?.body)) as { repository_ids: number[] }).repository_ids[0];
    const expiresInMs = repositoryId === 42 ? 61_000 : 60 * 60_000;
    return githubResponse(now, { repositoryId, expiresInMs });
  }) as typeof fetch;
  const service = tokenService(credentials, fetchImpl, { maxCacheEntries: 2, now: () => now });
  await service.getInstallationToken(authorizedScope(1, 42));
  await service.getInstallationToken(authorizedScope(1, 43));
  await service.getInstallationToken(authorizedScope(1, 42)); // keep the soon-to-expire entry most-recently used
  now += 62_000;
  await service.getInstallationToken(authorizedScope(1, 44)); // expired 42 is purged before capacity eviction
  await service.getInstallationToken(authorizedScope(1, 43)); // still cached
  assert.equal(calls, 3);
});

test("invalidating an installation clears cached tokens and fences in-flight minting", async () => {
  const { credentials } = credentialFixture();
  let calls = 0;
  const service = tokenService(credentials, makeFetcher(() => { calls++; return githubResponse(); }));
  await service.getInstallationToken(authorizedScope(77, 42));
  service.invalidate(77);
  await service.getInstallationToken(authorizedScope(77, 42));
  assert.equal(calls, 2);

  let release!: (response: Response) => void;
  const waiting = new Promise<Response>((resolve) => { release = resolve; });
  const inFlightService = tokenService(credentials, (async () => waiting) as typeof fetch);
  const pending = inFlightService.getInstallationToken(authorizedScope(88, 42));
  await new Promise<void>((resolve) => setImmediate(resolve));
  inFlightService.invalidate(88);
  release(githubResponse());
  await assert.rejects(pending, (error: unknown) => error instanceof GitHubAppTokenError && error.code === "token_invalidated");
});

test("rejects a token scoped to another repository, broader permissions, and expired or too-short expiry", async () => {
  const { credentials } = credentialFixture();
  const cases: Array<{ response: () => Response; code: string }> = [
    { response: () => githubResponse(FIXED_NOW, { repositoryId: 99 }), code: "invalid_github_response" },
    { response: () => githubResponse(FIXED_NOW, { permissions: { ...GITHUB_APP_INSTALLATION_PERMISSIONS, administration: "write" } }), code: "invalid_github_response" },
    { response: () => githubResponse(FIXED_NOW, { expiresInMs: 30_000 }), code: "token_expired_or_too_short" },
    { response: () => githubResponse(FIXED_NOW, { expiresInMs: -1 }), code: "token_expired_or_too_short" }
  ];
  for (const scenario of cases) {
    const service = tokenService(credentials, makeFetcher(scenario.response));
    await assert.rejects(service.getInstallationToken(authorizedScope(77, 42)),
      (error: unknown) => error instanceof GitHubAppTokenError && error.code === scenario.code);
  }
});

test("maps GitHub authentication, authorization, not-found, rate-limit, and server failures safely", async () => {
  const { credentials } = credentialFixture();
  const cases = [
    { status: 401, code: "github_unauthorized" },
    { status: 403, code: "github_forbidden" },
    { status: 404, code: "github_not_found" },
    { status: 429, code: "rate_limited" },
    { status: 503, code: "github_unavailable" }
  ] as const;
  for (const scenario of cases) {
    const service = tokenService(credentials, makeFetcher(() => new Response("private-token-body", {
      status: scenario.status,
      headers: scenario.status === 429 ? { "retry-after": "12" } : undefined
    })));
    await assert.rejects(service.getInstallationToken(authorizedScope(77, 42)),
      (error: unknown) => error instanceof GitHubAppTokenError && error.code === scenario.code &&
        !error.message.includes("private-token-body") &&
        (scenario.status !== 429 || error.retryAfterMs === 12_000));
  }
});

test("bounds malformed response reads and times out while reading a stalled response body", async () => {
  const { credentials } = credentialFixture();
  const malformed = tokenService(credentials, makeFetcher(() => new Response("not-json", { status: 201 })));
  await assert.rejects(malformed.getInstallationToken(authorizedScope(1, 42)),
    (error: unknown) => error instanceof GitHubAppTokenError && error.code === "invalid_github_response");

  const oversizedBody = JSON.stringify({
    token: "x".repeat(65 * 1024), expires_at: new Date(FIXED_NOW + 3_600_000).toISOString(),
    permissions: GITHUB_APP_INSTALLATION_PERMISSIONS, repositories: [{ id: 42 }]
  });
  const oversized = tokenService(credentials, makeFetcher(() => new Response(oversizedBody, { status: 201 })));
  await assert.rejects(oversized.getInstallationToken(authorizedScope(1, 42)),
    (error: unknown) => error instanceof GitHubAppTokenError && error.code === "invalid_github_response");

  const stalledResponse = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("{")); }
  }), { status: 201 });
  const stalled = tokenService(credentials, makeFetcher(() => stalledResponse), { timeoutMs: 10 });
  await assert.rejects(stalled.getInstallationToken(authorizedScope(1, 42)),
    (error: unknown) => error instanceof GitHubAppTokenError && error.code === "request_timeout");
});

test("network failures are safe and no token service logs credential or token material", async () => {
  const { credentials } = credentialFixture();
  const tokenSecret = `ghs_${randomBytes(32).toString("hex")}`;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const logs: unknown[][] = [];
  console.log = (...args: unknown[]) => { logs.push(args); };
  console.warn = (...args: unknown[]) => { logs.push(args); };
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const service = tokenService(credentials, (async () => new Response(tokenSecret, { status: 500 })) as typeof fetch);
    await assert.rejects(service.getInstallationToken(authorizedScope(77, 42)),
      (error: unknown) => error instanceof GitHubAppTokenError && error.code === "github_unavailable" &&
        !error.message.includes(tokenSecret) && !error.message.includes(credentials.privateKeyPem));

    const offline = tokenService(credentials, (async () => { throw new Error(credentials.privateKeyPem); }) as typeof fetch);
    await assert.rejects(offline.getInstallationToken(authorizedScope(77, 42)),
      (error: unknown) => error instanceof GitHubAppTokenError && error.code === "network_failure" &&
        !error.message.includes(credentials.privateKeyPem));
    assert.equal(logs.length, 0);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
});
