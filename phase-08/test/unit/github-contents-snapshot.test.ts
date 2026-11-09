import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { ContentsReadInstallationTokenService, CONTENTS_READ_TOKEN_PERMISSIONS, gitBlobSha } from "../../src/github/contents-read-token-service.js";
import { GitHubTrustedRepositorySnapshotReader, RepositorySnapshotError } from "../../src/github/trusted-repository-snapshot-reader.js";

const org = "33333333-3333-4333-8333-333333333333";
const project = "11111111-1111-4111-8111-111111111111";
const user = "44444444-4444-4444-8444-444444444444";
const binding = "55555555-5555-4555-8555-555555555555";
const installationRecord = "66666666-6666-4666-8666-666666666666";
const repoId = "987654321012345";
const installId = "1234567890123";
const content = "metrics: []\n# cloudpilot:metrics\n";
const bytes = Buffer.from(content, "utf8");
const blobSha = gitBlobSha(bytes);
const commitSha = "a".repeat(40);
const rootTree = "b".repeat(40);
const configTree = "c".repeat(40);
const observabilityTree = "d".repeat(40);

function appCredentials() {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  return { async getAppAuthenticationCredentials() { return { appId: 22, privateKeyPem: pair.privateKey }; } };
}

function tokenResponse(permissions: Record<string, string> = { contents: "read", metadata: "read" }) {
  return new Response(JSON.stringify({
    token: "short-lived-test-token",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    permissions,
    repositories: [{ id: repoId }]
  }), { status: 201 });
}

function authorizedDb(options: {
  memberRole?: string; member?: boolean; project?: boolean; adoption?: boolean; bindingActive?: boolean;
  installationActive?: boolean; repositoryId?: string; installationId?: string; bindingInstallationRecordId?: string; owner?: string; name?: string;
} = {}) {
  const calls: string[] = [];
  const tx = {
    organizationMember: { async findFirst(args: any) { calls.push("membership"); assert.equal(args.where.organizationId, org); return options.member === false ? null : { role: options.memberRole ?? "operator" }; } },
    project: { async findFirst(args: any) { calls.push("project"); assert.equal(args.where.tenantId, "entra-tenant"); return options.project === false ? null : { id: project }; } },
    projectOrganizationAdoption: { async findFirst() { calls.push("adoption"); return options.adoption === false ? null : { id: "adoption" }; } },
    projectGitHubRepository: { async findFirst(args: any) {
      calls.push("binding");
      assert.equal(args.where.id, binding);
      assert.equal(args.where.installationRecordId, installationRecord);
      if (options.bindingActive === false || options.installationActive === false) return null;
      return {
        id: binding, githubRepositoryId: BigInt(options.repositoryId ?? repoId), installationRecordId: options.bindingInstallationRecordId ?? installationRecord,
        ownerLogin: options.owner ?? "octo", repositoryName: options.name ?? "sample",
        installation: { id: installationRecord, githubInstallationId: BigInt(options.installationId ?? installId), organizationId: org, status: "active" }
      };
    } }
  };
  return { calls, prisma: { ...tx, async $transaction(callback: (tx: any) => Promise<any>) { return callback(tx); } } as any };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    identityUserId: user, tenantId: "entra-tenant", organizationId: org, projectId: project,
    repositoryBindingId: binding, installationRecordId: installationRecord,
    immutableRepositoryId: repoId, ownerLogin: "octo", repositoryName: "sample",
    filePath: "config/observability/metrics.yaml", ...overrides
  } as any;
}

