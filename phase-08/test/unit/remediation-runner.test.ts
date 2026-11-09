import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  GitHubApiError,
  GitHubConnector,
  GitHubNotFoundError,
  PullRequest
} from "../../../phase-07/src/github/github-connector.js";
import {
  GitHubExecutionOutcome,
  GitHubRemediationExecutor
} from "../../../phase-07/src/remediation/github-executor.js";
import { FindingSummary } from "../../../phase-07/src/remediation/planner.js";
import {
  RemediationFailure,
  RemediationJobStore,
  RemediationLease,
  RemediationWorkItem,
  retryDelayMs
} from "../../src/jobs/remediation-repo.js";
import { RemediationExecutor, RemediationRunner, mapArtifactExecutionOutcome } from "../../src/jobs/remediation-runner.js";

const finding: FindingSummary = {
  requirementId: "req-http-requests",
  ruleId: "rule.metric.present",
  ruleVersion: "1.0.0",
  signal: "metric",
  outcome: "gap",
  expected: "request metric exists",
  observed: "request metric missing",
  reason: "No request metric was observed."
};

const success: GitHubExecutionOutcome = {
  kind: "pull-request",
  disposition: "created",
  branchName: "cloudpilot/remediate/abc",
  prNumber: 12,
  prUrl: "https://github.com/example/service/pull/12",
  summary: "add request metric"
};

class MemoryStore implements RemediationJobStore {
  now = 1_000_000;
  readonly claims: RemediationLease[] = [];
  readonly jobs = new Map<string, {
    tenantId: string;
    projectId: string;
    status: string;
    retriesLeft: number;
    nextAt: number;
    expiresAt: number;
    lease: RemediationLease | null;
    lastFailure?: RemediationFailure;
  }>();

  add(id: string, retriesLeft = 3, tenantId = "tenant-1"): void {
    this.jobs.set(id, {
      tenantId,
      projectId: `project-${tenantId}`,
      status: "pending",
      retriesLeft,
      nextAt: 0,
      expiresAt: 0,
      lease: null
    });
  }

  async claimNextPending(workerId: string, leaseDurationMs = 60_000): Promise<RemediationLease | null> {
    for (const [id, job] of this.jobs) {
      if (job.status !== "pending" || job.nextAt > this.now) continue;
      const lease: RemediationLease = {
        id,
        tenantId: job.tenantId,
        projectId: job.projectId,
        workerId,
        leaseToken: randomUUID(),
        retriesLeft: job.retriesLeft
      };
      job.status = "running";
      job.expiresAt = this.now + leaseDurationMs;
      job.lease = lease;
      this.claims.push(lease);
      return lease;
    }
    return null;
  }

  async loadWorkItem(lease: RemediationLease): Promise<RemediationWorkItem | null> {
    const job = this.jobs.get(lease.id);
    if (!this.owns(job, lease) || job!.expiresAt <= this.now) return null;
    return {
      id: lease.id,
      tenantId: lease.tenantId,
      projectId: lease.projectId,
      scanId: `scan-${lease.id}`,
      findingId: `finding-${lease.id}`,
      repositoryUrl: "https://github.com/example/service",
      finding
    };
  }

  async renewLease(lease: RemediationLease, leaseDurationMs = 60_000): Promise<boolean> {
    const job = this.jobs.get(lease.id);
    if (!this.owns(job, lease) || job!.expiresAt <= this.now) return false;
    job!.expiresAt = this.now + leaseDurationMs;
    return true;
  }

  async completeLease(lease: RemediationLease, outcome: Exclude<GitHubExecutionOutcome, { kind: "failed" }>): Promise<boolean> {
    const job = this.jobs.get(lease.id);
    if (!this.owns(job, lease) || job!.expiresAt <= this.now) return false;
    job!.status = outcome.kind === "pull-request" ? "open" : outcome.kind === "already-completed" ? "merged" : "closed";
    job!.lease = null;
    return true;
  }

