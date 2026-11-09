import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { GitHubInstallationToken } from "../../src/github/app-token-service.js";
import { GITHUB_APP_INSTALLATION_PERMISSIONS, GITHUB_ARTIFACT_WRITER_PERMISSIONS, GITHUB_DRAFT_PR_PERMISSIONS } from "../../src/github/app-token-service.js";
import {
  ArtifactGitHubClientError,
  ArtifactOnlyGitHubClient,
  DEFAULT_MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  githubMutationRequestFingerprint,
  isTrustedGitHubMutationRejectionEvidence,
  type GitHubRepositoryIdentity
} from "../../src/github/artifact-only-github-client.js";

const REPOSITORY_ID = "9007199254740993";
const INSTALLATION_ID = "9223372036854775000";
const BASE_SHA = "1".repeat(40);
const ROOT_TREE_SHA = "2".repeat(40);
const CONFIG_TREE_SHA = "3".repeat(40);
const OBSERVABILITY_TREE_SHA = "4".repeat(40);
const FILE_BLOB_SHA = "5".repeat(40);
const NEW_TREE_SHA = "6".repeat(40);
const NEW_COMMIT_SHA = "7".repeat(40);
const FILE_PATH = "config/observability/metrics.yaml";
const FILE_CONTENT = "metrics:\n  - request_count\n";
const MUTATION_REPO_TARGET = "https://api.github.com/repos/acme/cloudpilot-demo";

function correlation(stage: import("../../src/github/artifact-only-github-client.js").GitHubMutationStage,
  suffix: string, body: unknown, method: "POST" | "PATCH" = "POST"): import("../../src/github/artifact-only-github-client.js").GitHubMutationCorrelation {
  const serialized = JSON.stringify(body);
  return Object.freeze({ executionId: "execution-fixture", attempt: 2, operationKey: `${stage}:fixture`, stage,
    requestHash: "a".repeat(64), requestFingerprint: githubMutationRequestFingerprint(method,
      `${MUTATION_REPO_TARGET}${suffix}`, serialized) });
}

function token(repositoryId = REPOSITORY_ID, expiresAt = new Date(Date.now() + 60_000).toISOString(),
  permissions: GitHubInstallationToken["permissions"] = GITHUB_APP_INSTALLATION_PERMISSIONS): GitHubInstallationToken {
  return Object.freeze({ token: "ghs-test-token-never-log", expiresAt, installationId: INSTALLATION_ID, repositoryId,
    permissions });
}

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function json(value: unknown, status = 200): Response {
  return response(JSON.stringify(value), status);
}

function repositoryBody(id = REPOSITORY_ID): string {
  return `{"id":${id},"name":"cloudpilot-demo","owner":{"login":"acme"},"default_branch":"main","archived":false,"disabled":false}`;
}

function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`, "utf8").update(bytes).digest("hex");
}

test("resolves only the token's immutable repository ID without Number rounding", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new ArtifactOnlyGitHubClient(token(), {
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return response(repositoryBody());
    }) as typeof fetch
  });

  const result = await client.resolveRepository();
  assert.deepEqual(result, { id: REPOSITORY_ID, owner: "acme", name: "cloudpilot-demo", defaultBranch: "main" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `https://api.github.com/repositories/${REPOSITORY_ID}`);
  assert.equal(calls[0]!.init.redirect, "error");
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer ghs-test-token-never-log");
  assert.equal(Object.isFrozen(result), true);
});

test("contents-only and pull-request-only clients cannot cross their permission boundary", async () => {
  let writes = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(`/repositories/${REPOSITORY_ID}`)) return response(repositoryBody());
    if (init?.method !== "GET") writes++;
    return json({ ref: "refs/heads/main", object: { type: "commit", sha: BASE_SHA } });
  }) as typeof fetch;
  const contents = new ArtifactOnlyGitHubClient(token(REPOSITORY_ID, undefined, GITHUB_ARTIFACT_WRITER_PERMISSIONS), { fetchImpl });
  const contentsRepo = await contents.resolveRepository();
  await assert.rejects(contents.createDraftPullRequest(contentsRepo,
    { head: "safe/branch", base: "main", title: "title", body: "body" },
    correlation("pull_request", "/pulls", { head: "safe/branch", base: "main", title: "title", body: "body", draft: true })),
  (error: unknown) => error instanceof ArtifactGitHubClientError && error.code === "invalid_token");

  const pullRequests = new ArtifactOnlyGitHubClient(token(REPOSITORY_ID, undefined, GITHUB_DRAFT_PR_PERMISSIONS), { fetchImpl });
  const prRepo = await pullRequests.resolveRepository();
  await assert.rejects(pullRequests.createBranch(prRepo, "safe/branch", BASE_SHA,
    correlation("branch", "/git/refs", { ref: "refs/heads/safe/branch", sha: BASE_SHA })),
    (error: unknown) => error instanceof ArtifactGitHubClientError && error.code === "invalid_token");
  await assert.rejects(pullRequests.createBlob(prRepo, new TextEncoder().encode("x"),
    correlation("blob", "/git/blobs", { content: Buffer.from("x").toString("base64"), encoding: "base64" })),
    (error: unknown) => error instanceof ArtifactGitHubClientError && error.code === "invalid_token");
  assert.equal(writes, 0);
});