function githubFetcher(options: { repositoryId?: string | number; mode?: string; type?: string; missing?: boolean; blobContent?: string; malformed?: boolean; advancedHead?: boolean } = {}) {
  const urls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); urls.push(url);
    assert.equal(init?.redirect, "error");
    if (url.includes("/app/installations/")) return tokenResponse();
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer short-lived-test-token");
    if (url.endsWith(`/repositories/${repoId}`)) return new Response(JSON.stringify({
      id: options.repositoryId ?? Number(repoId), name: "sample", owner: { login: "octo" }, default_branch: "main", archived: false, disabled: false
    }));
    if (url.includes("/commits/main")) return new Response(JSON.stringify({
      sha: options.advancedHead && urls.filter((seen) => seen.includes("/commits/main")).length > 1 ? "c".repeat(40) : commitSha,
      commit: { tree: { sha: rootTree }
    } }));
    if (url.endsWith(`/git/trees/${rootTree}`)) return new Response(JSON.stringify({ tree: [{ path: "config", mode: "040000", type: "tree", sha: configTree }] }));
    if (url.endsWith(`/git/trees/${configTree}`)) return new Response(JSON.stringify({ tree: [{ path: "observability", mode: "040000", type: "tree", sha: observabilityTree }] }));
    if (url.endsWith(`/git/trees/${observabilityTree}`)) {
      if (options.missing) return new Response(JSON.stringify({ tree: [] }));
      return new Response(JSON.stringify({ tree: [{ path: "metrics.yaml", mode: options.mode ?? "100644", type: options.type ?? "blob", sha: blobSha }] }));
    }
    if (url.endsWith(`/git/blobs/${blobSha}`)) {
      if (options.malformed) return new Response("{");
      const value = options.blobContent ?? content;
      const data = Buffer.from(value).toString("base64");
      return new Response(JSON.stringify({ sha: blobSha, encoding: "base64", size: Buffer.byteLength(value), content: data }));
    }
    throw new Error("Unexpected mock URL");
  }) as typeof fetch;
  return { fetcher, urls };
}

function makeReader(options: Parameters<typeof authorizedDb>[0] = {}, fetchOptions: Parameters<typeof githubFetcher>[0] = {}, timeout = 100) {
  const db = authorizedDb(options);
  const github = githubFetcher(fetchOptions);
  const tokenService = new ContentsReadInstallationTokenService(appCredentials(), github.fetcher, timeout);
  return { ...db, ...github, reader: new GitHubTrustedRepositorySnapshotReader(db.prisma, tokenService, github.fetcher, timeout) };
}

test("contents token uses only contents:read and metadata:read with repository-scoped IDs", async () => {
  let body = "";
  const fetcher = (async (_url, init) => { body = String(init?.body); return tokenResponse(); }) as typeof fetch;
  const service = new ContentsReadInstallationTokenService(appCredentials(), fetcher);
  assert.equal(await service.token(installId, repoId), "short-lived-test-token");
  assert.deepEqual(CONTENTS_READ_TOKEN_PERMISSIONS, { contents: "read", metadata: "read" });
  assert.equal(body, `{"repository_ids":[${repoId}],"permissions":{"contents":"read","metadata":"read"}}`);
  assert.doesNotMatch(body, /pull_requests|workflows|administration|write/i);
});

test("contents token cache isolates installations and repositories, expires entries, and fences invalidated requests", async () => {
  let now = Date.now();
  let calls = 0;
  let release!: (response: Response) => void;
  let block = false;
  const fetcher = (async (_url, init) => {
    calls++;
    const posted = JSON.parse(String(init?.body)) as { repository_ids: number[] };
    if (block) return new Promise<Response>((resolve) => { release = resolve; });
    return new Response(JSON.stringify({
      token: `token-${calls}`, expires_at: new Date(now + 3_600_000).toISOString(),
      permissions: { contents: "read", metadata: "read" }, repositories: [{ id: posted.repository_ids[0] }]
    }), { status: 201 });
  }) as typeof fetch;
  const service = new ContentsReadInstallationTokenService(appCredentials(), fetcher, 100, () => now);
  const first = await service.token("7", "8");
  assert.equal(await service.token("7", "8"), first);
  await service.token("7", "9");
  await service.token("10", "8");
  assert.equal(calls, 3);
  now += 3_700_000;
  await service.token("7", "8");
  assert.equal(calls, 4);
  block = true;
  const pending = service.token("7", "11");
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  service.invalidate("7");
  release(new Response(JSON.stringify({
    token: "stale-token", expires_at: new Date(now + 3_600_000).toISOString(),
    permissions: { contents: "read", metadata: "read" }, repositories: [{ id: 11 }]
  }), { status: 201 }));
  await assert.rejects(pending);
});