  async failLease(lease: RemediationLease, failure: RemediationFailure): Promise<boolean> {
    const job = this.jobs.get(lease.id);
    if (!this.owns(job, lease) || job!.expiresAt <= this.now) return false;
    job!.lastFailure = failure;
    if (failure.retryable && job!.retriesLeft > 0) {
      job!.retriesLeft--;
      job!.nextAt = this.now + Math.max(retryDelayMs(lease.retriesLeft), failure.retryAfterMs ?? 0);
      job!.status = "pending";
    } else {
      job!.retriesLeft = 0;
      job!.status = "failed";
    }
    job!.lease = null;
    return true;
  }

  async reclaimExpiredLeases(): Promise<{ requeued: number; failed: number; manualReview: number }> {
    let requeued = 0;
    let failed = 0;
    for (const job of this.jobs.values()) {
      if (job.status !== "running" || job.expiresAt > this.now || !job.lease) continue;
      if (job.retriesLeft > 0) {
        job.retriesLeft--;
        job.nextAt = this.now + retryDelayMs(job.lease.retriesLeft);
        job.status = "pending";
        requeued++;
      } else {
        job.status = "failed";
        failed++;
      }
      job.lease = null;
    }
    return { requeued, failed, manualReview: 0 };
  }

  private owns(job: MemoryStore["jobs"] extends Map<string, infer V> ? V | undefined : never, lease: RemediationLease): boolean {
    return !!job && job.status === "running" && job.tenantId === lease.tenantId &&
      job.lease?.leaseToken === lease.leaseToken;
  }
}

class TemporarilyUnavailableStore extends MemoryStore {
  available = true;

  override async completeLease(lease: RemediationLease, outcome: Exclude<GitHubExecutionOutcome, { kind: "failed" }>): Promise<boolean> {
    if (!this.available) throw new Error("simulated database unavailable");
    return super.completeLease(lease, outcome);
  }

  override async failLease(lease: RemediationLease, reason: RemediationFailure): Promise<boolean> {
    if (!this.available) throw new Error("simulated database unavailable");
    return super.failLease(lease, reason);
  }
}

function fakeExecutor(result: GitHubExecutionOutcome | Error = success): RemediationExecutor {
  return {
    prepare: () => ({ idempotencyKey: "key", branchName: success.kind === "pull-request" ? success.branchName : "branch", patch: {} as never }),
    execute: async () => {
      if (result instanceof Error) throw result;
      return result;
    }
  };
}

function runRunner(store: MemoryStore, executor: RemediationExecutor): RemediationRunner {
  return enableLegacyRunnerForTest(new RemediationRunner(store, executor, { workerId: "worker-test", maxConcurrency: 2 }));
}

function enableLegacyRunnerForTest(runner: RemediationRunner): RemediationRunner {
  // Tests exercise lease/retry mechanics independently of the production
  // fail-closed gate. The application host has no way to set this private flag.
  (runner as unknown as { legacyExecutionEnabled: boolean }).legacyExecutionEnabled = true;
  return runner;
}

test("concurrent workers claim distinct jobs and lease tokens", async () => {
  const store = new MemoryStore();
  store.add("rem-a");
  store.add("rem-b");
  const runnerA = runRunner(store, fakeExecutor());
  const runnerB = enableLegacyRunnerForTest(new RemediationRunner(store, fakeExecutor(), { workerId: "worker-b", maxConcurrency: 1 }));

  const claimed = await Promise.all([runnerA.pollOnce(), runnerB.pollOnce()]);
  assert.deepEqual(claimed, [true, true]);
  assert.equal(new Set(store.claims.map((lease) => lease.id)).size, 2);
  assert.equal(new Set(store.claims.map((lease) => lease.leaseToken)).size, 2);
  await Promise.all([runnerA.shutdown(), runnerB.shutdown()]);
});