test("rejects mismatched or malformed repository identity and inaccessible repositories safely", async () => {
  for (const fetchImpl of [
    (async () => response(repositoryBody("9007199254740992"))) as typeof fetch,
    (async () => response("{bad json")) as typeof fetch,
    (async () => response("GitHub private error details", 404)) as typeof fetch
  ]) {
    const client = new ArtifactOnlyGitHubClient(token(), { fetchImpl });
    await assert.rejects(client.resolveRepository(), ArtifactGitHubClientError);
  }
  const hiddenBodyClient = new ArtifactOnlyGitHubClient(token(), {
    fetchImpl: (async () => response("GitHub private error details and ghs-test-token", 404)) as typeof fetch
  });
  await assert.rejects(hiddenBodyClient.resolveRepository(), (error: unknown) => {
    assert.ok(error instanceof ArtifactGitHubClientError);
    assert.doesNotMatch(error.message, /private error|ghs-test-token/);
    return true;
  });
  const unavailable = new ArtifactOnlyGitHubClient(token(), {
    fetchImpl: (async () => response(`{"id":${REPOSITORY_ID},"name":"cloudpilot-demo","owner":{"login":"acme"},"default_branch":"main","archived":true,"disabled":false}`)) as typeof fetch
  });
  await assert.rejects(unavailable.resolveRepository(), (error: unknown) =>
    error instanceof ArtifactGitHubClientError && error.code === "repository_unavailable");
});

test("rejects unsafe IDs and an expired installation token before network access", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return response(repositoryBody()); }) as typeof fetch;
  assert.throws(() => new ArtifactOnlyGitHubClient({ ...token(), repositoryId: "9007199254740992.0" }, { fetchImpl }), ArtifactGitHubClientError);
  assert.throws(() => new ArtifactOnlyGitHubClient(token(REPOSITORY_ID, new Date(Date.now() - 1).toISOString()), { fetchImpl }),
    (error: unknown) => error instanceof ArtifactGitHubClientError && error.code === "invalid_token");
  assert.equal(calls, 0);
});

test("does not accept caller-forged owner/name objects or identities from another client", async () => {
  let calls = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls++;
    if (String(input).endsWith(`/repositories/${REPOSITORY_ID}`)) return response(repositoryBody());
    return json({ ref: "refs/heads/main", object: { type: "commit", sha: BASE_SHA } });
  }) as typeof fetch;
  const first = new ArtifactOnlyGitHubClient(token(), { fetchImpl });
  const second = new ArtifactOnlyGitHubClient(token(), { fetchImpl });
  const repository = await first.resolveRepository();
  const before = calls;
  await assert.rejects(first.readReference({ ...repository, owner: "attacker" }, "main"), ArtifactGitHubClientError);
  await assert.rejects(second.readReference(repository, "main"), ArtifactGitHubClientError);
  assert.equal(calls, before);
});

test("reads ref, exact commit, tree path and blob bytes using validated Git object identities", async () => {
  const urls: string[] = [];
  const contentBytes = new TextEncoder().encode(FILE_CONTENT);
  const fileSha = gitBlobSha(contentBytes);
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith(`/repositories/${REPOSITORY_ID}`)) return response(repositoryBody());
    if (url.endsWith("/git/ref/heads/main")) return json({ ref: "refs/heads/main", object: { type: "commit", sha: BASE_SHA } });
    if (url.endsWith(`/git/commits/${BASE_SHA}`)) return json({ sha: BASE_SHA, tree: { sha: ROOT_TREE_SHA }, parents: [] });
    if (url.endsWith(`/git/trees/${ROOT_TREE_SHA}`)) return json({ sha: ROOT_TREE_SHA, truncated: false,
      tree: [{ path: "config", mode: "040000", type: "tree", sha: CONFIG_TREE_SHA }] });
    if (url.endsWith(`/git/trees/${CONFIG_TREE_SHA}`)) return json({ sha: CONFIG_TREE_SHA, truncated: false,
      tree: [{ path: "observability", mode: "040000", type: "tree", sha: OBSERVABILITY_TREE_SHA }] });
    if (url.endsWith(`/git/trees/${OBSERVABILITY_TREE_SHA}`)) return json({ sha: OBSERVABILITY_TREE_SHA, truncated: false,
      tree: [{ path: "metrics.yaml", mode: "100644", type: "blob", sha: fileSha }] });
    if (url.endsWith(`/git/blobs/${fileSha}`)) return json({ sha: fileSha, size: contentBytes.byteLength,
      encoding: "base64", content: Buffer.from(contentBytes).toString("base64") });
    throw new Error("unexpected mocked GitHub path");
  }) as typeof fetch;
  const client = new ArtifactOnlyGitHubClient(token(), { fetchImpl });
  const repository = await client.resolveRepository();
  const ref = await client.readReference(repository, "main");
  assert.deepEqual(ref, { name: "main", sha: BASE_SHA });
  const pinnedEntry = await client.resolvePathAtCommit(repository, BASE_SHA, FILE_PATH);
  assert.deepEqual(pinnedEntry, { path: "metrics.yaml", mode: "100644", type: "blob", sha: fileSha });
  const blob = await client.readBlob(repository, fileSha);
  assert.equal(blob.contentBase64, Buffer.from(contentBytes).toString("base64"));
  assert.deepEqual(blob.bytes, contentBytes);
  const mutableCopy = blob.bytes;
  mutableCopy[0] ^= 0xff;
  assert.deepEqual(blob.bytes, contentBytes);
  assert.ok(urls.includes(`https://api.github.com/repos/acme/cloudpilot-demo/git/commits/${BASE_SHA}`));
  assert.equal(urls.some((url) => url.includes("/contents/")), false);
});