test("concurrent identical contents-token requests are coalesced", async () => {
  let calls = 0;
  let release!: (response: Response) => void;
  const fetcher = (async () => {
    calls++;
    return new Promise<Response>((resolve) => { release = resolve; });
  }) as typeof fetch;
  const service = new ContentsReadInstallationTokenService(appCredentials(), fetcher);
  const one = service.token("71", "81");
  const two = service.token("71", "81");
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release(new Response(JSON.stringify({
    token: "short-lived-test-token", expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    permissions: { contents: "read", metadata: "read" }, repositories: [{ id: "81" }]
  }), { status: 201 }));
  assert.deepEqual(await Promise.all([one, two]), ["short-lived-test-token", "short-lived-test-token"]);
  assert.equal(calls, 1);
});

test("contents token cache remains bounded when many repository scopes are requested", async () => {
  let calls = 0;
  const fetcher = (async (_url, init) => {
    calls++;
    const posted = JSON.parse(String(init?.body)) as { repository_ids: number[] };
    return new Response(JSON.stringify({
      token: `bounded-${calls}`, expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: { contents: "read", metadata: "read" }, repositories: [{ id: posted.repository_ids[0] }]
    }), { status: 201 });
  }) as typeof fetch;
  const service = new ContentsReadInstallationTokenService(appCredentials(), fetcher);
  for (let id = 1; id <= 130; id++) await service.token("13", String(id));
  await service.token("13", "1");
  assert.equal(calls, 131);
});

test("credential-provider failures after invalidation fail closed without exposing credentials", async () => {
  let unavailable = false;
  const provider = { async getAppAuthenticationCredentials() {
    if (unavailable) throw new Error("private key content");
    return appCredentials().getAppAuthenticationCredentials();
  } };
  const fetcher = (async () => tokenResponse()) as typeof fetch;
  const service = new ContentsReadInstallationTokenService(provider, fetcher);
  await service.token(installId, repoId);
  unavailable = true;
  service.invalidate(installId);
  await assert.rejects(service.token(installId, repoId), (error: unknown) => error instanceof Error &&
    error.message === "A read-only GitHub repository token could not be obtained." && !error.message.includes("private key"));
});

test("metadata-only token response cannot authorize a contents-read capability", async () => {
  const fetcher = (async () => tokenResponse({ metadata: "read" })) as typeof fetch;
  const service = new ContentsReadInstallationTokenService(appCredentials(), fetcher);
  await assert.rejects(service.token(installId, repoId), (error: unknown) => error instanceof Error && error.message === "A read-only GitHub repository token could not be obtained.");
});

test("authorized snapshot resolves default branch and reads the file through the pinned commit tree", async () => {
  const h = makeReader();
  const logged: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  let snapshot;
  try { snapshot = await h.reader.readSnapshot(request()); }
  finally { console.log = originalLog; console.error = originalError; }
  assert.equal(snapshot.baseRef, "main");
  assert.equal(snapshot.baseCommitSha, commitSha);
  assert.equal(snapshot.immutableRepositoryId, repoId);
  assert.equal(snapshot.file.content, content);
  assert.equal(snapshot.file.contentBase64, bytes.toString("base64"));
  assert.equal(snapshot.file.blobSha, blobSha);
  assert.equal(snapshot.file.mode, "100644");
  assert.equal(snapshot.file.fileType, "blob");
  assert.equal(h.urls.some((url) => url.includes(`/commits/main`)), true);
  assert.equal(h.urls.some((url) => url.includes(`/git/trees/${rootTree}`)), true);
  assert.equal(h.urls.some((url) => url.includes(`/git/blobs/${blobSha}`)), true);
  assert.equal(h.calls.filter((call) => call === "membership").length, 4);
  assert.equal(h.urls.some((url) => url.includes("refs/heads")), false);
  assert.equal(logged.some((line) => line.includes("short-lived-test-token") || line.includes(content)), false);
});

test("snapshot fails closed when the default branch advances during the read", async () => {
  const h = makeReader({}, { advancedHead: true });
  await assert.rejects(h.reader.readSnapshot(request()), (error: unknown) =>
    error instanceof RepositorySnapshotError && error.code === "binding_changed");
});