test("runner is inert by default and cannot send a legacy job to the Phase 07 executor", async () => {
  const store = new MemoryStore();
  store.add("legacy-pending");
  let prepareCalls = 0;
  let executeCalls = 0;
  const executor: RemediationExecutor = {
    prepare: () => { prepareCalls++; throw new Error("must not prepare legacy work"); },
    execute: async () => { executeCalls++; return success; }
  };
  const runner = new RemediationRunner(store, executor, { workerId: "default-disabled" });

  assert.equal(await runner.pollOnce(), false);
  assert.equal(store.claims.length, 0);
  await runner.executeClaimedJob({
    id: "legacy-pending", tenantId: "tenant-1", projectId: "project-tenant-1",
    workerId: "forged-internal-test", leaseToken: "not-a-real-token", retriesLeft: 3
  });
  assert.equal(prepareCalls, 0);
  assert.equal(executeCalls, 0);
  assert.equal(store.jobs.get("legacy-pending")?.status, "pending");
});

test("lease renewal succeeds only while token, tenant and lease are current", async () => {
  const store = new MemoryStore();
  store.add("rem-a");
  const lease = (await store.claimNextPending("worker-a"))!;
  const originalExpiry = store.jobs.get("rem-a")!.expiresAt;

  store.now += 1_000;
  assert.equal(await store.renewLease(lease), true);
  assert.ok(store.jobs.get("rem-a")!.expiresAt > originalExpiry);
  assert.equal(await store.renewLease({ ...lease, tenantId: "tenant-other" }), false);
  store.now = store.jobs.get("rem-a")!.expiresAt + 1;
  assert.equal(await store.renewLease(lease), false);
});

test("stale completion is fenced after recovery and a newer claim", async () => {
  const store = new MemoryStore();
  store.add("rem-a");
  const oldLease = (await store.claimNextPending("worker-old"))!;
  store.now = store.jobs.get("rem-a")!.expiresAt + 1;
  assert.deepEqual(await store.reclaimExpiredLeases(), { requeued: 1, failed: 0, manualReview: 0 });
  store.now = store.jobs.get("rem-a")!.nextAt;
  const newLease = (await store.claimNextPending("worker-new"))!;

  assert.notEqual(oldLease.leaseToken, newLease.leaseToken);
  assert.equal(await store.completeLease(oldLease, success), false);
  assert.equal(store.jobs.get("rem-a")!.status, "running");
  assert.equal(await store.completeLease(newLease, success), true);
  assert.equal(store.jobs.get("rem-a")!.status, "open");
});

test("reaper requeues jobs with retries and fails exhausted jobs", async () => {
  const store = new MemoryStore();
  store.add("retry", 2);
  store.add("exhausted", 0);
  const retryLease = (await store.claimNextPending("worker"))!;
  const exhaustedLease = (await store.claimNextPending("worker"))!;
  store.now = Math.max(...[...store.jobs.values()].map((job) => job.expiresAt)) + 1;

  assert.deepEqual(await store.reclaimExpiredLeases(), { requeued: 1, failed: 1, manualReview: 0 });
  assert.equal(store.jobs.get(retryLease.id)!.status, "pending");
  assert.equal(store.jobs.get(exhaustedLease.id)!.status, "failed");
});

test("transient errors use bounded backoff and valid Retry-After", async () => {
  const store = new MemoryStore();
  store.add("rem-a", 3);
  const retryOutcomes: GitHubExecutionOutcome[] = [
    { kind: "failed", errorCode: "github_http_429", retryable: true, retryAfterMs: 5_000, message: "rate limited" },
    { kind: "failed", errorCode: "github_http_503", retryable: true, message: "unavailable" },
    { kind: "failed", errorCode: "github_http_network", retryable: true, message: "timeout" },
    { kind: "failed", errorCode: "github_http_network", retryable: true, message: "last attempt" }
  ];
  const runner = runRunner(store, fakeExecutor(retryOutcomes.shift()!));

  for (const [index, expectedDelay] of [5_000, 4_000, 8_000].entries()) {
    const lease = (await store.claimNextPending("worker"))!;
    await runner.executeClaimedJob(lease);
    assert.equal(store.jobs.get("rem-a")!.status, "pending");
    assert.equal(store.jobs.get("rem-a")!.nextAt - store.now, expectedDelay);
    if (index < 2) store.now = store.jobs.get("rem-a")!.nextAt;
    const next = retryOutcomes.shift()!;
    (runner as unknown as { executor: RemediationExecutor }).executor = fakeExecutor(next);
  }

  store.now = store.jobs.get("rem-a")!.nextAt;
  const finalLease = (await store.claimNextPending("worker"))!;
  await runner.executeClaimedJob(finalLease);
  assert.equal(store.jobs.get("rem-a")!.status, "failed");
});