test("rejects executable, symlink, submodule, malformed and truncated target trees", async () => {
  for (const leaf of [
    { path: "metrics.yaml", mode: "100755", type: "blob", sha: FILE_BLOB_SHA },
    { path: "metrics.yaml", mode: "120000", type: "blob", sha: FILE_BLOB_SHA },
    { path: "metrics.yaml", mode: "160000", type: "commit", sha: FILE_BLOB_SHA },
    { path: "metrics.yaml", mode: "100644", type: "blob", sha: "bad-sha" }
  ]) {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/repositories/${REPOSITORY_ID}`)) return response(repositoryBody());
      if (url.endsWith(`/git/commits/${BASE_SHA}`)) return json({ sha: BASE_SHA, tree: { sha: ROOT_TREE_SHA }, parents: [] });
      if (url.endsWith(`/git/trees/${ROOT_TREE_SHA}`)) return json({ sha: ROOT_TREE_SHA, truncated: false,
        tree: [{ path: "config", mode: "040000", type: "tree", sha: CONFIG_TREE_SHA }] });
      if (url.endsWith(`/git/trees/${CONFIG_TREE_SHA}`)) return json({ sha: CONFIG_TREE_SHA, truncated: false,
        tree: [{ path: "observability", mode: "040000", type: "tree", sha: OBSERVABILITY_TREE_SHA }] });
      if (url.endsWith(`/git/trees/${OBSERVABILITY_TREE_SHA}`)) return json({ sha: OBSERVABILITY_TREE_SHA, truncated: false, tree: [leaf] });
      throw new Error("unexpected path");
    }) as typeof fetch;
    const client = new ArtifactOnlyGitHubClient(token(), { fetchImpl });
    const repository = await client.resolveRepository();
    await assert.rejects(client.resolvePathAtCommit(repository, BASE_SHA, FILE_PATH), ArtifactGitHubClientError);
  }

  const truncated = new ArtifactOnlyGitHubClient(token(), {
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/repositories/${REPOSITORY_ID}`)) return response(repositoryBody());
      if (url.endsWith(`/git/commits/${BASE_SHA}`)) return json({ sha: BASE_SHA, tree: { sha: ROOT_TREE_SHA }, parents: [] });
      return json({ sha: ROOT_TREE_SHA, truncated: true, tree: [] });
    }) as typeof fetch
  });
  const repository = await truncated.resolveRepository();
  await assert.rejects(truncated.resolvePathAtCommit(repository, BASE_SHA, FILE_PATH), (error: unknown) =>
    error instanceof ArtifactGitHubClientError && error.code === "invalid_response");
});

test("rejects blob size, encoding, and Git object digest mismatches", async () => {
  const bytes = new TextEncoder().encode(FILE_CONTENT);
  const correctSha = gitBlobSha(bytes);
  for (const body of [
    { sha: correctSha, size: bytes.byteLength + 1, encoding: "base64", content: Buffer.from(bytes).toString("base64") },
    { sha: correctSha, size: bytes.byteLength, encoding: "utf-8", content: Buffer.from(bytes).toString("base64") },
    { sha: "8".repeat(40), size: bytes.byteLength, encoding: "base64", content: Buffer.from(bytes).toString("base64") }
  ]) {
    const client = new ArtifactOnlyGitHubClient(token(), { fetchImpl: (async (input: RequestInfo | URL) =>
      String(input).endsWith(`/repositories/${REPOSITORY_ID}`) ? response(repositoryBody()) : json(body)) as typeof fetch });
    const repository = await client.resolveRepository();
    await assert.rejects(client.readBlob(repository, correctSha), ArtifactGitHubClientError);
  }
});