test("repository identity is rechecked after resolving the branch commit", async () => {
  const db = authorizedDb();
  const github = githubFetcher();
  let repositoryLookups = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith(`/repositories/${repoId}`) && ++repositoryLookups === 2) {
      return new Response(JSON.stringify({
        id: repoId, name: "sample", owner: { login: "transferred-owner" }, default_branch: "main"
      }));
    }
    return github.fetcher(input, init);
  }) as typeof fetch;
  const tokens = new ContentsReadInstallationTokenService(appCredentials(), fetcher);
  const reader = new GitHubTrustedRepositorySnapshotReader(db.prisma, tokens, fetcher);

  await assert.rejects(reader.readSnapshot(request()), (error: unknown) =>
    error instanceof RepositorySnapshotError && error.code === "binding_changed");
  assert.equal(repositoryLookups, 2);
  assert.equal(github.urls.some((url) => url.includes("/git/trees/") || url.includes("/git/blobs/")), false);
});

test("viewer can read only when active organization integration permission is confirmed", async () => {
  const h = makeReader({ memberRole: "viewer" });
  const snapshot = await h.reader.readSnapshot(request());
  assert.equal(snapshot.file.content, content);
});

test("membership revoked after commit resolution is rechecked before any tree or blob read", async () => {
  let membershipCalls = 0;
  const base = authorizedDb();
  const tx = base.prisma;
  tx.organizationMember.findFirst = async () => (++membershipCalls === 1 ? { role: "operator" } : null);
  const github = githubFetcher();
  const tokens = new ContentsReadInstallationTokenService(appCredentials(), github.fetcher);
  const reader = new GitHubTrustedRepositorySnapshotReader(tx, tokens, github.fetcher);
  await assert.rejects(reader.readSnapshot(request()), RepositorySnapshotError);
  assert.equal(github.urls.some((url) => url.includes("/git/trees/") || url.includes("/git/blobs/")), false);
});

test("authorization is rechecked and denies inactive membership, project, adoption, binding, installation and mismatched IDs before GitHub", async () => {
  const denied: Parameters<typeof makeReader>[0][] = [
    { member: false }, { memberRole: "ownerless" }, { project: false }, { adoption: false },
    { bindingActive: false }, { installationActive: false }, { repositoryId: "111111" },
    { bindingInstallationRecordId: "77777777-7777-4777-8777-777777777777" }
  ];
  for (const option of denied) {
    const h = makeReader(option);
    await assert.rejects(h.reader.readSnapshot(request()), RepositorySnapshotError);
    assert.equal(h.urls.length, 0);
  }
});

test("request selectors cannot substitute repository identity, owner, or unsupported paths", async () => {
  const h = makeReader();
  await assert.rejects(h.reader.readSnapshot(request({ filePath: "../../secrets" })), RepositorySnapshotError);
  assert.equal(h.urls.length, 0);
  const mismatch = makeReader();
  await assert.rejects(mismatch.reader.readSnapshot(request({ immutableRepositoryId: "123" })), RepositorySnapshotError);
  assert.equal(mismatch.urls.length, 0);
  const githubMismatch = makeReader({}, { repositoryId: "123" });
  await assert.rejects(githubMismatch.reader.readSnapshot(request()), RepositorySnapshotError);
  assert.equal(githubMismatch.urls.some((url) => url.includes("/git/blobs/")), false);
});

test("tree inspection rejects symlinks, submodules, and executable files", async () => {
  for (const options of [
    { mode: "120000", type: "blob" }, { mode: "160000", type: "commit" }, { mode: "100755", type: "blob" }
  ]) {
    const h = makeReader({}, options);
    await assert.rejects(h.reader.readSnapshot(request()), RepositorySnapshotError);
  }
});

test("an absent allowlisted file is represented as a safe create snapshot", async () => {
  const h = makeReader({}, { missing: true });
  const snapshot = await h.reader.readSnapshot(request());
  assert.equal(snapshot.file.content, null);
  assert.equal(snapshot.file.contentBase64, null);
  assert.equal(snapshot.file.blobSha, null);
  assert.equal(snapshot.file.mode, null);
  assert.equal(snapshot.file.fileType, null);
  assert.equal(snapshot.file.isRegularFile, true);
});