for (const statusCode of [500, 502, 504]) {
  test(`GitHub HTTP ${statusCode} retries to exhaustion with bounded scheduling`, async () => {
    const store = new MemoryStore();
    store.add(`http-${statusCode}`, 3);
    let requestCount = 0;
    const connector = new GitHubConnector({
      token: "test-token",
      apiBaseUrl: "https://api.github.test",
      fetchImpl: async () => {
        requestCount++;
        return new Response(JSON.stringify({ message: "temporary upstream failure" }), { status: statusCode });
      }
    });
    const runner = runRunner(store, new GitHubRemediationExecutor(connector));
    const delays = [2_000, 4_000, 8_000];

    for (let attempt = 0; attempt < 4; attempt++) {
      const lease = await store.claimNextPending("worker");
      assert.ok(lease, `attempt ${attempt + 1} should be claimable`);
      await runner.executeClaimedJob(lease);
      if (attempt < 3) {
        const job = store.jobs.get(`http-${statusCode}`)!;
        assert.equal(job.status, "pending");
        assert.equal(job.retriesLeft, 2 - attempt);
        assert.equal(job.nextAt - store.now, delays[attempt]);
        store.now = job.nextAt;
      }
    }

    assert.equal(requestCount, 4, "initial attempt plus exactly three retries");
    assert.equal(store.jobs.get(`http-${statusCode}`)!.status, "failed");
    assert.equal(store.jobs.get(`http-${statusCode}`)!.retriesLeft, 0);
    assert.equal(await store.claimNextPending("worker"), null, "failed job is not retried automatically");
  });
}

test("terminal authorization errors do not retry", async () => {
  const store = new MemoryStore();
  store.add("rem-a");
  const runner = runRunner(store, fakeExecutor({
    kind: "failed",
    errorCode: "github_http_403",
    retryable: false,
    message: "forbidden"
  }));
  const lease = (await store.claimNextPending("worker"))!;
  await runner.executeClaimedJob(lease);
  assert.equal(store.jobs.get("rem-a")!.status, "failed");
  assert.equal(store.jobs.get("rem-a")!.retriesLeft, 0);
});

test("secondary-rate-limit 403 is retried using bounded backoff", async () => {
  const store = new MemoryStore();
  store.add("rem-secondary-limit", 3);
  const runner = runRunner(store, fakeExecutor({
    kind: "failed",
    errorCode: "github_http_403",
    retryable: true,
    message: "You have exceeded a secondary rate limit. Please wait a few minutes."
  }));
  const lease = (await store.claimNextPending("worker"))!;
  await runner.executeClaimedJob(lease);

  const job = store.jobs.get("rem-secondary-limit")!;
  assert.equal(job.status, "pending", "secondary rate limit must be re-queued as pending for retry");
  assert.equal(job.retriesLeft, 2, "retry counter decremented by 1");
  assert.equal(job.nextAt - store.now, 2_000, "scheduled with first bounded backoff delay (2,000ms)");
});

test("secondary-rate-limit 403 with Retry-After respects configured maximum delay", async () => {
  const store = new MemoryStore();
  store.add("rem-capped-retry", 3);
  const runner = enableLegacyRunnerForTest(new RemediationRunner(
    store,
    fakeExecutor({
      kind: "failed",
      errorCode: "github_http_403",
      retryable: true,
      retryAfterMs: 120_000,
      message: "secondary rate limit"
    }),
    { workerId: "worker-test", maxConcurrency: 2, maxRetryAfterMs: 15_000 }
  ));

  const lease = (await store.claimNextPending("worker"))!;
  await runner.executeClaimedJob(lease);

  const job = store.jobs.get("rem-capped-retry")!;
  assert.equal(job.status, "pending");
  assert.equal(job.retriesLeft, 2);
  assert.equal(job.nextAt - store.now, 15_000, "delay must be capped to configured maxRetryAfterMs (15,000ms)");
});