test("tree and commit writes preserve the verified base tree, approved path, mode, and exact sole parent", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const bytes = new TextEncoder().encode(FILE_CONTENT);
  const blobSha = gitBlobSha(bytes);
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const request = init ?? {};
    calls.push({ url, init: request });
    if (url.endsWith(`/repositories/${REPOSITORY_ID}`)) return response(repositoryBody());
    if (url.endsWith(`/git/commits/${BASE_SHA}`) && request.method === "GET")
      return json({ sha: BASE_SHA, tree: { sha: ROOT_TREE_SHA }, parents: [] });
    if (url.endsWith("/git/blobs") && request.method === "POST") return json({ sha: blobSha }, 201);
    if (url.endsWith("/git/trees") && request.method === "POST") return json({ sha: NEW_TREE_SHA }, 201);
    if (url.endsWith(`/git/trees/${NEW_TREE_SHA}`) && request.method === "GET")
      return json({ sha: NEW_TREE_SHA, truncated: false,
        tree: [{ path: "config", mode: "040000", type: "tree", sha: CONFIG_TREE_SHA }] });
    if (url.endsWith("/git/commits") && request.method === "POST") return json({ sha: NEW_COMMIT_SHA,
      tree: { sha: NEW_TREE_SHA }, parents: [{ sha: BASE_SHA }] }, 201);
    throw new Error("unexpected mocked GitHub path");
  }) as typeof fetch;
  const client = new ArtifactOnlyGitHubClient(token(), { fetchImpl });
  const repository = await client.resolveRepository();
  const base = await client.readCommit(repository, BASE_SHA);
  const blob = await client.createBlob(repository, bytes, correlation("blob", "/git/blobs",
    { content: Buffer.from(bytes).toString("base64"), encoding: "base64" }));
  const treeBody = { base_tree: ROOT_TREE_SHA, tree: [{ path: FILE_PATH, mode: "100644", type: "blob", sha: blobSha }] };
  const tree = await client.createTree(repository, base, [{ path: FILE_PATH, mode: "100644", blob }],
    correlation("tree", "/git/trees", treeBody));
  assert.equal(tree.sha, NEW_TREE_SHA);
  assert.equal(tree.baseCommitSha, BASE_SHA);
  const commit = await client.createCommit(repository, tree, base, correlation("commit", "/git/commits",
    { message: "CloudPilot: apply approved observability remediation", tree: NEW_TREE_SHA, parents: [BASE_SHA] }));
  assert.deepEqual(commit, { sha: NEW_COMMIT_SHA, treeSha: NEW_TREE_SHA, parentShas: [BASE_SHA] });

  const treeRequest = calls.find((call) => call.url.endsWith("/git/trees") && call.init.method === "POST")!;
  assert.deepEqual(JSON.parse(String(treeRequest.init.body)), {
    base_tree: ROOT_TREE_SHA,
    tree: [{ path: FILE_PATH, mode: "100644", type: "blob", sha: blobSha }]
  });
  const commitRequest = calls.find((call) => call.url.endsWith("/git/commits") && call.init.method === "POST")!;
  assert.deepEqual(JSON.parse(String(commitRequest.init.body)), {
    message: "CloudPilot: apply approved observability remediation",
    tree: NEW_TREE_SHA,
    parents: [BASE_SHA]
  });
  assert.equal(calls.filter((call) => call.init.method === "POST").length, 3);
});

