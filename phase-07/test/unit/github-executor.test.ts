import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GitHubApiError,
  GitHubConflictError,
  GitHubConnector,
  GitHubNotFoundError,
  PullRequest
} from "../../src/github/github-connector.js";
import {
  GitHubRemediationExecutor,
  GitHubExecutionOutcome
} from "../../src/remediation/github-executor.js";
import { FindingSummary } from "../../src/remediation/planner.js";

const finding: FindingSummary = {
  requirementId: "req-demo-requests",
  ruleId: "rule.metric.present",
  ruleVersion: "1.0.0",
  signal: "metric",
  outcome: "gap",
  expected: "request metric exists",
  observed: "request metric missing",
  reason: "No request metric was observed."
};

const target = { owner: "sandbox", repo: "service" };
const key = "tenant:finding:rule.metric.present:1.0.0";
const initialContent = "# cloudpilot:metrics\nmetrics: []\n";

function harness(options: {
  ambiguousBranch?: boolean;
  ambiguousFile?: boolean;
  ambiguousPr?: boolean;
  existingPrState?: "open" | "closed" | "merged";
} = {}) {
  const branches = new Map<string, string>([["main", "a".repeat(40)]]);
  const files = new Map<string, { content: string; sha: string }>([
    ["main", { content: initialContent, sha: "base-file-sha" }]
  ]);
  const prs = new Map<string, PullRequest>();
  const calls = { createBranch: 0, updateFile: 0, createPullRequest: 0, findPullRequestByHead: 0 };
  let ambiguousBranch = options.ambiguousBranch ?? false;
  let ambiguousFile = options.ambiguousFile ?? false;
  let ambiguousPr = options.ambiguousPr ?? false;
  const sha = "b".repeat(40);

  const github = {
    getBranchSha: async (_owner: string, _repo: string, branch: string) => {
      const branchSha = branches.get(branch);
      if (!branchSha) throw new GitHubNotFoundError("not found", "{}");
      return { name: branch, sha: branchSha };
    },
    createBranch: async (_owner: string, _repo: string, branch: string) => {
      calls.createBranch++;
      if (branches.has(branch)) throw new GitHubConflictError("branch exists", "{}");
      branches.set(branch, sha);
      files.set(branch, { ...files.get("main")! });
      if (ambiguousBranch) {
        ambiguousBranch = false;
        throw new GitHubApiError("network timeout", 0, "");
      }
    },
    getFileContent: async (_owner: string, _repo: string, path: string, branch: string) => {
      const file = files.get(branch);
      if (!file) throw new GitHubNotFoundError("not found", "{}");
      return { path, ...file, encoding: "base64" };
    },
    updateFile: async (input: { branch: string; content: string }) => {
      calls.updateFile++;
      files.set(input.branch, { content: input.content, sha: `updated-${calls.updateFile}` });
      if (ambiguousFile) {
        ambiguousFile = false;
        throw new GitHubApiError("network timeout", 0, "");
      }
      return "updated-sha";
    },
    createPullRequest: async (input: { head: string; base: string; title: string; body: string; draft?: boolean }) => {
      calls.createPullRequest++;
      if (prs.has(input.head)) throw new GitHubConflictError("PR already exists", "{}");
      const pr: PullRequest = {
        number: 17,
        url: "https://github.com/sandbox/service/pull/17",
        title: input.title,
        state: "open",
        headBranch: input.head,
        baseBranch: input.base
      };
      prs.set(input.head, pr);
      if (ambiguousPr) {
        ambiguousPr = false;
        throw new GitHubApiError("network timeout", 0, "");
      }
      return pr;
    },
    findPullRequestByHead: async (_owner: string, _repo: string, head: string) => {
      calls.findPullRequestByHead++;
      return prs.get(head) ?? null;
    }
  } as unknown as GitHubConnector;

  const executor = new GitHubRemediationExecutor(github, { draft: true });
  const prepared = executor.prepare(finding, key);
  if (options.existingPrState) {
    prs.set(prepared.branchName, {
      number: 11,
      url: "https://github.com/sandbox/service/pull/11",
      title: "historical remediation",
      state: options.existingPrState,
      headBranch: prepared.branchName,
      baseBranch: "main"
    });
  }
  return { executor, prepared, branches, files, prs, calls };
}

test("executor creates a deterministic branch, applies YAML patch, and opens a draft PR", async () => {
  const h = harness();
  const outcome = await h.executor.execute(target, h.prepared);

  assert.equal(outcome.kind, "pull-request");
  if (outcome.kind !== "pull-request") return;
  assert.equal(outcome.disposition, "created");
  assert.equal(outcome.prNumber, 17);
  assert.ok(h.branches.has(outcome.branchName));
  assert.ok(h.files.get(outcome.branchName)?.content.includes("req_demo_requests"));
  assert.equal(h.calls.createBranch, 1);
  assert.equal(h.calls.updateFile, 1);
  assert.equal(h.calls.createPullRequest, 1);
});

test("repeated execution reconciles the same branch and PR without duplicate creation", async () => {
  const h = harness();
  const first = await h.executor.execute(target, h.prepared);
  const second = await h.executor.execute(target, h.prepared);

  assert.equal(first.kind, "pull-request");
  assert.equal(second.kind, "pull-request");
  if (second.kind === "pull-request") assert.equal(second.disposition, "reconciled");
  assert.equal(h.calls.createBranch, 1);
  assert.equal(h.calls.updateFile, 1);
  assert.equal(h.calls.createPullRequest, 1);
  assert.equal(h.prs.size, 1);
});