test("permanent 403 authorization failure remains terminal and exhausts retries immediately", async () => {
  const store = new MemoryStore();
  store.add("rem-perm-403", 3);
  const runner = runRunner(store, fakeExecutor({
    kind: "failed",
    errorCode: "github_http_403",
    retryable: false,
    message: "Resource not accessible by integration"
  }));

  const lease = (await store.claimNextPending("worker"))!;
  await runner.executeClaimedJob(lease);

  const job = store.jobs.get("rem-perm-403")!;
  assert.equal(job.status, "failed", "permanent 403 must fail immediately");
  assert.equal(job.retriesLeft, 0, "retries must be exhausted to 0");
  assert.equal(await store.claimNextPending("worker"), null, "terminal failure cannot be re-claimed");
});

test("generic rate_limited outcome is retried using bounded backoff", async () => {
  const store = new MemoryStore();
  store.add("rem-generic-rate-limit", 3);
  const runner = runRunner(store, fakeExecutor({
    kind: "failed",
    errorCode: "rate_limited",
    retryable: true,
    retryAfterMs: 5_000,
    message: "GitHub rate limited the repository request."
  }));

  const lease = (await store.claimNextPending("worker"))!;
  await runner.executeClaimedJob(lease);

  const job = store.jobs.get("rem-generic-rate-limit")!;
  assert.equal(job.status, "pending");
  assert.equal(job.retriesLeft, 2);
  assert.equal(job.nextAt - store.now, 5_000);
});

test("unexpected worker crash is retried and bounded", async () => {
  const store = new MemoryStore();
  store.add("rem-a");
  const runner = runRunner(store, fakeExecutor(new Error("simulated worker crash")));
  const lease = (await store.claimNextPending("worker"))!;
  await runner.executeClaimedJob(lease);

  assert.equal(store.jobs.get("rem-a")!.status, "pending");
  assert.equal(store.jobs.get("rem-a")!.lastFailure?.errorCode, "worker_crash");
  assert.equal(store.jobs.get("rem-a")!.retriesLeft, 2);
});

test("executor reconciles PR after ambiguous create timeout and runner completes job", async () => {
  const store = new MemoryStore();
  store.add("rem-a");
  let branchExists = false;
  let patchedContent = "# cloudpilot:metrics\nmetrics: []\n";
  const prState: { value: PullRequest | null } = { value: null };
  let createCalls = 0;
  const github = {
    findPullRequestByHead: async () => prState.value,
    getBranchSha: async (_owner: string, _repo: string, branch: string) => {
      if (branch === "main") return { name: branch, sha: "a".repeat(40) };
      if (branchExists) return { name: branch, sha: "b".repeat(40) };
      throw new GitHubNotFoundError("not found", "{}");
    },
    createBranch: async () => { branchExists = true; },
    getFileContent: async (_owner: string, _repo: string, path: string) => ({
      path,
      content: patchedContent,
      sha: "file-sha",
      encoding: "base64"
    }),
    updateFile: async (input: { content: string }) => { patchedContent = input.content; return "new-sha"; },
    createPullRequest: async (input: { head: string; base: string; title: string }) => {
      createCalls++;
      prState.value = {
        number: 31,
        url: "https://github.com/example/service/pull/31",
        title: input.title,
        state: "open",
        headBranch: input.head,
        baseBranch: input.base
      };
      throw new GitHubApiError("request timed out", 0, "");
    }
  } as unknown as GitHubConnector;
  const executor = new GitHubRemediationExecutor(github, { draft: true });
  const runner = runRunner(store, executor);
  const lease = (await store.claimNextPending("worker"))!;

  await runner.executeClaimedJob(lease);
  assert.equal(createCalls, 1);
  assert.equal(prState.value?.number, 31);
  assert.equal(store.jobs.get("rem-a")!.status, "open");
});

