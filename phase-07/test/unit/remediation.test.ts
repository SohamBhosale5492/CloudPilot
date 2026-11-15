/**
 * Phase 07 Unit Tests
 *
 * Covers:
 *  1. GitHubConnector input validation (owner, repo, branch, path, SHA)
 *  2. GitHubConnector HTTPS-only enforcement
 *  3. GitHubConnector redirect=error enforcement
 *  4. GitHubConnector bounded response size
 *  5. GitHubConnector token redaction in errors
 *  6. RemediationPlanner: supported signals produce correct patches
 *  7. RemediationPlanner: idempotent applyPatch
 *  8. RemediationPlanner: path traversal prevention
 *  9. RemediationPlanner: unsupported signal throws UnsupportedFindingError
 * 10. RemediationPlanner: non-gap outcome throws UnsupportedFindingError
 * 11. RemediationPlanner: isRemediationSupported()
 * 12. RemediationPlanner: buildIdempotencyKey() is stable
 * 13. RemediationOrchestrator: skips non-gap/unsupported findings
 * 14. RemediationOrchestrator: idempotent – returns existing open PR without GitHub calls
 * 15. RemediationOrchestrator: full happy-path (branch + file + PR)
 * 16. RemediationOrchestrator: branch already exists (GitHubConflictError) → continues
 * 17. RemediationOrchestrator: file not found → uses placeholder → creates file
 * 18. RemediationOrchestrator: existing open PR (findOpenPullRequest) → skips branch/file steps
 * 19. RemediationOrchestrator: GitHub API failure → decrements retriesLeft, status pending
 * 20. RemediationOrchestrator: retriesLeft 0 after failure → status failed
 * 21. RemediationRepository: createOrFetch is idempotent (returns same row on second call)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GitHubConnector,
  GitHubInputError,
  GitHubApiError,
  GitHubConflictError,
  GitHubNotFoundError,
  redactSecrets
} from "../../src/github/github-connector.js";
import {
  planRemediation,
  isRemediationSupported,
  buildIdempotencyKey,
  patchObservabilityYaml,
  patchPrometheusAlertRulesYaml,
  validatePrometheusAlertRulesYaml,
  UnsupportedFindingError,
  MalformedYamlError,
  UnsupportedYamlStructureError,
  FindingSummary
} from "../../src/remediation/planner.js";
import {
  RemediationOrchestrator,
  buildBranchName,
  parseGitHubRepoUrl
} from "../../src/remediation/orchestrator.js";
import {
  RemediationRepository,
  InvalidCursorError
} from "../../src/db/remediation-repo.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeFetch(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {}
): typeof fetch {
  return async (_url, _opts) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const encoder = new TextEncoder();
    const uint8 = encoder.encode(text);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(uint8);
        controller.close();
      }
    });
    return new Response(stream, {
      status: statusCode,
      headers: { "Content-Type": "application/json", ...headers }
    });
  };
}

function makeGapFinding(overrides: Partial<FindingSummary> = {}): FindingSummary {
  return {
    requirementId: "req-metric-uptime",
    ruleId: "rule.metric.present",
    ruleVersion: "1.0.0",
    signal: "metric",
    outcome: "gap",
    expected: "metric must be scraped",
    observed: "no metric found",
    reason: "metric not present in Prometheus",
    ...overrides
  };
}

// Minimal stub PrismaClient
function makePrisma(remediations: Map<string, unknown> = new Map()): unknown {
  let nextId = 1;
  return {
    remediation: {
      findUnique: async ({ where }: { where: { idempotencyKey?: string } }) => {
        if (!where.idempotencyKey) return null;
        return remediations.get(`key:${where.idempotencyKey}`) ?? null;
      },
      findFirst: async ({ where }: { where: { id?: string; tenantId?: string } }) => {
        for (const [, v] of remediations) {
          const r = v as { id: string; tenantId: string };
          if (r.id === where.id && r.tenantId === where.tenantId) return r;
        }
        return null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = `rem-${nextId++}`;
        const row = { id, retriesLeft: 3, ...data };
        remediations.set(`key:${data.idempotencyKey}`, row);
        remediations.set(`id:${id}`, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = remediations.get(`id:${where.id}`) as Record<string, unknown>;
        if (!row) return null;
        Object.assign(row, data);
        return row;
      }
    }
  };
}

// ─── 1. GitHubConnector input validation ────────────────────────────────────

test("GitHubConnector: rejects HTTP (non-HTTPS) base URL", () => {
  assert.throws(
    () => new GitHubConnector({ token: "t", apiBaseUrl: "http://api.github.com" }),
    GitHubInputError
  );
});

test("GitHubConnector: rejects invalid owner name (special characters)", async () => {
  const gh = new GitHubConnector({ token: "t", fetchImpl: makeFetch(200, {}) });
  await assert.rejects(() => gh.getBranchSha("bad owner!", "repo", "main"), GitHubInputError);
});

test("GitHubConnector: rejects owner name containing slash", async () => {
  const gh = new GitHubConnector({ token: "t", fetchImpl: makeFetch(200, {}) });
  await assert.rejects(() => gh.getBranchSha("owner/extra", "repo", "main"), GitHubInputError);
  await assert.rejects(() => gh.getBranchSha("../owner", "repo", "main"), GitHubInputError);
});

test("GitHubConnector: rejects invalid repo name (special characters)", async () => {
  const gh = new GitHubConnector({ token: "t", fetchImpl: makeFetch(200, {}) });
  await assert.rejects(() => gh.getBranchSha("owner", "bad repo!", "main"), GitHubInputError);
});

test("GitHubConnector: rejects repo name containing slash or ending in .git", async () => {
  const gh = new GitHubConnector({ token: "t", fetchImpl: makeFetch(200, {}) });
  await assert.rejects(() => gh.getBranchSha("owner", "repo/sub", "main"), GitHubInputError);
  await assert.rejects(() => gh.getBranchSha("owner", "../../repo", "main"), GitHubInputError);
  await assert.rejects(() => gh.getBranchSha("owner", "my-repo.git", "main"), GitHubInputError);
});

test("GitHubConnector: rejects branch name starting with dot or hyphen", async () => {
  const gh = new GitHubConnector({ token: "t", fetchImpl: makeFetch(200, {}) });
  await assert.rejects(() => gh.getBranchSha("owner", "repo", ".hidden"), GitHubInputError);
  await assert.rejects(() => gh.getBranchSha("owner", "repo", "-bad-branch"), GitHubInputError);
});

test("GitHubConnector: rejects branch name ending with slash, dot, or .lock", async () => {
  const gh = new GitHubConnector({ token: "t", fetchImpl: makeFetch(200, {}) });
  await assert.rejects(() => gh.getBranchSha("owner", "repo", "branch/"), GitHubInputError);
  await assert.rejects(() => gh.getBranchSha("owner", "repo", "branch."), GitHubInputError);
  await assert.rejects(() => gh.getBranchSha("owner", "repo", "branch.lock"), GitHubInputError);
});

test("GitHubConnector: rejects branch name containing '..' or consecutive slashes '//'", async () => {
  const gh = new GitHubConnector({ token: "t", fetchImpl: makeFetch(200, {}) });
  await assert.rejects(() => gh.getBranchSha("owner", "repo", "heads/../main"), GitHubInputError);
  await assert.rejects(() => gh.getBranchSha("owner", "repo", "heads//main"), GitHubInputError);
  await assert.rejects(() => gh.getBranchSha("owner", "repo", "heads/.dot/main"), GitHubInputError);
});

test("GitHubConnector: rejects path traversal in getFileContent", async () => {
  const gh = new GitHubConnector({ token: "t", fetchImpl: makeFetch(200, {}) });
  await assert.rejects(() => gh.getFileContent("o", "r", "../etc/passwd", "main"), GitHubInputError);
});

test("GitHubConnector: rejects absolute or trailing-slash path in getFileContent", async () => {
  const gh = new GitHubConnector({ token: "t", fetchImpl: makeFetch(200, {}) });
  await assert.rejects(() => gh.getFileContent("o", "r", "/etc/shadow", "main"), GitHubInputError);
  await assert.rejects(() => gh.getFileContent("o", "r", "config/observability/", "main"), GitHubInputError);
  await assert.rejects(() => gh.getFileContent("o", "r", "config//metrics.yaml", "main"), GitHubInputError);
});

test("GitHubConnector: rejects invalid SHA in createBranch", async () => {
  const gh = new GitHubConnector({ token: "t", fetchImpl: makeFetch(201, {}) });
  await assert.rejects(
    () => gh.createBranch("owner", "repo", "my-branch", "not-a-sha"),
    GitHubInputError
  );
});

test("GitHubConnector: maps 404 response to GitHubNotFoundError", async () => {
  const gh = new GitHubConnector({ token: "t", fetchImpl: makeFetch(404, { message: "Not Found" }) });
  await assert.rejects(() => gh.getBranchSha("owner", "repo", "main"), GitHubNotFoundError);
});

test("GitHubConnector: maps 422 response to GitHubConflictError", async () => {
  const gh = new GitHubConnector({ token: "t", fetchImpl: makeFetch(422, { message: "Reference already exists" }) });
  const sha = "a".repeat(40);
  await assert.rejects(() => gh.createBranch("owner", "repo", "my-branch", sha), GitHubConflictError);
});

test("GitHubConnector: sanitizes token from both error message and responseBody", async () => {
  const token = "ghp_supersecrettoken123456";
  const pat = "github_pat_11AABCDEF0123456789_abcdefghijklmnopqrstuvwxyz";
  const gh = new GitHubConnector({
    token,
    fetchImpl: makeFetch(500, {
      message: `Server Error with token ${token}`,
      details: `Failed with PAT ${pat} and Bearer secretBearerToken1234`
    })
  });
  try {
    await gh.getBranchSha("owner", "repo", "main");
    assert.fail("Should have thrown");
  } catch (err) {
    assert.ok(err instanceof GitHubApiError);
    assert.ok(!err.message.includes("supersecrettoken123456"), "Token must not appear in error message");
    assert.ok(!err.message.includes("11AABCDEF0123456789"), "PAT must not appear in error message");
    assert.ok(!err.responseBody.includes("supersecrettoken123456"), "Token must not appear in responseBody");
    assert.ok(!err.responseBody.includes("11AABCDEF0123456789"), "PAT must not appear in responseBody");
  }
});

test("GitHubConnector: successful getBranchSha returns name and sha", async () => {
  const sha = "a".repeat(40);
  const gh = new GitHubConnector({
    token: "t",
    fetchImpl: makeFetch(200, { object: { sha } })
  });
  const result = await gh.getBranchSha("owner", "repo", "main");
  assert.equal(result.name, "main");
  assert.equal(result.sha, sha);
});

test("GitHubConnector: getFileContent decodes base64 content", async () => {
  const raw = "# hello world\n";
  const encoded = Buffer.from(raw).toString("base64");
  const gh = new GitHubConnector({
    token: "t",
    fetchImpl: makeFetch(200, { path: "file.yaml", content: encoded, sha: "abc123", encoding: "base64" })
  });
  const result = await gh.getFileContent("o", "r", "file.yaml", "main");
  assert.equal(result.content, raw);
  assert.equal(result.sha, "abc123");
});

test("GitHubConnector: findOpenPullRequest returns null when no PRs", async () => {
  const gh = new GitHubConnector({ token: "t", fetchImpl: makeFetch(200, []) });
  const result = await gh.findOpenPullRequest("o", "r", "my-branch", "main");
  assert.equal(result, null);
});

test("GitHubConnector: findOpenPullRequest returns matching PR", async () => {
  const pr = {
    number: 42,
    html_url: "https://github.com/o/r/pull/42",
    title: "Fix it",
    state: "open",
    head: { ref: "my-branch" },
    base: { ref: "main" }
  };
  const gh = new GitHubConnector({ token: "t", fetchImpl: makeFetch(200, [pr]) });
  const result = await gh.findOpenPullRequest("o", "r", "my-branch", "main");
  assert.ok(result !== null);
  assert.equal(result!.number, 42);
  assert.equal(result!.url, "https://github.com/o/r/pull/42");
});

test("GitHubConnector: finds all PR states and identifies merged PRs", async () => {
  for (const scenario of [
    { state: "open", merged_at: null, expected: "open" },
    { state: "closed", merged_at: "2026-10-30T10:00:00Z", expected: "merged" },
    { state: "closed", merged_at: null, expected: "closed" }
  ]) {
    let requestUrl = "";
    const response = [{
      number: 42,
      html_url: "https://github.com/o/r/pull/42",
      title: "Fix it",
      state: scenario.state,
      merged_at: scenario.merged_at,
      head: { ref: "my-branch" },
      base: { ref: "main" }
    }];
    const gh = new GitHubConnector({
      token: "t",
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        return makeFetch(200, response)(input, init);
      }
    });
    const result = await gh.findPullRequestByHead("o", "r", "my-branch", "main");
    assert.equal(result?.state, scenario.expected);
    assert.match(requestUrl, /state=all/);
  }
});

test("GitHubConnector: preserves Retry-After metadata for HTTP 429", async () => {
  const gh = new GitHubConnector({
    token: "t",
    fetchImpl: async () => new Response(JSON.stringify({ message: "rate limited" }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "7" }
    })
  });
  await assert.rejects(
    () => gh.findPullRequestByHead("o", "r", "branch", "main"),
    (error: unknown) => error instanceof GitHubApiError && error.retryAfter === "7"
  );
});

// ─── 2. RemediationPlanner ──────────────────────────────────────────────────

test("planRemediation: metric gap produces correct filePath and prTitle", () => {
  const patch = planRemediation(makeGapFinding({ signal: "metric" }));
  assert.equal(patch.filePath, "config/observability/metrics.yaml");
  assert.ok(patch.prTitle.includes("metric"));
  assert.ok(patch.prBody.includes("CloudPilot Remediation"));
  assert.ok(patch.commitMessage.length > 0);
  assert.ok(patch.summary.length > 0);
});

test("planRemediation: health gap produces correct filePath", () => {
  const patch = planRemediation(makeGapFinding({ signal: "health" }));
  assert.equal(patch.filePath, "config/observability/health-checks.yaml");
});

test("planRemediation: alert gap produces correct filePath", () => {
  const patch = planRemediation(makeGapFinding({ signal: "alert" }));
  assert.equal(patch.filePath, "config/observability/alert-rules.yaml");
});

test("planRemediation: applyPatch inserts line after anchor", () => {
  const patch = planRemediation(makeGapFinding({ signal: "metric", requirementId: "req-uptime" }));
  const base = "# cloudpilot:metrics\nmetrics: []\n";
  const result = patch.applyPatch(base);
  assert.ok(result.includes("req_uptime") || result.includes("cloudpilot:remediated"));
  assert.ok(result.length > base.length, "Patched content should be longer");
});

test("planRemediation: applyPatch is idempotent", () => {
  const patch = planRemediation(makeGapFinding({ signal: "metric" }));
  const base = "# cloudpilot:metrics\nmetrics: []\n";
  const once = patch.applyPatch(base);
  const twice = patch.applyPatch(once);
  assert.equal(once, twice, "Applying patch twice should produce same result");
});

test("planRemediation: same finding always produces same patch (deterministic)", () => {
  const finding = makeGapFinding();
  const p1 = planRemediation(finding);
  const p2 = planRemediation(finding);
  assert.equal(p1.filePath, p2.filePath);
  assert.equal(p1.prTitle, p2.prTitle);
  assert.equal(p1.commitMessage, p2.commitMessage);
});

test("planRemediation: non-gap outcome throws UnsupportedFindingError", () => {
  assert.throws(
    () => planRemediation(makeGapFinding({ outcome: "pass" })),
    UnsupportedFindingError
  );
  assert.throws(
    () => planRemediation(makeGapFinding({ outcome: "unknown" })),
    UnsupportedFindingError
  );
});

test("planRemediation: unsupported signal throws UnsupportedFindingError", () => {
  assert.throws(
    () => planRemediation(makeGapFinding({ signal: "log" })),
    UnsupportedFindingError
  );
  assert.throws(
    () => planRemediation(makeGapFinding({ signal: "log" })),
    UnsupportedFindingError
  );
});

test("isRemediationSupported: true for gap + metric/health/alert", () => {
  assert.equal(isRemediationSupported("metric", "gap"), true);
  assert.equal(isRemediationSupported("health", "gap"), true);
  assert.equal(isRemediationSupported("alert", "gap"), true);
});

test("isRemediationSupported: false for non-gap outcome", () => {
  assert.equal(isRemediationSupported("metric", "pass"), false);
  assert.equal(isRemediationSupported("metric", "unknown"), false);
  assert.equal(isRemediationSupported("metric", "inconclusive"), false);
});

test("isRemediationSupported: false for unsupported signals", () => {
  assert.equal(isRemediationSupported("trace", "gap"), true);
  assert.equal(isRemediationSupported("log", "gap"), false);
});

test("buildIdempotencyKey: same inputs always produce same key", () => {
  const k1 = buildIdempotencyKey("tenant-a", "finding-1", "rule.x", "1.0.0");
  const k2 = buildIdempotencyKey("tenant-a", "finding-1", "rule.x", "1.0.0");
  assert.equal(k1, k2);
});

test("buildIdempotencyKey: different tenants produce different keys", () => {
  const k1 = buildIdempotencyKey("tenant-a", "finding-1", "rule.x", "1.0.0");
  const k2 = buildIdempotencyKey("tenant-b", "finding-1", "rule.x", "1.0.0");
  assert.notEqual(k1, k2);
});

// ─── 3. RemediationOrchestrator ─────────────────────────────────────────────

function makeConnectorStub(overrides: Partial<{
  getBranchSha: (...args: any[]) => Promise<unknown>;
  createBranch: (...args: any[]) => Promise<void>;
  getFileContent: (...args: any[]) => Promise<unknown>;
  updateFile: (...args: any[]) => Promise<string>;
  createPullRequest: (...args: any[]) => Promise<unknown>;
  findOpenPullRequest: (...args: any[]) => Promise<unknown>;
  findPullRequestByHead: (...args: any[]) => Promise<unknown>;
}> = {}): GitHubConnector {
  const sha40 = "a".repeat(40);
  return {
    getBranchSha: overrides.getBranchSha ?? (async (_owner: string, _repo: string, branch: string) => {
      if (branch !== "main") throw new GitHubNotFoundError("branch not found", "{}");
      return { name: branch, sha: sha40 };
    }),
    createBranch: overrides.createBranch ?? (async () => {}),
    getFileContent: overrides.getFileContent ?? (async () => ({
      path: "config/observability/metrics.yaml",
      content: "# cloudpilot:metrics\nmetrics: []\n",
      sha: "file-sha-0001",
      encoding: "base64"
    })),
    updateFile: overrides.updateFile ?? (async () => "new-file-sha"),
    createPullRequest: overrides.createPullRequest ?? (async () => ({
      number: 99,
      url: "https://github.com/o/r/pull/99",
      title: "fix: add metric",
      state: "open",
      headBranch: "cloudpilot/remediate/something",
      baseBranch: "main"
    })),
    findOpenPullRequest: overrides.findOpenPullRequest ?? (async () => null),
    findPullRequestByHead: overrides.findPullRequestByHead ?? overrides.findOpenPullRequest ?? (async () => null)
  } as unknown as GitHubConnector;
}

test("RemediationOrchestrator: skips unsupported signal (trace)", async () => {
  const prisma = makePrisma();
  const gh = makeConnectorStub();
  const orch = new RemediationOrchestrator(
    prisma as never,
    gh,
    { owner: "o", repo: "r" }
  );
  const result = await orch.remediateOne(
    "tenant-1", "proj-1", "scan-1", "finding-1",
    makeGapFinding({ signal: "log" })
  );
  assert.equal(result.skipped, true);
  assert.ok(result.skipReason?.includes("log"));
});

test("RemediationOrchestrator: skips non-gap outcome (pass)", async () => {
  const prisma = makePrisma();
  const gh = makeConnectorStub();
  const orch = new RemediationOrchestrator(prisma as never, gh, { owner: "o", repo: "r" });
  const result = await orch.remediateOne(
    "tenant-1", "proj-1", "scan-1", "finding-1",
    makeGapFinding({ outcome: "pass" })
  );
  assert.equal(result.skipped, true);
});

test("RemediationOrchestrator: happy path creates branch and PR", async () => {
  const prisma = makePrisma();
  let branchCreated = false;
  let fileUpdated = false;
  let prCreated = false;

  const gh = makeConnectorStub({
    createBranch: async () => { branchCreated = true; },
    updateFile: async () => { fileUpdated = true; return "sha2"; },
    createPullRequest: async () => {
      prCreated = true;
      return { number: 7, url: "https://github.com/o/r/pull/7", title: "T", state: "open", headBranch: "b", baseBranch: "main" };
    }
  });

  const orch = new RemediationOrchestrator(prisma as never, gh, { owner: "o", repo: "r" });
  const result = await orch.remediateOne(
    "t1", "p1", "s1", "f1",
    makeGapFinding({ signal: "metric" })
  );

  assert.equal(result.status, "open");
  assert.equal(result.prNumber, 7);
  assert.equal(result.prUrl, "https://github.com/o/r/pull/7");
  assert.ok(branchCreated, "Branch should be created");
  assert.ok(fileUpdated, "File should be updated");
  assert.ok(prCreated, "PR should be created");
});

test("RemediationOrchestrator: branch conflict (422) is non-fatal — continues", async () => {
  const prisma = makePrisma();
  let prCreated = false;
  let branchExists = false;

  const gh = makeConnectorStub({
    getBranchSha: async (_owner: string, _repo: string, branch: string) => {
      if (branch === "main" || branchExists) return { name: branch, sha: "a".repeat(40) };
      throw new GitHubNotFoundError("branch not found", "{}");
    },
    createBranch: async () => {
      branchExists = true;
      throw new GitHubConflictError("branch exists", "{}");
    },
    createPullRequest: async () => {
      prCreated = true;
      return { number: 8, url: "https://github.com/o/r/pull/8", title: "T", state: "open", headBranch: "b", baseBranch: "main" };
    }
  });

  const orch = new RemediationOrchestrator(prisma as never, gh, { owner: "o", repo: "r" });
  const result = await orch.remediateOne("t1", "p1", "s1", "f1", makeGapFinding());

  assert.equal(result.status, "open");
  assert.ok(prCreated, "Should open PR even when branch already existed");
});

test("RemediationOrchestrator: file not found → uses placeholder, creates file", async () => {
  const prisma = makePrisma();
  let fileWasCreated = false;
  let capturedContent = "";

  const gh = makeConnectorStub({
    getFileContent: async () => { throw new GitHubNotFoundError("not found", "{}"); },
    updateFile: async (input: { content: string }) => {
      fileWasCreated = true;
      capturedContent = input.content;
      return "new-sha";
    }
  });

  const orch = new RemediationOrchestrator(prisma as never, gh, { owner: "o", repo: "r" });
  const result = await orch.remediateOne("t1", "p1", "s1", "f1", makeGapFinding({ signal: "metric" }));

  assert.equal(result.status, "open");
  assert.ok(fileWasCreated, "Should create file when not found");
  assert.ok(capturedContent.includes("# CloudPilot Observability"), "Should use placeholder content");
});

test("RemediationOrchestrator: existing open PR → idempotent, no duplicate PR", async () => {
  const prisma = makePrisma();
  let prCreated = false;

  const gh = makeConnectorStub({
    findOpenPullRequest: async () => ({
      number: 55,
      url: "https://github.com/o/r/pull/55",
      title: "existing PR",
      state: "open",
      headBranch: "cloudpilot/remediate/abc",
      baseBranch: "main"
    }),
    createPullRequest: async () => { prCreated = true; return {}; }
  });

  const orch = new RemediationOrchestrator(prisma as never, gh, { owner: "o", repo: "r" });
  const result = await orch.remediateOne("t1", "p1", "s1", "f1", makeGapFinding());

  assert.equal(result.status, "open");
  assert.equal(result.prNumber, 55);
  assert.equal(prCreated, false, "Should NOT create a duplicate PR");
});

test("RemediationOrchestrator: historical merged PR is marked complete without creating another PR", async () => {
  const remediations = new Map<string, unknown>();
  const prisma = makePrisma(remediations);
  let prCreated = false;
  const gh = makeConnectorStub({
    findPullRequestByHead: async () => ({
      number: 56,
      url: "https://github.com/o/r/pull/56",
      title: "merged remediation",
      state: "merged",
      headBranch: "cloudpilot/remediate/hash",
      baseBranch: "main"
    }),
    createPullRequest: async () => { prCreated = true; return {}; }
  });
  const orch = new RemediationOrchestrator(prisma as never, gh, { owner: "o", repo: "r" });
  const result = await orch.remediateOne("t1", "p1", "s1", "f1", makeGapFinding());

  assert.equal(result.status, "merged");
  assert.equal(result.skipped, true);
  assert.equal(prCreated, false);
  const row = remediations.get(`key:${buildIdempotencyKey("t1", "f1", "rule.metric.present", "1.0.0")}`) as { status: string };
  assert.equal(row.status, "merged");
});

test("RemediationOrchestrator: closed PR remains closed for manual review without retrying", async () => {
  const remediations = new Map<string, unknown>();
  const prisma = makePrisma(remediations);
  let prCreated = false;
  const gh = makeConnectorStub({
    findPullRequestByHead: async () => ({
      number: 57,
      url: "https://github.com/o/r/pull/57",
      title: "closed remediation",
      state: "closed",
      headBranch: "cloudpilot/remediate/hash",
      baseBranch: "main"
    }),
    createPullRequest: async () => { prCreated = true; return {}; }
  });
  const orch = new RemediationOrchestrator(prisma as never, gh, { owner: "o", repo: "r" });
  const result = await orch.remediateOne("t1", "p1", "s1", "f1", makeGapFinding());

  assert.equal(result.status, "closed");
  assert.equal(result.skipped, true);
  assert.match(result.skipReason ?? "", /manual review/i);
  assert.equal(prCreated, false);
  const row = remediations.get(`key:${buildIdempotencyKey("t1", "f1", "rule.metric.present", "1.0.0")}`) as { status: string; retriesLeft: number };
  assert.equal(row.status, "closed");
  assert.equal(row.retriesLeft, 3);
});

test("RemediationOrchestrator: DB idempotency – existing open record returns without GitHub calls", async () => {
  const remediations = new Map<string, unknown>();
  const key = buildIdempotencyKey("t1", "f1", "rule.metric.present", "1.0.0");
  const existingRecord = {
    id: "rem-existing",
    tenantId: "t1",
    idempotencyKey: key,
    status: "open",
    prNumber: 22,
    prUrl: "https://github.com/o/r/pull/22",
    patchSummary: "existing",
    retriesLeft: 3
  };
  remediations.set(`key:${key}`, existingRecord);

  let githubCalled = false;
  const gh = makeConnectorStub({
    getBranchSha: async () => { githubCalled = true; return { name: "main", sha: "a".repeat(40) }; }
  });

  const orch = new RemediationOrchestrator(makePrisma(remediations) as never, gh, { owner: "o", repo: "r" });
  const result = await orch.remediateOne("t1", "p1", "s1", "f1", makeGapFinding());

  assert.equal(result.status, "open");
  assert.equal(result.prNumber, 22);
  assert.equal(githubCalled, false, "No GitHub API calls should be made for idempotent case");
  assert.equal(result.skipped, true);
});

test("RemediationOrchestrator: GitHub failure decrements retriesLeft, stays pending", async () => {
  const prisma = makePrisma();
  const gh = makeConnectorStub({
    getBranchSha: async () => { throw new GitHubApiError("network error", 0, ""); }
  });
  const orch = new RemediationOrchestrator(prisma as never, gh, { owner: "o", repo: "r" });
  const result = await orch.remediateOne("t1", "p1", "s1", "f1", makeGapFinding());
  // retriesLeft was 3, now 2, so status is still "pending" (not "failed")
  assert.equal(result.status, "pending");
});

test("RemediationOrchestrator: retriesLeft=1 → after failure, status becomes failed", async () => {
  const remediations = new Map<string, unknown>();
  const key = buildIdempotencyKey("t1", "f1", "rule.metric.present", "1.0.0");
  // Pre-insert a record with retriesLeft=1
  const existingRecord = {
    id: "rem-retry1",
    tenantId: "t1",
    projectId: "p1",
    scanId: "s1",
    findingId: "f1",
    idempotencyKey: key,
    status: "pending",
    prNumber: null,
    prUrl: null,
    patchSummary: null,
    retriesLeft: 1,
    branchName: null,
    errorMessage: null
  };
  remediations.set(`key:${key}`, existingRecord);
  remediations.set(`id:rem-retry1`, existingRecord);

  const gh = makeConnectorStub({
    findOpenPullRequest: async () => null,
    getBranchSha: async () => { throw new GitHubApiError("still failing", 0, ""); }
  });

  // Patch prisma to return existingRecord on findFirst by id
  const prisma = makePrisma(remediations);

  const orch = new RemediationOrchestrator(prisma as never, gh, { owner: "o", repo: "r" });
  const result = await orch.remediateOne("t1", "p1", "s1", "f1", makeGapFinding());

  // After this failure, retriesLeft goes from 1 to 0 → status = "failed"
  assert.equal(result.status, "failed");
});

test("RemediationOrchestrator: remediateScan processes multiple findings", async () => {
  const prisma = makePrisma();
  const gh = makeConnectorStub({
    createPullRequest: (() => {
      let n = 100;
      return async () => ({ number: ++n, url: `https://github.com/o/r/pull/${n}`, title: "T", state: "open", headBranch: "b", baseBranch: "main" });
    })()
  });

  const orch = new RemediationOrchestrator(prisma as never, gh, { owner: "o", repo: "r" });
  const findings = [
    { id: "f1", summary: makeGapFinding({ signal: "metric",  requirementId: "req-1", ruleId: "rule.1" }) },
    { id: "f2", summary: makeGapFinding({ signal: "health",  requirementId: "req-2", ruleId: "rule.2" }) },
    { id: "f3", summary: makeGapFinding({ signal: "log",     requirementId: "req-3", ruleId: "rule.3" }) }, // skipped
    { id: "f4", summary: makeGapFinding({ signal: "metric",  requirementId: "req-4", ruleId: "rule.4", outcome: "pass" }) } // skipped
  ];

  const results = await orch.remediateScan("t1", "p1", "s1", findings);
  assert.equal(results.length, 4);
  assert.equal(results[0].status, "open");
  assert.equal(results[1].status, "open");
  assert.equal(results[2].skipped, true, "trace finding should be skipped");
  assert.equal(results[3].skipped, true, "pass finding should be skipped");
});

// ─── 4. Critical 1: SHA-256 Branch Name Hashing ─────────────────────────────

test("buildBranchName: generates distinct branch names for different findings under same UUID tenant", () => {
  const tenantId = "b9112248-1234-4567-89ab-cdef01234567";
  const key1 = buildIdempotencyKey(tenantId, "finding-1", "rule.metric.present", "1.0.0");
  const key2 = buildIdempotencyKey(tenantId, "finding-2", "rule.metric.present", "1.0.0");
  const b1 = buildBranchName("cloudpilot/remediate", key1);
  const b2 = buildBranchName("cloudpilot/remediate", key2);

  assert.notEqual(b1, b2, "Different findings in same UUID tenant must produce different branch names");
  assert.ok(b1.startsWith("cloudpilot/remediate/"), "Branch name must start with prefix");
  assert.ok(b2.startsWith("cloudpilot/remediate/"), "Branch name must start with prefix");
  assert.ok(b1.length <= 60, "Branch name must be bounded");
  assert.ok(/^[a-zA-Z0-9_\-\/]+$/.test(b1), "Branch name must only contain safe characters");
});

test("buildBranchName: same key always produces exact same branch name", () => {
  const key = buildIdempotencyKey("tenant-uuid", "f-123", "rule.1", "1.0.0");
  const b1 = buildBranchName("cloudpilot/remediate", key);
  const b2 = buildBranchName("cloudpilot/remediate", key);
  assert.equal(b1, b2, "Same key must produce identical branch name");
});

// ─── 5. Critical 2: Structural YAML AST Manipulation ─────────────────────────

test("patchObservabilityYaml: preserves unrelated configuration, keys, and comments", () => {
  const inputYaml = [
    "# Top-level configuration header",
    "version: '2.0'",
    "unrelated_service:",
    "  host: 'internal.corp'",
    "  port: 8080",
    "metrics:",
    "  - name: existing_metric",
    "    interval: 15s"
  ].join("\n");

  const outputYaml = patchObservabilityYaml(
    inputYaml,
    "metrics",
    "name",
    "new_metric",
    "cloudpilot:remediated:rule.1"
  );

  assert.ok(outputYaml.includes("existing_metric"), "Existing metric must be preserved");
  assert.ok(outputYaml.includes("new_metric"), "New metric must be added");
  assert.ok(outputYaml.includes("unrelated_service:"), "Unrelated configuration must be preserved");
  assert.ok(outputYaml.includes("internal.corp"), "Unrelated values must be preserved");
  assert.ok(outputYaml.includes("Top-level configuration header"), "Comments must be preserved");
});

test("patchObservabilityYaml: avoids duplicate requirements (idempotent)", () => {
  const inputYaml = [
    "metrics:",
    "  - name: cpu_usage",
    "    interval: 10s"
  ].join("\n");

  const outputYaml = patchObservabilityYaml(
    inputYaml,
    "metrics",
    "name",
    "cpu_usage",
    "cloudpilot:remediated:rule.1"
  );

  assert.equal(outputYaml, inputYaml, "Duplicate metric should result in no-op return");
});

test("patchObservabilityYaml: handles placeholder files with empty flow sequences", () => {
  const placeholder = [
    "# CloudPilot Observability — Metrics Configuration",
    "# cloudpilot:metrics",
    "metrics: []",
    ""
  ].join("\n");

  const outputYaml = patchObservabilityYaml(
    placeholder,
    "metrics",
    "name",
    "http_requests_total",
    "cloudpilot:remediated:rule.metrics"
  );

  assert.ok(outputYaml.includes("http_requests_total"));
  assert.ok(outputYaml.includes("cloudpilot:remediated:rule.metrics"));
});

test("patchObservabilityYaml: safely creates missing sequence when key is absent", () => {
  const inputYaml = "version: '1.0'\n";
  const outputYaml = patchObservabilityYaml(
    inputYaml,
    "health_checks",
    "service",
    "auth-service"
  );

  assert.ok(outputYaml.includes("health_checks:"));
  assert.ok(outputYaml.includes("service: auth-service"));
});

test("patchObservabilityYaml: throws MalformedYamlError on invalid YAML syntax", () => {
  const badYaml = "metrics:\n  - name: foo\n  bad: [unbalanced";
  assert.throws(
    () => patchObservabilityYaml(badYaml, "metrics", "name", "bar"),
    MalformedYamlError
  );
});

test("patchObservabilityYaml: throws UnsupportedYamlStructureError on non-sequence property", () => {
  const invalidStructureYaml = "metrics: 'this-should-be-a-list'\n";
  assert.throws(
    () => patchObservabilityYaml(invalidStructureYaml, "metrics", "name", "bar"),
    UnsupportedYamlStructureError
  );
});

// ─── 6. Medium 2: Dynamic Repository Resolution ─────────────────────────────

test("parseGitHubRepoUrl: correctly parses valid GitHub HTTPS URLs", () => {
  const res1 = parseGitHubRepoUrl("https://github.com/my-org/my-service");
  assert.deepEqual(res1, { owner: "my-org", repo: "my-service" });

  const res2 = parseGitHubRepoUrl("https://github.com/my-org/my-service.git");
  assert.deepEqual(res2, { owner: "my-org", repo: "my-service" });
});

test("parseGitHubRepoUrl: rejects invalid, non-HTTPS, or off-host URLs", () => {
  assert.equal(parseGitHubRepoUrl("http://github.com/my-org/my-service"), null);
  assert.equal(parseGitHubRepoUrl("https://gitlab.com/my-org/my-service"), null);
  assert.equal(parseGitHubRepoUrl("https://github.com/my-org/my-service/extra/path"), null);
  assert.equal(parseGitHubRepoUrl("https://github.com/my-org"), null);
  assert.equal(parseGitHubRepoUrl("not-a-url"), null);
});

test("RemediationOrchestrator: resolves target repo dynamically from project repositoryUrl", async () => {
  const remediations = new Map<string, unknown>();
  const prismaMock = {
    ...makePrisma(remediations) as object,
    project: {
      findFirst: async () => ({ repositoryUrl: "https://github.com/dynamic-org/dynamic-repo.git" })
    }
  };

  let targetOwner = "";
  let targetRepo = "";
  const gh = makeConnectorStub({
    getBranchSha: async (owner: string, repo: string) => {
      targetOwner = owner;
      targetRepo = repo;
      return { name: "main", sha: "a".repeat(40) };
    }
  });

  const orch = new RemediationOrchestrator(
    prismaMock as never,
    gh,
    { owner: "sandbox-owner", repo: "sandbox-repo" }
  );

  await orch.remediateOne("t1", "p1", "s1", "f1", makeGapFinding());
  assert.equal(targetOwner, "dynamic-org", "Should use dynamically resolved owner");
  assert.equal(targetRepo, "dynamic-repo", "Should use dynamically resolved repo");
});

// ─── 7. Medium 3: Non-Retryable Error & Retry Budget ────────────────────────

test("RemediationOrchestrator: non-retryable 403 Forbidden immediately transitions to failed with retriesLeft=0", async () => {
  const remediations = new Map<string, unknown>();
  const prisma = makePrisma(remediations);
  const gh = makeConnectorStub({
    getBranchSha: async () => {
      throw new GitHubApiError("Forbidden: write access denied", 403, "Forbidden");
    }
  });

  const orch = new RemediationOrchestrator(prisma as never, gh, { owner: "o", repo: "r" });
  const result = await orch.remediateOne("t1", "p1", "s1", "f1", makeGapFinding());

  assert.equal(result.status, "failed");
  const stored = remediations.get(`key:${buildIdempotencyKey("t1", "f1", "rule.metric.present", "1.0.0")}`) as any;
  assert.equal(stored.retriesLeft, 0, "Non-retryable error must immediately exhaust retries");
  assert.equal(stored.status, "failed");
});

test("RemediationOrchestrator: failed remediation is not re-attempted without explicit retrigger", async () => {
  const remediations = new Map<string, unknown>();
  const key = buildIdempotencyKey("t1", "f1", "rule.metric.present", "1.0.0");
  remediations.set(`key:${key}`, {
    id: "rem-failed-1",
    tenantId: "t1",
    idempotencyKey: key,
    status: "failed",
    retriesLeft: 0,
    patchSummary: "summary"
  });

  let githubCalled = false;
  const gh = makeConnectorStub({
    getBranchSha: async () => { githubCalled = true; return { name: "main", sha: "a".repeat(40) }; }
  });

  const orch = new RemediationOrchestrator(makePrisma(remediations) as never, gh, { owner: "o", repo: "r" });
  const result = await orch.remediateOne("t1", "p1", "s1", "f1", makeGapFinding());

  assert.equal(result.status, "failed");
  assert.equal(result.skipped, true);
  assert.equal(githubCalled, false, "GitHub should not be called when already failed and no retrigger option");

  // Now call with retrigger: true
  const retryResult = await orch.remediateOne("t1", "p1", "s1", "f1", makeGapFinding(), { retrigger: true });
  assert.equal(githubCalled, true, "GitHub should be called when retrigger: true is provided");
  assert.equal(retryResult.status, "open");
});

// ─── 8. High 4: Audit Event Recording ───────────────────────────────────────

test("RemediationOrchestrator: records append-only audit events on trigger and PR open", async () => {
  const auditEvents: Array<{ action: string; tenantId: string; metadata: any }> = [];
  const stubAuditRepo = {
    record: async (input: any) => {
      auditEvents.push(input);
      return input;
    }
  };

  const prisma = makePrisma();
  const gh = makeConnectorStub();
  const orch = new RemediationOrchestrator(
    prisma as never,
    gh,
    { owner: "o", repo: "r" },
    stubAuditRepo as any
  );

  await orch.remediateOne("t1", "p1", "s1", "f1", makeGapFinding(), { actorId: "user-123" });

  assert.ok(auditEvents.length >= 2, "Must record at least TRIGGERED and PR_OPENED");
  assert.equal(auditEvents[0].action, "REMEDIATION_TRIGGERED");
  assert.equal(auditEvents[0].tenantId, "t1");
  assert.equal(auditEvents[1].action, "REMEDIATION_PR_OPENED");

  // Verify no access tokens in audit metadata
  for (const ev of auditEvents) {
    const metaStr = JSON.stringify(ev.metadata);
    assert.ok(!metaStr.includes("token"), "Audit metadata must never contain tokens");
  }
});

// ─── 9. High 5: RemediationRepository Cursor Validation ─────────────────────

test("RemediationRepository: throws InvalidCursorError when cursor does not exist", async () => {
  const prismaMock = {
    remediation: {
      findFirst: async () => null // cursor not found
    }
  };

  const repo = new RemediationRepository(prismaMock as never);
  await assert.rejects(
    () => repo.listByProject("tenant-a", "proj-a", { cursor: "invalid-cursor-id" }),
    InvalidCursorError
  );
});


// ─── 10. Structured Metric Evidence & Label Selector Remediation ─────────────

test("planRemediation: CP-RULE-OBS-GAP-METRIC-PRESENT derives demo_http_server_requests_total and all three required labels instead of requirementId", () => {
  const finding = makeGapFinding({
    requirementId: "demo-request-metric",
    ruleId: "CP-RULE-OBS-GAP-METRIC-PRESENT",
    ruleVersion: "1.0.0",
    signal: "metric",
    outcome: "gap",
    expected: "demo_http_server_requests_total for service=demo-service, route=/api/demo, method=GET with value >= 1",
    observed: "0 matching series in fresh Prometheus evidence (1 total samples)",
    reason: "Metric demo_http_server_requests_total did not meet minimum count 1 (observed 0).",
    evidenceJson: {
      evidence: {
        data: {
          source: "prometheus",
          samples: [
            {
              metricName: "demo_http_server_requests_total",
              labels: {
                serviceName: "demo-service",
                route: "/api/demo",
                method: "GET",
                statusCode: "200"
              },
              value: 0
            }
          ]
        }
      }
    }
  });

  const patch = planRemediation(finding);
  assert.equal(patch.filePath, "config/observability/metrics.yaml");
  assert.equal(patch.prTitle, "fix(observability): add missing metric 'demo_http_server_requests_total'");
  assert.equal(patch.commitMessage, "fix(metrics): add demo_http_server_requests_total — demo-request-metric");
  assert.equal(
    patch.summary,
    "Add metric 'demo_http_server_requests_total' (service=demo-service, route=/api/demo, method=GET) to metrics.yaml"
  );
  assert.ok(!patch.prTitle.includes("demo_request_metric"));

  const rendered = patch.applyPatch(patch.initialFileContent);
  const expectedYaml = [
    "# CloudPilot Observability — Metrics Configuration",
    "# cloudpilot:metrics",
    "metrics:",
    "  - name: demo_http_server_requests_total",
    "    labels:",
    "      service: demo-service",
    "      route: /api/demo",
    "      method: GET",
    "    # cloudpilot:remediated:CP-RULE-OBS-GAP-METRIC-PRESENT",
    ""
  ].join("\n");

  assert.equal(rendered, expectedYaml);
  assert.equal(patch.applyPatch(rendered), rendered, "Applying metric patch twice must be idempotent");
});

test("planRemediation: derives metric name and required labels from structured evidenceJson when expected is empty", () => {
  const finding = makeGapFinding({
    requirementId: "demo-request-metric",
    ruleId: "CP-RULE-OBS-GAP-METRIC-PRESENT",
    ruleVersion: "1.0.0",
    signal: "metric",
    outcome: "gap",
    expected: "",
    observed: "0",
    reason: "Missing request metric",
    evidenceJson: {
      evidence: {
        data: {
          source: "prometheus",
          samples: [
            {
              metricName: "demo_http_server_requests_total",
              labels: {
                serviceName: "demo-service",
                route: "/api/demo",
                method: "GET"
              },
              value: 0
            }
          ]
        }
      }
    }
  });

  const patch = planRemediation(finding);
  const rendered = patch.applyPatch(patch.initialFileContent);
  assert.ok(rendered.includes("name: demo_http_server_requests_total"));
  assert.ok(rendered.includes("service: demo-service"));
  assert.ok(rendered.includes("route: /api/demo"));
  assert.ok(rendered.includes("method: GET"));
});

test("planRemediation: rejects missing metric or label evidence for CP-RULE-OBS-GAP-METRIC-PRESENT without falling back to requirementId", () => {
  // Unstructured expected string with no evidenceJson must not fall back to requirementId
  assert.throws(
    () =>
      planRemediation(
        makeGapFinding({
          requirementId: "demo-request-metric",
          ruleId: "CP-RULE-OBS-GAP-METRIC-PRESENT",
          expected: "minimumCount >= 1"
        })
      ),
    UnsupportedFindingError
  );

  // Invalid requirement fallback message from evaluation.ts
  assert.throws(
    () =>
      planRemediation(
        makeGapFinding({
          requirementId: "demo-request-metric",
          ruleId: "CP-RULE-OBS-GAP-METRIC-PRESENT",
          expected: "Valid request metric requirement with non-empty id, serviceName, metricName and route."
        })
      ),
    UnsupportedFindingError
  );

  // Missing service label
  assert.throws(
    () =>
      planRemediation(
        makeGapFinding({
          requirementId: "demo-request-metric",
          ruleId: "CP-RULE-OBS-GAP-METRIC-PRESENT",
          expected: "demo_http_server_requests_total for route=/api/demo, method=GET with value >= 1"
        })
      ),
    UnsupportedFindingError
  );

  // Missing route label
  assert.throws(
    () =>
      planRemediation(
        makeGapFinding({
          requirementId: "demo-request-metric",
          ruleId: "CP-RULE-OBS-GAP-METRIC-PRESENT",
          expected: "demo_http_server_requests_total for service=demo-service, method=GET with value >= 1"
        })
      ),
    UnsupportedFindingError
  );

  // Missing method label on request metric
  assert.throws(
    () =>
      planRemediation(
        makeGapFinding({
          requirementId: "demo-request-metric",
          ruleId: "CP-RULE-OBS-GAP-METRIC-PRESENT",
          expected: "demo_http_server_requests_total for service=demo-service, route=/api/demo with value >= 1"
        })
      ),
    UnsupportedFindingError
  );

  // Empty samples in evidenceJson and empty expected
  assert.throws(
    () =>
      planRemediation(
        makeGapFinding({
          requirementId: "demo-request-metric",
          ruleId: "CP-RULE-OBS-GAP-METRIC-PRESENT",
          expected: "",
          evidenceJson: { evidence: { data: { source: "prometheus", samples: [] } } }
        })
      ),
    UnsupportedFindingError
  );
});

test("planRemediation: rejects ambiguous or conflicting metric evidence", () => {
  // Conflict between expected metricName and evidenceJson sample metricName
  assert.throws(
    () =>
      planRemediation(
        makeGapFinding({
          requirementId: "demo-request-metric",
          ruleId: "CP-RULE-OBS-GAP-METRIC-PRESENT",
          expected: "demo_http_server_requests_total for service=demo-service, route=/api/demo, method=GET with value >= 1",
          evidenceJson: {
            evidence: {
              data: {
                samples: [
                  {
                    metricName: "other_http_requests_total",
                    labels: { serviceName: "demo-service", route: "/api/demo", method: "GET" },
                    value: 0
                  }
                ]
              }
            }
          }
        })
      ),
    UnsupportedFindingError
  );

  // Conflict between expected route/method and evidenceJson sample labels
  assert.throws(
    () =>
      planRemediation(
        makeGapFinding({
          requirementId: "demo-request-metric",
          ruleId: "CP-RULE-OBS-GAP-METRIC-PRESENT",
          expected: "demo_http_server_requests_total for service=demo-service, route=/api/demo, method=GET with value >= 1",
          evidenceJson: {
            evidence: {
              data: {
                samples: [
                  {
                    metricName: "demo_http_server_requests_total",
                    labels: { serviceName: "demo-service", route: "/api/other", method: "GET" },
                    value: 0
                  }
                ]
              }
            }
          }
        })
      ),
    UnsupportedFindingError
  );

  // Ambiguous evidence samples with multiple distinct routes/metrics
  assert.throws(
    () =>
      planRemediation(
        makeGapFinding({
          requirementId: "demo-request-metric",
          ruleId: "CP-RULE-OBS-GAP-METRIC-PRESENT",
          expected: "",
          evidenceJson: {
            evidence: {
              data: {
                samples: [
                  {
                    metricName: "demo_http_server_requests_total",
                    labels: { serviceName: "demo-service", route: "/api/demo", method: "GET" },
                    value: 0
                  },
                  {
                    metricName: "demo_http_server_requests_total",
                    labels: { serviceName: "demo-service", route: "/api/admin", method: "POST" },
                    value: 0
                  }
                ]
              }
            }
          }
        })
      ),
    UnsupportedFindingError
  );

  // Duplicate label keys in expected string
  assert.throws(
    () =>
      planRemediation(
        makeGapFinding({
          requirementId: "demo-request-metric",
          ruleId: "CP-RULE-OBS-GAP-METRIC-PRESENT",
          expected: "demo_http_server_requests_total for service=demo-service, service=alt-service, route=/api/demo, method=GET with value >= 1"
        })
      ),
    UnsupportedFindingError
  );
});

test("planRemediation: accepts service_name alias in expected selectors and evidenceJson and normalizes to labels.service", () => {
  const fromExpected = planRemediation(
    makeGapFinding({
      requirementId: "demo-request-metric",
      ruleId: "CP-RULE-OBS-GAP-METRIC-PRESENT",
      expected: "demo_http_server_requests_total for service_name=demo-service, route=/api/demo, method=GET with value >= 1"
    })
  );
  assert.equal(
    fromExpected.summary,
    "Add metric 'demo_http_server_requests_total' (service=demo-service, route=/api/demo, method=GET) to metrics.yaml"
  );
  const renderedFromExpected = fromExpected.applyPatch(fromExpected.initialFileContent);
  assert.ok(renderedFromExpected.includes("      service: demo-service\n"));
  assert.ok(!renderedFromExpected.includes("service_name:"));

  const fromEvidence = planRemediation(
    makeGapFinding({
      requirementId: "demo-request-metric",
      ruleId: "CP-RULE-OBS-GAP-METRIC-PRESENT",
      expected: "",
      evidenceJson: {
        evidence: {
          data: {
            source: "prometheus",
            samples: [
              {
                metricName: "demo_http_server_requests_total",
                labels: {
                  service_name: "demo-service",
                  route: "/api/demo",
                  method: "GET"
                },
                value: 0
              }
            ]
          }
        }
      }
    })
  );
  assert.equal(fromEvidence.applyPatch(fromEvidence.initialFileContent), renderedFromExpected);

  const fromRootEvidence = planRemediation(
    makeGapFinding({
      requirementId: "demo-request-metric",
      ruleId: "CP-RULE-OBS-GAP-METRIC-PRESENT",
      expected: "",
      evidenceJson: {
        metricName: "demo_http_server_requests_total",
        service_name: "demo-service",
        route: "/api/demo",
        method: "GET"
      }
    })
  );
  assert.equal(fromRootEvidence.applyPatch(fromRootEvidence.initialFileContent), renderedFromExpected);
});

test("planRemediation: accepts matching service aliases across expected selectors and evidenceJson", () => {
  const patch = planRemediation(
    makeGapFinding({
      requirementId: "demo-request-metric",
      ruleId: "CP-RULE-OBS-GAP-METRIC-PRESENT",
      expected:
        "demo_http_server_requests_total for service=demo-service, service_name=demo-service, route=/api/demo, method=GET with value >= 1",
      evidenceJson: {
        evidence: {
          data: {
            source: "prometheus",
            samples: [
              {
                metricName: "demo_http_server_requests_total",
                labels: {
                  exported_job: "demo-service",
                  serviceName: "demo-service",
                  service_name: "demo-service",
                  route: "/api/demo",
                  method: "GET"
                },
                value: 0
              }
            ]
          }
        }
      }
    })
  );
  const rendered = patch.applyPatch(patch.initialFileContent);
  assert.ok(rendered.includes("      service: demo-service\n"));
  assert.equal(patch.applyPatch(rendered), rendered);
});

test("planRemediation: rejects conflicting service aliases and unknown selector keys", () => {
  for (const expected of [
    "demo_http_server_requests_total for service=demo-service, service_name=other-service, route=/api/demo, method=GET with value >= 1",
    "demo_http_server_requests_total for service_name=other-service, service=demo-service, route=/api/demo, method=GET with value >= 1",
    "demo_http_server_requests_total for service_name=demo-service",
    "demo_http_server_requests_total for service_name=demo-service, pod_name=demo-pod, route=/api/demo, method=GET with value >= 1"
  ]) {
    assert.throws(
      () =>
        planRemediation(
          makeGapFinding({
            requirementId: "demo-request-metric",
            ruleId: "CP-RULE-OBS-GAP-METRIC-PRESENT",
            expected
          })
        ),
      UnsupportedFindingError
    );
  }

  for (const conflictingLabels of [
    { exported_job: "demo-service", service_name: "other-service" },
    { service: "demo-service", service_name: "other-service" },
    { serviceName: "demo-service", service_name: "other-service" },
    { serviceName: "demo-service", exported_job: "other-service" },
    { exported_job: "demo-service", service_name: "" }
  ]) {
    assert.throws(
      () =>
        planRemediation(
          makeGapFinding({
            requirementId: "demo-request-metric",
            ruleId: "CP-RULE-OBS-GAP-METRIC-PRESENT",
            expected: "",
            evidenceJson: {
              evidence: {
                data: {
                  samples: [
                    {
                      metricName: "demo_http_server_requests_total",
                      labels: {
                        ...conflictingLabels,
                        route: "/api/demo",
                        method: "GET"
                      },
                      value: 0
                    }
                  ]
                }
              }
            }
          })
        ),
      UnsupportedFindingError
    );
  }

  assert.throws(
    () =>
      planRemediation(
        makeGapFinding({
          requirementId: "demo-request-metric",
          ruleId: "CP-RULE-OBS-GAP-METRIC-PRESENT",
          expected: "demo_http_server_requests_total for service_name=demo-service, route=/api/demo, method=GET with value >= 1",
          evidenceJson: {
            evidence: {
              data: {
                samples: [
                  {
                    metricName: "demo_http_server_requests_total",
                    labels: {
                      exported_job: "other-service",
                      route: "/api/demo",
                      method: "GET"
                    },
                    value: 0
                  }
                ]
              }
            }
          }
        })
      ),
    UnsupportedFindingError
  );
});

test("planRemediation: alert gap produces valid Prometheus groups[].rules[] YAML and is idempotent", () => {
  const patch = planRemediation(
    makeGapFinding({
      signal: "alert",
      requirementId: "demo-heartbeat-alert",
      expected: "alert rule demo_heartbeat_alert loaded in prometheus"
    })
  );

  assert.equal(patch.filePath, "config/observability/alert-rules.yaml");
  const once = patch.applyPatch(patch.initialFileContent);
  assert.ok(once.includes("groups:"));
  assert.ok(once.includes("name: cloudpilot_alerts"));
  assert.ok(once.includes("alert: demo_heartbeat_alert"));
  assert.ok(once.includes("expr:"));
  assert.doesNotThrow(() => validatePrometheusAlertRulesYaml(once));

  const twice = patch.applyPatch(once);
  assert.equal(twice, once);
});

test("validatePrometheusAlertRulesYaml rejects malformed, missing groups, invalid alert name, and empty expr", () => {
  assert.throws(() => validatePrometheusAlertRulesYaml("not: [valid: yaml"), MalformedYamlError);
  assert.throws(() => validatePrometheusAlertRulesYaml("alerts: []\n"), UnsupportedYamlStructureError);
  assert.throws(
    () =>
      validatePrometheusAlertRulesYaml(
        "groups:\n  - name: cloudpilot_alerts\n    rules:\n      - alert: bad-name!\n        expr: up == 0\n"
      ),
    UnsupportedYamlStructureError
  );
  assert.throws(
    () =>
      validatePrometheusAlertRulesYaml(
        "groups:\n  - name: cloudpilot_alerts\n    rules:\n      - alert: valid_alert\n        expr: \"\"\n"
      ),
    UnsupportedYamlStructureError
  );
  assert.throws(
    () =>
      patchPrometheusAlertRulesYaml("alerts: []\n", {
        alert: "valid_alert",
        expr: "up == 0",
        severity: "warning",
        requirementId: "valid_alert",
        summary: "Test alert"
      }),
    UnsupportedYamlStructureError
  );
});

test("planRemediation: trace gap produces valid config/observability/tracing.yaml patch and is idempotent", () => {
  const patch = planRemediation(
    makeGapFinding({
      signal: "trace",
      requirementId: "demo-traces",
      expected: "Jaeger contains at least one recent trace for service 'demo-service'."
    })
  );
  assert.equal(patch.filePath, "config/observability/tracing.yaml");
  const once = patch.applyPatch(patch.initialFileContent);
  assert.ok(once.includes("enabled: true"));
  assert.ok(once.includes("tracecontext"));
  assert.ok(once.includes("baggage"));
  assert.ok(once.includes("demo-service"));
  const twice = patch.applyPatch(once);
  assert.equal(twice, once);
});