test("existing open PR is reconciled and reused", async () => {
  const h = harness({ existingPrState: "open" });
  const outcome = await h.executor.execute(target, h.prepared);

  assert.equal(outcome.kind, "pull-request");
  if (outcome.kind === "pull-request") {
    assert.equal(outcome.disposition, "reconciled");
    assert.equal(outcome.prNumber, 11);
  }
  assert.equal(h.calls.createBranch, 0);
  assert.equal(h.calls.createPullRequest, 0);
});

test("existing merged PR returns already-completed and never creates another PR", async () => {
  const h = harness({ existingPrState: "merged" });
  const outcome = await h.executor.execute(target, h.prepared);

  assert.equal(outcome.kind, "already-completed");
  if (outcome.kind === "already-completed") assert.equal(outcome.prNumber, 11);
  assert.equal(h.calls.createBranch, 0);
  assert.equal(h.calls.createPullRequest, 0);
});

test("existing closed unmerged PR returns manual-review and never creates another PR", async () => {
  const h = harness({ existingPrState: "closed" });
  const outcome = await h.executor.execute(target, h.prepared);

  assert.equal(outcome.kind, "manual-review");
  if (outcome.kind === "manual-review") {
    assert.equal(outcome.prNumber, 11);
    assert.match(outcome.message, /manual review/i);
  }
  assert.equal(h.calls.createBranch, 0);
  assert.equal(h.calls.createPullRequest, 0);
});

test("concurrent executions converge on one deterministic branch and PR", async () => {
  const h = harness();
  const [first, second] = await Promise.all([
    h.executor.execute(target, h.prepared),
    h.executor.execute(target, h.prepared)
  ]);

  assert.equal(first.kind, "pull-request");
  assert.equal(second.kind, "pull-request");
  assert.equal(h.branches.size, 2, "Only main and one remediation branch should exist");
  assert.equal(h.prs.size, 1, "Only one PR should exist for the deterministic branch");
  assert.ok(h.calls.createPullRequest >= 1 && h.calls.createPullRequest <= 2);
});

test("ambiguous branch creation timeout reconciles the created branch", async () => {
  const h = harness({ ambiguousBranch: true });
  const outcome = await h.executor.execute(target, h.prepared);

  assert.equal(outcome.kind, "pull-request");
  assert.equal(h.calls.createBranch, 1);
  assert.equal(h.calls.createPullRequest, 1);
});

test("ambiguous file update timeout reads back the patch before continuing", async () => {
  const h = harness({ ambiguousFile: true });
  const outcome = await h.executor.execute(target, h.prepared);

  assert.equal(outcome.kind, "pull-request");
  assert.equal(h.calls.updateFile, 1);
  assert.equal(h.calls.createPullRequest, 1);
});

test("ambiguous PR creation timeout reconciles the existing PR without another create", async () => {
  const h = harness({ ambiguousPr: true });
  const outcome: GitHubExecutionOutcome = await h.executor.execute(target, h.prepared);

  assert.equal(outcome.kind, "pull-request");
  if (outcome.kind === "pull-request") assert.equal(outcome.disposition, "reconciled");
  assert.equal(h.calls.createPullRequest, 1);
  assert.equal(h.prs.size, 1);
});

test("executor reports terminal and retryable failures as structured outcomes", async () => {
  const terminal = harness();
  const terminalExecutor = new GitHubRemediationExecutor({
    ...({} as GitHubConnector),
    findPullRequestByHead: async () => { throw new GitHubApiError("forbidden", 403, ""); }
  } as unknown as GitHubConnector);
  const terminalOutcome = await terminalExecutor.execute(target, terminal.prepared);
  assert.equal(terminalOutcome.kind, "failed");
  if (terminalOutcome.kind === "failed") assert.equal(terminalOutcome.retryable, false);

  const transientExecutor = new GitHubRemediationExecutor({
    ...({} as GitHubConnector),
    findPullRequestByHead: async () => { throw new GitHubApiError("timeout", 0, ""); }
  } as unknown as GitHubConnector);
  const transientOutcome = await transientExecutor.execute(target, terminal.prepared);
  assert.equal(transientOutcome.kind, "failed");
  if (transientOutcome.kind === "failed") assert.equal(transientOutcome.retryable, true);
});

test("executor converts a valid 429 Retry-After delta into delay metadata", async () => {
  const h = harness();
  const executor = new GitHubRemediationExecutor({
    ...({} as GitHubConnector),
    findPullRequestByHead: async () => { throw new GitHubApiError("rate limited", 429, "", "7"); }
  } as unknown as GitHubConnector);
  const outcome = await executor.execute(target, h.prepared);

  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assert.equal(outcome.retryable, true);
    assert.equal(outcome.retryAfterMs, 7_000);
  }
});

test("GitHubConnector preserves transient 500, 502 and 504 responses as typed API errors", async () => {
  for (const statusCode of [500, 502, 504]) {
    const connector = new GitHubConnector({
      token: "test-token",
      apiBaseUrl: "https://api.github.test",
      fetchImpl: async () => new Response(JSON.stringify({ message: "upstream failure" }), { status: statusCode })
    });
    await assert.rejects(connector.getBranchSha("sandbox", "service", "main"), (error: unknown) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.statusCode, statusCode);
      return true;
    });
  }
});