test("database outage during GitHub execution cannot persist success and recovers after lease expiry", async () => {
  const store = new TemporarilyUnavailableStore();
  store.add("db-outage");
  let signalExecutionStarted!: () => void;
  const executionStarted = new Promise<void>((resolve) => { signalExecutionStarted = resolve; });
  let finishFirstExecution!: (outcome: GitHubExecutionOutcome) => void;
  const firstExecution = new Promise<GitHubExecutionOutcome>((resolve) => { finishFirstExecution = resolve; });
  let calls = 0;
  const executor: RemediationExecutor = {
    prepare: () => ({ idempotencyKey: "key", branchName: "branch", patch: {} as never }),
    execute: async () => {
      calls++;
      if (calls === 1) {
        signalExecutionStarted();
        return firstExecution;
      }
      return success;
    }
  };
  const runner = runRunner(store, executor);
  const firstLease = (await store.claimNextPending("worker-first"))!;
  const firstWork = runner.executeClaimedJob(firstLease);
  await executionStarted;

  store.available = false;
  finishFirstExecution(success);
  await firstWork;
  assert.equal(store.jobs.get("db-outage")!.status, "running", "failed completion and failure writes cannot mark success");
  assert.equal(store.jobs.get("db-outage")!.lease?.leaseToken, firstLease.leaseToken);

  store.now = store.jobs.get("db-outage")!.expiresAt + 1;
  store.available = true;
  assert.deepEqual(await store.reclaimExpiredLeases(), { requeued: 1, failed: 0, manualReview: 0 });
  store.now = store.jobs.get("db-outage")!.nextAt;
  const retryLease = (await store.claimNextPending("worker-recovered"))!;
  assert.notEqual(retryLease.leaseToken, firstLease.leaseToken);
  assert.equal(await store.completeLease(firstLease, success), false, "stale worker remains fenced after recovery");
  await runner.executeClaimedJob(retryLease);
  assert.equal(store.jobs.get("db-outage")!.status, "open");
  assert.equal(calls, 2);
});

test("tenant mismatch cannot renew or complete another tenant's lease", async () => {
  const store = new MemoryStore();
  store.add("rem-a", 3, "tenant-a");
  const lease = (await store.claimNextPending("worker"))!;
  const wrongTenantLease = { ...lease, tenantId: "tenant-b" };

  assert.equal(await store.renewLease(wrongTenantLease), false);
  assert.equal(await store.completeLease(wrongTenantLease, success), false);
  assert.equal(store.jobs.get("rem-a")!.status, "running");
});

test("shutdown without active work is idempotent and stops future claims", async () => {
  const store = new MemoryStore();
  store.add("rem-a");
  const runner = runRunner(store, fakeExecutor());
  const first = runner.shutdown();
  const second = runner.shutdown();
  assert.equal(first, second);
  await first;
  assert.equal(await runner.pollOnce(), false);
  assert.equal(store.jobs.get("rem-a")!.status, "pending");
});

test("shutdown aborts active GitHub execution and discards its result", async () => {
  const store = new MemoryStore();
  store.add("rem-a");
  let started!: () => void;
  const executionStarted = new Promise<void>((resolve) => { started = resolve; });
  let observedSignal: AbortSignal | undefined;
  const executor: RemediationExecutor = {
    prepare: () => ({ idempotencyKey: "key", branchName: "branch", patch: {} as never }),
    execute: async (_target, _prepared, signal) => {
      observedSignal = signal;
      started();
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return success;
    }
  };
  const runner = runRunner(store, executor);
  assert.equal(await runner.pollOnce(), true);
  await executionStarted;
  await runner.shutdown(1_000);
  assert.equal(observedSignal?.aborted, true);
  assert.equal(store.jobs.get("rem-a")!.status, "running");
});