test("all six mutation APIs validate committed correlation against exact HTTP request fingerprints", async () => {
  const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
  const bytes = new TextEncoder().encode(FILE_CONTENT), blobSha = gitBlobSha(bytes);
  const prBody = (state: "open" | "closed") =>
    `{"number":1,"html_url":"https://github.com/acme/cloudpilot-demo/pull/1","draft":true,"state":"${state}",` +
    `"head":{"ref":"safe/branch","sha":"${NEW_COMMIT_SHA}","repo":{"id":${REPOSITORY_ID}}},` +
    `"base":{"ref":"main","sha":"${BASE_SHA}","repo":{"id":${REPOSITORY_ID}}}}`;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = String(init?.method ?? "GET"), body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method, body });
    if (url.endsWith(`/repositories/${REPOSITORY_ID}`)) return response(repositoryBody());
    if (url.endsWith(`/git/commits/${BASE_SHA}`) && method === "GET")
      return json({ sha: BASE_SHA, tree: { sha: ROOT_TREE_SHA }, parents: [] });
    if (url.endsWith("/git/blobs") && method === "POST") return json({ sha: blobSha }, 201);
    if (url.endsWith("/git/trees") && method === "POST") return json({ sha: NEW_TREE_SHA }, 201);
    if (url.endsWith(`/git/trees/${NEW_TREE_SHA}`) && method === "GET")
      return json({ sha: NEW_TREE_SHA, truncated: false, tree: [{ path: "config", mode: "040000", type: "tree", sha: CONFIG_TREE_SHA }] });
    if (url.endsWith("/git/commits") && method === "POST")
      return json({ sha: NEW_COMMIT_SHA, tree: { sha: NEW_TREE_SHA }, parents: [{ sha: BASE_SHA }] }, 201);
    if (url.endsWith("/git/refs") && method === "POST")
      return json({ ref: "refs/heads/safe/branch", object: { type: "commit", sha: NEW_COMMIT_SHA } }, 201);
    if (url.endsWith("/pulls") && method === "POST") return response(prBody("open"), 201);
    if (url.endsWith("/pulls/1") && method === "PATCH") return response(prBody("closed"));
    throw new Error("unexpected mocked request");
  }) as typeof fetch;
  const client = new ArtifactOnlyGitHubClient(token(), { fetchImpl });
  const repository = await client.resolveRepository(), base = await client.readCommit(repository, BASE_SHA);
  const blobBody = { content: Buffer.from(bytes).toString("base64"), encoding: "base64" };
  const blobCorrelation = correlation("blob", "/git/blobs", blobBody);
  const blob = await client.createBlob(repository, bytes, blobCorrelation);
  const treeBody = { base_tree: ROOT_TREE_SHA, tree: [{ path: FILE_PATH, mode: "100644", type: "blob", sha: blobSha }] };
  const treeCorrelation = correlation("tree", "/git/trees", treeBody);
  const tree = await client.createTree(repository, base, [{ path: FILE_PATH, mode: "100644", blob }], treeCorrelation);
  const commitBody = { message: "CloudPilot: apply approved observability remediation", tree: NEW_TREE_SHA, parents: [BASE_SHA] };
  const commitCorrelation = correlation("commit", "/git/commits", commitBody);
  await client.createCommit(repository, tree, base, commitCorrelation);
  const branchBody = { ref: "refs/heads/safe/branch", sha: NEW_COMMIT_SHA };
  const branchCorrelation = correlation("branch", "/git/refs", branchBody);
  await client.createBranch(repository, "safe/branch", NEW_COMMIT_SHA, branchCorrelation);
  const prInput = { head: "safe/branch", base: "main", title: "title", body: "body" };
  const prBodyRequest = { ...prInput, draft: true };
  const prCorrelation = correlation("pull_request", "/pulls", prBodyRequest);
  await client.createDraftPullRequest(repository, prInput, prCorrelation);
  const closeCorrelation = correlation("pull_request_close", "/pulls/1", { state: "closed" }, "PATCH");
  await client.closePullRequest(repository, 1, closeCorrelation);

  const correlations = [blobCorrelation, treeCorrelation, commitCorrelation, branchCorrelation, prCorrelation, closeCorrelation];
  assert.deepEqual(correlations.map(({ executionId, attempt, operationKey, stage }) =>
    ({ executionId, attempt, operationKey, stage })), [
    { executionId: "execution-fixture", attempt: 2, operationKey: "blob:fixture", stage: "blob" },
    { executionId: "execution-fixture", attempt: 2, operationKey: "tree:fixture", stage: "tree" },
    { executionId: "execution-fixture", attempt: 2, operationKey: "commit:fixture", stage: "commit" },
    { executionId: "execution-fixture", attempt: 2, operationKey: "branch:fixture", stage: "branch" },
    { executionId: "execution-fixture", attempt: 2, operationKey: "pull_request:fixture", stage: "pull_request" },
    { executionId: "execution-fixture", attempt: 2, operationKey: "pull_request_close:fixture", stage: "pull_request_close" }
  ]);
  const writes = calls.filter((call) => call.method !== "GET");
  assert.deepEqual(writes.map(({ method, url, body }) => [method, url, body]), [
    ["POST", `${MUTATION_REPO_TARGET}/git/blobs`, JSON.stringify(blobBody)],
    ["POST", `${MUTATION_REPO_TARGET}/git/trees`, JSON.stringify(treeBody)],
    ["POST", `${MUTATION_REPO_TARGET}/git/commits`, JSON.stringify(commitBody)],
    ["POST", `${MUTATION_REPO_TARGET}/git/refs`, JSON.stringify(branchBody)],
    ["POST", `${MUTATION_REPO_TARGET}/pulls`, JSON.stringify(prBodyRequest)],
    ["PATCH", `${MUTATION_REPO_TARGET}/pulls/1`, JSON.stringify({ state: "closed" })]
  ]);
  assert.deepEqual(writes.map((call, index) => githubMutationRequestFingerprint(call.method as "POST" | "PATCH", call.url,
    call.body ?? "") === correlations[index]!.requestFingerprint), [true, true, true, true, true, true]);
  assert.ok(calls.filter((call) => call.method === "GET").length >= 3, "read-only request signatures remain unchanged");

  const beforeMismatch = calls.length;
  await assert.rejects(client.createBlob(repository, bytes,
    correlation("blob", "/git/blobs", { content: "different", encoding: "base64" })),
  (error: unknown) => error instanceof ArtifactGitHubClientError && error.code === "invalid_input");
  await assert.rejects(client.createBranch(repository, "safe/branch", NEW_COMMIT_SHA, blobCorrelation),
    (error: unknown) => error instanceof ArtifactGitHubClientError && error.code === "invalid_input");
  assert.equal(calls.length, beforeMismatch, "fingerprint mismatch is rejected before HTTP invocation");
});