test("blob bounds, encoding, Git blob digest, response JSON, timeout, redirects and network failures fail closed", async () => {
  const oversized = makeReader({}, { blobContent: "x".repeat(512 * 1024 + 1) });
  await assert.rejects(oversized.reader.readSnapshot(request()), RepositorySnapshotError);
  const malformed = makeReader({}, { malformed: true });
  await assert.rejects(malformed.reader.readSnapshot(request()), RepositorySnapshotError);

  const db = authorizedDb();
  let requestCount = 0;
  const badDigestFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestCount++;
    const url = String(input);
    if (url.includes("/app/installations/")) return tokenResponse();
    if (url.endsWith(`/repositories/${repoId}`)) return new Response(JSON.stringify({ id: Number(repoId), name: "sample", owner: { login: "octo" }, default_branch: "main" }));
    if (url.includes("/commits/main")) return new Response(JSON.stringify({ sha: commitSha, commit: { tree: { sha: rootTree } } }));
    if (url.endsWith(`/git/trees/${rootTree}`)) return new Response(JSON.stringify({ tree: [{ path: "config", mode: "040000", type: "tree", sha: configTree }] }));
    if (url.endsWith(`/git/trees/${configTree}`)) return new Response(JSON.stringify({ tree: [{ path: "observability", mode: "040000", type: "tree", sha: observabilityTree }] }));
    if (url.endsWith(`/git/trees/${observabilityTree}`)) return new Response(JSON.stringify({ tree: [{ path: "metrics.yaml", mode: "100644", type: "blob", sha: blobSha }] }));
    if (url.endsWith(`/git/blobs/${blobSha}`)) return new Response(JSON.stringify({ sha: "f".repeat(40), encoding: "base64", size: bytes.length, content: bytes.toString("base64") }));
    throw new Error("unexpected");
  }) as typeof fetch;
  const digestReader = new GitHubTrustedRepositorySnapshotReader(db.prisma, new ContentsReadInstallationTokenService(appCredentials(), badDigestFetch), badDigestFetch, 100);
  await assert.rejects(digestReader.readSnapshot(request()), RepositorySnapshotError);

  const tokenFetch = (async () => tokenResponse()) as typeof fetch;
  const stalledFetch = (async (_input, init) => {
    if (String(_input).includes("/app/installations/")) return tokenResponse();
    return new Response(new ReadableStream({ start() {} }));
  }) as typeof fetch;
  const stalledDb = authorizedDb();
  const stalledReader = new GitHubTrustedRepositorySnapshotReader(stalledDb.prisma, new ContentsReadInstallationTokenService(appCredentials(), stalledFetch, 15), stalledFetch, 15);
  await assert.rejects(stalledReader.readSnapshot(request()), (error: unknown) => error instanceof RepositorySnapshotError && error.code === "timeout");
  void tokenFetch;

  const networkDb = authorizedDb();
  const networkFetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/app/installations/")) return tokenResponse();
    throw new Error("secret upstream body/token");
  }) as typeof fetch;
  const networkReader = new GitHubTrustedRepositorySnapshotReader(networkDb.prisma, new ContentsReadInstallationTokenService(appCredentials(), networkFetch), networkFetch);
  await assert.rejects(networkReader.readSnapshot(request()), (error: unknown) => error instanceof RepositorySnapshotError && error.code === "network_failure");

  const redirectDb = authorizedDb();
  let redirectMode: RequestRedirect | undefined;
  const redirectFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/app/installations/")) return tokenResponse();
    redirectMode = init?.redirect;
    return new Response("", { status: 302, headers: { location: "https://outside.invalid/secret" } });
  }) as typeof fetch;
  const redirectReader = new GitHubTrustedRepositorySnapshotReader(redirectDb.prisma, new ContentsReadInstallationTokenService(appCredentials(), redirectFetch), redirectFetch);
  await assert.rejects(redirectReader.readSnapshot(request()), RepositorySnapshotError);
  assert.equal(redirectMode, "error");
});

test("GitHub 401, 403, 404, rate-limit and server errors return fixed safe failures", async () => {
  for (const status of [401, 403, 404, 429, 500, 502, 503, 504]) {
    const db = authorizedDb();
    const fetcher = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/app/installations/")) return tokenResponse();
      return new Response("raw token/private body must not escape", { status });
    }) as typeof fetch;
    const reader = new GitHubTrustedRepositorySnapshotReader(db.prisma, new ContentsReadInstallationTokenService(appCredentials(), fetcher), fetcher);
    await assert.rejects(reader.readSnapshot(request()), (error: unknown) => {
      assert.ok(error instanceof RepositorySnapshotError);
      assert.doesNotMatch(error.message, /raw token|private body/);
      return true;
    });
  }
});