test("execution exceeding shutdown timeout leaves lease recoverable and cannot persist later", async () => {
  const store = new MemoryStore();
  store.add("rem-a");
  let started!: () => void;
  const executionStarted = new Promise<void>((resolve) => { started = resolve; });
  let finishExecution!: (outcome: GitHubExecutionOutcome) => void;
  const execution = new Promise<GitHubExecutionOutcome>((resolve) => { finishExecution = resolve; });
  const executor: RemediationExecutor = {
    prepare: () => ({ idempotencyKey: "key", branchName: "branch", patch: {} as never }),
    execute: async () => { started(); return execution; }
  };
  const runner = runRunner(store, executor);
  assert.equal(await runner.pollOnce(), true);
  await executionStarted;
  const expiry = store.jobs.get("rem-a")!.expiresAt;
  await runner.shutdown(5);
  assert.equal(store.jobs.get("rem-a")!.status, "running");

  finishExecution(success);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(store.jobs.get("rem-a")!.status, "running");
  store.now = expiry + 1;
  assert.deepEqual(await store.reclaimExpiredLeases(), { requeued: 1, failed: 0, manualReview: 0 });
  assert.equal(store.jobs.get("rem-a")!.status, "pending");
});

test("worker completion after lease expiry is rejected", async () => {
  const store = new MemoryStore();
  store.add("rem-a");
  const lease = (await store.claimNextPending("worker"))!;
  let finishExecution!: (outcome: GitHubExecutionOutcome) => void;
  const execution = new Promise<GitHubExecutionOutcome>((resolve) => { finishExecution = resolve; });
  const runner = runRunner(store, {
    prepare: () => ({ idempotencyKey: "key", branchName: "branch", patch: {} as never }),
    execute: async () => execution
  });
  const work = runner.executeClaimedJob(lease);
  await new Promise<void>((resolve) => setImmediate(resolve));
  store.now = store.jobs.get("rem-a")!.expiresAt + 1;
  finishExecution(success);
  await work;
  assert.equal(store.jobs.get("rem-a")!.status, "running");
});

test("GitHub connector cancellation aborts an in-flight request", async () => {
  const github = new GitHubConnector({
    token: "test-token",
    apiBaseUrl: "https://api.github.test",
    fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })
  });
  const controller = new AbortController();
  const request = github.getBranchSha("owner", "repo", "main", controller.signal);
  controller.abort();
  await assert.rejects(request, /request failed/i);
});

test("mapArtifactExecutionOutcome maps orchestrator outcomes to GitHubExecutionOutcome with retry metadata", () => {
  // Rate-limited failure preserves retryAfterMs and sets retryable: true
  const rateLimitedOutcome = mapArtifactExecutionOutcome({
    kind: "failed",
    stage: "write",
    code: "rate_limited",
    remediationId: "rem-1",
    retryAfterMs: 45_000
  });
  assert.deepEqual(rateLimitedOutcome, {
    kind: "failed",
    errorCode: "rate_limited",
    retryable: true,
    message: "GitHub rate limited the repository request.",
    retryAfterMs: 45_000
  });

  // Terminal write failure (e.g. ordinary 403 / github_read_failed) is non-retryable and has no retryAfterMs
  const terminalWriteOutcome = mapArtifactExecutionOutcome({
    kind: "failed",
    stage: "write",
    code: "github_read_failed",
    remediationId: "rem-1"
  });
  assert.deepEqual(terminalWriteOutcome, {
    kind: "failed",
    errorCode: "github_read_failed",
    retryable: false,
    message: "github_read_failed"
  });
  assert.equal((terminalWriteOutcome as any).retryAfterMs, undefined);

  // Terminal authorization failure (e.g. claim_not_authorized) is non-retryable
  const terminalAuthOutcome = mapArtifactExecutionOutcome({
    kind: "failed",
    stage: "capability",
    code: "claim_not_authorized",
    remediationId: "rem-1"
  });
  assert.deepEqual(terminalAuthOutcome, {
    kind: "failed",
    errorCode: "claim_not_authorized",
    retryable: false,
    message: "claim_not_authorized"
  });

  // Draft pull request outcome
  const prOutcome = mapArtifactExecutionOutcome({
    kind: "draft_pull_request",
    remediationId: "rem-1",
    proposalId: "prop-1",
    artifactHash: "hash-1",
    commitSha: "sha-1",
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/example/service/pull/42",
    branchName: "cloudpilot/remediation/abc",
    reconciled: false
  });
  assert.deepEqual(prOutcome, {
    kind: "pull-request",
    disposition: "created",
    branchName: "cloudpilot/remediation/abc",
    prNumber: 42,
    prUrl: "https://github.com/example/service/pull/42",
    summary: "CloudPilot: apply approved observability remediation"
  });

  // Reconciled draft pull request
  const reconciledOutcome = mapArtifactExecutionOutcome({
    kind: "draft_pull_request",
    remediationId: "rem-1",
    proposalId: "prop-1",
    artifactHash: "hash-1",
    commitSha: "sha-1",
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/example/service/pull/42",
    branchName: "cloudpilot/remediation/abc",
    reconciled: true
  });
  assert.equal(reconciledOutcome.kind, "pull-request");
  if (reconciledOutcome.kind === "pull-request") {
    assert.equal(reconciledOutcome.disposition, "reconciled");
  }

  // Manual review outcome
  const manualReviewOutcome = mapArtifactExecutionOutcome({
    kind: "manual_review",
    stage: "write",
    code: "post_write_verification_failed",
    remediationId: "rem-1",
    proposalId: "prop-1",
    artifactHash: "hash-1"
  });
  assert.deepEqual(manualReviewOutcome, {
    kind: "manual-review",
    branchName: "",
    prNumber: 0,
    prUrl: "",
    summary: "post_write_verification_failed",
    message: "post_write_verification_failed"
  });
});