test("rejects duplicate, disallowed, forged tree entries and unrelated commit parents before writes", async () => {
  let calls = 0;
  const commitCallsBeforeRejectedParent = { value: -1 };
  const bytes = new TextEncoder().encode(FILE_CONTENT);
  const blobSha = gitBlobSha(bytes);
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    const url = String(input);
    if (url.endsWith(`/repositories/${REPOSITORY_ID}`)) return response(repositoryBody());
    if (url.endsWith(`/git/commits/${BASE_SHA}`)) return json({ sha: BASE_SHA, tree: { sha: ROOT_TREE_SHA }, parents: [] });
    if (url.endsWith(`/git/commits/${"8".repeat(40)}`)) return json({ sha: "8".repeat(40), tree: { sha: "9".repeat(40) }, parents: [] });
    if (url.endsWith("/git/blobs")) return json({ sha: blobSha }, 201);
    if (url.endsWith("/git/trees") && init?.method === "POST") return json({ sha: NEW_TREE_SHA }, 201);
    if (url.endsWith(`/git/trees/${NEW_TREE_SHA}`) && init?.method === "GET") return json({ sha: NEW_TREE_SHA, truncated: false, tree: [] });
    if (url.endsWith("/git/commits") && init?.method === "POST") {
      commitCallsBeforeRejectedParent.value++;
      return json({ sha: NEW_COMMIT_SHA, tree: { sha: NEW_TREE_SHA }, parents: [{ sha: BASE_SHA }] }, 201);
    }
    throw new Error("unexpected request");
  }) as typeof fetch;
  const client = new ArtifactOnlyGitHubClient(token(), { fetchImpl });
  const repository = await client.resolveRepository();
  const base = await client.readCommit(repository, BASE_SHA);
  const blob = await client.createBlob(repository, bytes, correlation("blob", "/git/blobs",
    { content: Buffer.from(bytes).toString("base64"), encoding: "base64" }));
  const beforeInvalid = calls;
  await assert.rejects(client.createTree(repository, base, [
    { path: FILE_PATH, mode: "100644", blob }, { path: FILE_PATH, mode: "100644", blob }
  ], correlation("tree", "/git/trees", {})), ArtifactGitHubClientError);
  await assert.rejects(client.createTree(repository, base, [{ path: ".github/workflows/evil.yml", mode: "100644", blob }], correlation("tree", "/git/trees", {})), ArtifactGitHubClientError);
  await assert.rejects(client.createTree(repository, base, [{ path: FILE_PATH, mode: "100644", blob: { sha: blobSha } as never }], correlation("tree", "/git/trees", {})), ArtifactGitHubClientError);
  await assert.rejects(client.createTree(repository, base, [{ path: FILE_PATH, mode: "100755", blob } as never], correlation("tree", "/git/trees", {})), ArtifactGitHubClientError);
  assert.equal(calls, beforeInvalid);
  await assert.rejects(client.resolvePathAtCommit(repository, BASE_SHA, "../../.github/workflows/x.yml"), ArtifactGitHubClientError);
  await assert.rejects(client.readCommit(repository, "not-a-sha"), ArtifactGitHubClientError);
  const tree = await client.createTree(repository, base, [{ path: FILE_PATH, mode: "100644", blob }], correlation("tree", "/git/trees",
    { base_tree: ROOT_TREE_SHA, tree: [{ path: FILE_PATH, mode: "100644", type: "blob", sha: blobSha }] }));
  const otherParent = await client.readCommit(repository, "8".repeat(40));
  const beforeCommitAttempt = commitCallsBeforeRejectedParent.value;
  await assert.rejects(client.createCommit(repository, tree, otherParent, correlation("commit", "/git/commits", {})), (error: unknown) =>
    error instanceof ArtifactGitHubClientError && error.code === "invalid_input");
  assert.equal(commitCallsBeforeRejectedParent.value, beforeCommitAttempt);
});

test("bounded response, stalled body, timeout, caller abort, and redirects fail safely", async () => {
  const oversized = new ArtifactOnlyGitHubClient(token(), {
    fetchImpl: (async () => response("x".repeat(1024 * 1024 + 1))) as typeof fetch
  });
  await assert.rejects(oversized.resolveRepository(), (error: unknown) =>
    error instanceof ArtifactGitHubClientError && error.code === "response_too_large");

  const stalled = new ArtifactOnlyGitHubClient(token(), {
    timeoutMs: 15,
    fetchImpl: (async () => new Response(new ReadableStream({ start() {} }))) as typeof fetch
  });
  await assert.rejects(stalled.resolveRepository(), (error: unknown) =>
    error instanceof ArtifactGitHubClientError && error.code === "timeout");

  let redirectMode: RequestRedirect | undefined;
  const redirect = new ArtifactOnlyGitHubClient(token(), {
    fetchImpl: (async (_input, init) => {
      redirectMode = init?.redirect;
      throw new TypeError("redirected with ghs-test-token and secret body");
    }) as typeof fetch
  });
  await assert.rejects(redirect.resolveRepository(), (error: unknown) => error instanceof Error &&
    !error.message.includes("ghs-test-token") && !error.message.includes("secret body"));
  assert.equal(redirectMode, "error");

  const controller = new AbortController();
  const abortable = new ArtifactOnlyGitHubClient(token(), {
    fetchImpl: (async () => new Promise<Response>(() => undefined)) as typeof fetch
  });
  const pending = abortable.resolveRepository(controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: unknown) =>
    error instanceof ArtifactGitHubClientError && error.code === "aborted");
});

test("ambiguous write failures are not retried and upstream error bodies never escape", async () => {
  let writeCalls = 0;
  const bytes = new TextEncoder().encode("body");
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith(`/repositories/${REPOSITORY_ID}`)) return response(repositoryBody());
    if (String(input).endsWith("/git/blobs") && init?.method === "POST") {
      writeCalls++;
      throw new TypeError("raw upstream body and ghs-test-token");
    }
    return response("raw upstream error with ghs-test-token", 503);
  }) as typeof fetch;
  const client = new ArtifactOnlyGitHubClient(token(), { fetchImpl });
  const repository = await client.resolveRepository();
  await assert.rejects(client.createBlob(repository, bytes, correlation("blob", "/git/blobs",
    { content: Buffer.from(bytes).toString("base64"), encoding: "base64" })), (error: unknown) => {
    assert.ok(error instanceof ArtifactGitHubClientError);
    assert.equal(error.code, "network_failure");
    assert.doesNotMatch(error.message, /raw upstream|ghs-test-token/);
    return true;
  });
  assert.equal(writeCalls, 1);
  await assert.rejects(client.readReference(repository, "main"), (error: unknown) =>
    error instanceof ArtifactGitHubClientError && error.code === "upstream_failure" &&
    !error.message.includes("raw upstream error"));
  assert.equal(writeCalls, 1);
});

test("HTTP 403 with Retry-After header is classified as rate_limited and captures retry delay", async () => {
  const fetchImpl = (async () => new Response("Forbidden details", {
    status: 403,
    headers: { "retry-after": "30", "content-type": "text/plain" }
  })) as typeof fetch;
  const client = new ArtifactOnlyGitHubClient(token(), { fetchImpl });
  await assert.rejects(client.resolveRepository(), (error: unknown) => {
    assert.ok(error instanceof ArtifactGitHubClientError);
    assert.equal(error.code, "rate_limited");
    assert.equal(error.retryAfterMs, 30_000);
    assert.doesNotMatch(error.message, /Forbidden details|ghs-test-token/);
    return true;
  });
});

test("HTTP 403 with secondary rate limit response body is classified as rate_limited", async () => {
  const secondaryRateLimitBodies = [
    JSON.stringify({
      message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      documentation_url: "https://docs.github.com/rest/overview/resources-in-the-rest-api#secondary-rate-limits"
    }),
    JSON.stringify({
      message: "You have triggered an abuse detection mechanism. Please wait a few minutes before you try again."
    }),
    "You have exceeded a secondary rate limit. Please wait a few minutes."
  ];

  for (const body of secondaryRateLimitBodies) {
    const fetchImpl = (async () => new Response(body, {
      status: 403,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;
    const client = new ArtifactOnlyGitHubClient(token(), { fetchImpl });
    await assert.rejects(client.resolveRepository(), (error: unknown) => {
      assert.ok(error instanceof ArtifactGitHubClientError);
      assert.equal(error.code, "rate_limited");
      assert.equal(error.retryAfterMs, undefined);
      assert.doesNotMatch(error.message, /secondary rate limit|abuse detection|ghs-test-token/);
      return true;
    });
  }
});

test("only complete qualifying mutation responses produce correlated runtime-branded rejection evidence", async () => {
  const correlationContext = correlation("blob", "/git/blobs", { content: "eA==", encoding: "base64" });
  const responseFor = (status: number, body: string) => new Response(body, {
    status, headers: { "content-type": "application/json", ...(status === 429 ? { "retry-after": "90" } : {}) }
  });
  const primary = new ArtifactOnlyGitHubClient(token(), { fetchImpl: (async (_input, init) => init?.method === "GET"
    ? response(repositoryBody()) : responseFor(429, JSON.stringify({ message: "rate limited" }))) as typeof fetch });
  const repo = await primary.resolveRepository();
  let primaryEvidence: unknown;
  await assert.rejects(primary.createBlob(repo, new TextEncoder().encode("x"), correlationContext), (error: unknown) => {
    assert.ok(error instanceof ArtifactGitHubClientError);
    primaryEvidence = error.rejectionEvidence;
    assert.equal(error.retryAfterMs, DEFAULT_MAX_RETRY_AFTER_MS);
    return true;
  });
  assert.equal(isTrustedGitHubMutationRejectionEvidence(primaryEvidence, correlationContext), true);
  assert.equal(Object.isFrozen(primaryEvidence), true);
  assert.equal(isTrustedGitHubMutationRejectionEvidence({ ...(primaryEvidence as object) }, correlationContext), false);
  assert.equal(isTrustedGitHubMutationRejectionEvidence(primaryEvidence,
    { ...correlationContext, operationKey: "other:intent" }), false);

  const secondary = new ArtifactOnlyGitHubClient(token(), { fetchImpl: (async (_input, init) => init?.method === "GET"
    ? response(repositoryBody()) : responseFor(403,
      JSON.stringify({ message: "You have exceeded a secondary rate limit. Please wait a few minutes." }))) as typeof fetch });
  const secondaryRepo = await secondary.resolveRepository();
  await assert.rejects(secondary.createBlob(secondaryRepo, new TextEncoder().encode("x"), correlationContext), (error: unknown) => {
    assert.ok(error instanceof ArtifactGitHubClientError);
    assert.equal(isTrustedGitHubMutationRejectionEvidence(error.rejectionEvidence, correlationContext), true);
    assert.equal(error.rejectionEvidence?.rejection, "secondary_rate_limit");
    return true;
  });

  for (const [status, body] of [[403, JSON.stringify({ message: "Resource forbidden" })],
    [403, "not-json"], [503, JSON.stringify({ message: "server error" })], [429, "malformed"]] as const) {
    const client = new ArtifactOnlyGitHubClient(token(), { fetchImpl: (async (_input, init) => init?.method === "GET"
      ? response(repositoryBody()) : responseFor(status, body)) as typeof fetch });
    const target = await client.resolveRepository();
    await assert.rejects(client.createBlob(target, new TextEncoder().encode("x"), correlationContext), (error: unknown) => {
      assert.ok(error instanceof ArtifactGitHubClientError);
      assert.equal(error.rejectionEvidence, undefined);
      return true;
    });
  }
});

test("ordinary HTTP 403 without rate limit indicators remains terminal forbidden", async () => {
  const ordinaryBodies = [
    JSON.stringify({ message: "Resource not accessible by integration" }),
    JSON.stringify({ message: "Must have admin rights to Repository" }),
    "Forbidden"
  ];

  for (const body of ordinaryBodies) {
    const fetchImpl = (async () => new Response(body, {
      status: 403,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;
    const client = new ArtifactOnlyGitHubClient(token(), { fetchImpl });
    await assert.rejects(client.resolveRepository(), (error: unknown) => {
      assert.ok(error instanceof ArtifactGitHubClientError);
      assert.equal(error.code, "forbidden");
      assert.equal(error.retryAfterMs, undefined);
      assert.doesNotMatch(error.message, /Resource not accessible|integration|ghs-test-token/);
      return true;
    });
  }
});

test("HTTP 429 retains rate_limited classification and parses Retry-After", async () => {
  const fetchImplWithHeader = (async () => new Response(JSON.stringify({ message: "Too Many Requests" }), {
    status: 429,
    headers: { "retry-after": "45", "content-type": "application/json" }
  })) as typeof fetch;
  const clientWithHeader = new ArtifactOnlyGitHubClient(token(), { fetchImpl: fetchImplWithHeader });
  await assert.rejects(clientWithHeader.resolveRepository(), (error: unknown) => {
    assert.ok(error instanceof ArtifactGitHubClientError);
    assert.equal(error.code, "rate_limited");
    assert.equal(error.retryAfterMs, 45_000);
    return true;
  });

  const fetchImplWithoutHeader = (async () => new Response(JSON.stringify({ message: "Too Many Requests" }), {
    status: 429,
    headers: { "content-type": "application/json" }
  })) as typeof fetch;
  const clientWithoutHeader = new ArtifactOnlyGitHubClient(token(), { fetchImpl: fetchImplWithoutHeader });
  await assert.rejects(clientWithoutHeader.resolveRepository(), (error: unknown) => {
    assert.ok(error instanceof ArtifactGitHubClientError);
    assert.equal(error.code, "rate_limited");
    assert.equal(error.retryAfterMs, undefined);
    return true;
  });
});

test("malformed, negative, or excessive Retry-After values are handled safely without unbounded delay", async () => {
  const baseTime = 1_700_000_000_000;
  assert.equal(parseRetryAfter("30", baseTime), 30_000);
  assert.equal(parseRetryAfter("-10", baseTime), undefined);
  assert.equal(parseRetryAfter("invalid-seconds", baseTime), undefined);
  assert.equal(parseRetryAfter("", baseTime), undefined);
  assert.equal(parseRetryAfter(null, baseTime), undefined);
  assert.equal(parseRetryAfter("9999999999999999999999999", baseTime), undefined);
  assert.equal(parseRetryAfter("Wed, 21 Oct 2020 00:00:00 GMT", baseTime), undefined);
  const futureDate = new Date(baseTime + 120_000).toUTCString();
  assert.equal(parseRetryAfter(futureDate, baseTime, 60_000), 60_000);
  assert.equal(parseRetryAfter("3600", baseTime, 60_000), 60_000);

  const malformedClient = new ArtifactOnlyGitHubClient(token(), {
    fetchImpl: (async () => new Response("Forbidden", {
      status: 403,
      headers: { "retry-after": "not-a-number" }
    })) as typeof fetch
  });
  await assert.rejects(malformedClient.resolveRepository(), (error: unknown) => {
    assert.ok(error instanceof ArtifactGitHubClientError);
    assert.equal(error.code, "forbidden");
    assert.equal(error.retryAfterMs, undefined);
    return true;
  });
});

test("response bodies are consumed and cancelled safely on 403 and 429 rejection paths", async () => {
  let cancelCalled403RetryAfter = false;
  const stream403RetryAfter = new ReadableStream({
    cancel() { cancelCalled403RetryAfter = true; }
  });
  const client1 = new ArtifactOnlyGitHubClient(token(), {
    fetchImpl: (async () => new Response(stream403RetryAfter, {
      status: 403,
      headers: { "retry-after": "20" }
    })) as typeof fetch
  });
  await assert.rejects(client1.resolveRepository(), ArtifactGitHubClientError);
  assert.equal(cancelCalled403RetryAfter, true, "403 with Retry-After cancels response body stream");

  let cancelCalled403Secondary = false;
  const secondaryBodyText = JSON.stringify({ message: "You have exceeded a secondary rate limit." });
  const encoder = new TextEncoder();
  const stream403Secondary = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(secondaryBodyText.padEnd(2048, " ")));
      controller.enqueue(encoder.encode("extra unread body content"));
    },
    cancel() { cancelCalled403Secondary = true; }
  });
  const client2 = new ArtifactOnlyGitHubClient(token(), {
    fetchImpl: (async () => new Response(stream403Secondary, { status: 403 })) as typeof fetch
  });
  await assert.rejects(client2.resolveRepository(), (error: unknown) =>
    error instanceof ArtifactGitHubClientError && error.code === "rate_limited");
  assert.equal(cancelCalled403Secondary, true, "403 with secondary rate limit body cancels reader/stream");

  let cancelCalled429 = false;
  const stream429 = new ReadableStream({
    cancel() { cancelCalled429 = true; }
  });
  const client3 = new ArtifactOnlyGitHubClient(token(), {
    fetchImpl: (async () => new Response(stream429, { status: 429 })) as typeof fetch
  });
  await assert.rejects(client3.resolveRepository(), (error: unknown) =>
    error instanceof ArtifactGitHubClientError && error.code === "rate_limited");
  assert.equal(cancelCalled429, true, "429 cancels response body stream");
});