test("legacy runner remains disabled and does not settle rate-limit outcomes", async () => {
  const store = new MemoryStore();
  store.add("rem-rate-limit", 2);
  const lease = (await store.claimNextPending("worker-test"))!;

  const mappedOutcome = mapArtifactExecutionOutcome({
    kind: "failed",
    stage: "write",
    code: "rate_limited",
    remediationId: lease.id,
    retryAfterMs: 45_000
  });

  let executorCalls = 0;
  const runner = new RemediationRunner(store, {
    prepare: () => ({ idempotencyKey: "unused", branchName: "unused", patch: {} as never }),
    async execute() { executorCalls++; return mappedOutcome; }
  }, { workerId: "worker-test", maxConcurrency: 2 });
  await runner.executeClaimedJob(lease);

  const job = store.jobs.get("rem-rate-limit")!;
  assert.equal(executorCalls, 0);
  assert.equal(job.status, "running", "the disabled legacy runner leaves the claim for lease recovery");
  assert.equal(job.retriesLeft, 2);
  assert.equal(job.nextAt, 0);
  assert.equal(job.lastFailure, undefined);
});

test("runner immediately marks job failed without retry when mapped from orchestrator terminal failure", async () => {
  const store = new MemoryStore();
  store.add("rem-terminal", 3);
  const lease = (await store.claimNextPending("worker-test"))!;

  const mappedOutcome = mapArtifactExecutionOutcome({
    kind: "failed",
    stage: "write",
    code: "github_read_failed",
    remediationId: lease.id
  });

  const runner = runRunner(store, fakeExecutor(mappedOutcome));
  await runner.executeClaimedJob(lease);

  const job = store.jobs.get("rem-terminal")!;
  assert.equal(job.status, "failed");
  assert.equal(job.retriesLeft, 0);
  assert.equal(job.lastFailure?.errorCode, "github_read_failed");
  assert.equal(job.lastFailure?.retryable, false);
  assert.equal(job.lastFailure?.retryAfterMs, undefined);
});

test("GitHub connector timeout remains active while reading the response body", async () => {
  const github = new GitHubConnector({
    token: "test-token",
    apiBaseUrl: "https://api.github.test",
    timeoutMs: 15,
    fetchImpl: async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
        }
      });
      return new Response(body, { status: 200 });
    }
  });
  await assert.rejects(github.getBranchSha("owner", "repo", "main"), /request failed/i);
});
