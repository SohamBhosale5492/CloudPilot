import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { RemediationLease } from "../../src/jobs/remediation-repo.js";
import { ArtifactOnlyRemediationWorker } from "../../src/jobs/artifact-only-remediation-worker.js";
import type { ArtifactOnlyExecutionOutcome } from "../../src/remediation/artifact-only-execution-orchestrator.js";

const lease: RemediationLease = Object.freeze({
  id: "remediation-1",
  tenantId: "tenant-1",
  projectId: "project-1",
  workerId: "worker-1",
  leaseToken: "persisted-lease-token",
  retriesLeft: 2
});

const published: ArtifactOnlyExecutionOutcome = {
  kind: "draft_pull_request", remediationId: lease.id, proposalId: lease.id,
  artifactHash: "a".repeat(64), commitSha: "b".repeat(40), pullRequestNumber: 42,
  pullRequestUrl: "https://github.com/example/repo/pull/42", branchName: "cloudpilot/remediate/one",
  reconciled: false
};

function outcome(kind: "failed" | "manual_review"): ArtifactOnlyExecutionOutcome {
  return kind === "failed"
    ? { kind, stage: "claim", code: "claim_not_authorized", remediationId: lease.id }
    : { kind, stage: "write", code: "ambiguous_remote_operation", remediationId: lease.id,
      proposalId: lease.id, artifactHash: "a".repeat(64) };
}

test("lease adapter passes only the claimed selector once and returns orchestrator outcome", async () => {
  const calls: unknown[] = [];
  const storeCalls: string[] = [];
  const worker = new ArtifactOnlyRemediationWorker(
    { async renewLease() { storeCalls.push("renew"); return true; } },
    { async execute(input, signal) { calls.push({ input, signal }); return published; } },
    { heartbeatIntervalMs: 100, leaseDurationMs: 1_000, executionTimeoutMs: 1_000 }
  );

  const result = await worker.executeClaimedLease(lease);
  assert.deepEqual(result, published);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { input: lease, signal: (calls[0] as { signal: AbortSignal }).signal });
  assert.deepEqual(storeCalls, []);
});

test("failed and manual-review outcomes are preserved without legacy settlement or retry", async () => {
  for (const expected of [outcome("failed"), outcome("manual_review")]) {
    let invocations = 0;
    const legacySettlementCalls: string[] = [];
    const worker = new ArtifactOnlyRemediationWorker(
      { async renewLease() { return true; } },
      { async execute(received) { invocations++; assert.equal(received, lease); return expected; } },
      { heartbeatIntervalMs: 100, leaseDurationMs: 1_000, executionTimeoutMs: 1_000 }
    );
    assert.deepEqual(await worker.executeClaimedLease(lease), expected);
    assert.equal(invocations, 1, "an unresolved outcome is never retried as fresh work");
    assert.deepEqual(legacySettlementCalls, [], "adapter has no completeLease/failLease settlement path");
  }
});

test("durable retry scheduling is returned once without a worker-side retry or legacy settlement", async () => {
  const scheduled: ArtifactOnlyExecutionOutcome = {
    kind: "retry_scheduled", stage: "write", code: "rate_limited", remediationId: lease.id, retryAfterMs: 60_000
  };
  let invocations = 0;
  const worker = new ArtifactOnlyRemediationWorker(
    { async renewLease() { return true; } },
    { async execute(received) { invocations++; assert.equal(received, lease); return scheduled; } },
    { heartbeatIntervalMs: 100, leaseDurationMs: 1_000, executionTimeoutMs: 1_000 }
  );
  assert.deepEqual(await worker.executeClaimedLease(lease), scheduled);
  assert.equal(invocations, 1);
});

test("lease renewal loss aborts the orchestrator signal and does not synthesize success", async () => {
  let renewals = 0;
  const manual = outcome("manual_review");
  const worker = new ArtifactOnlyRemediationWorker(
    { async renewLease() { renewals++; return false; } },
    { async execute(_received, signal) {
      return await new Promise<ArtifactOnlyExecutionOutcome>((resolve) => {
        if (signal?.aborted) resolve(manual);
        else signal?.addEventListener("abort", () => resolve(manual), { once: true });
      });
    } },
    { heartbeatIntervalMs: 5, leaseDurationMs: 100, executionTimeoutMs: 500 }
  );

  assert.deepEqual(await worker.executeClaimedLease(lease), manual);
  assert.equal(renewals, 1);
});

test("external cancellation is forwarded to orchestration", async () => {
  const cancellation = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const worker = new ArtifactOnlyRemediationWorker(
    { async renewLease() { return true; } },
    { async execute(_received, signal) {
      observedSignal = signal;
      cancellation.abort();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return outcome("failed");
    } },
    { heartbeatIntervalMs: 100, leaseDurationMs: 1_000, executionTimeoutMs: 1_000 }
  );

  const result = await worker.executeClaimedLease(lease, cancellation.signal);
  assert.equal(result.kind, "failed");
  assert.equal(observedSignal?.aborted, true);
});

test("configured execution deadline aborts orchestration", async () => {
  const worker = new ArtifactOnlyRemediationWorker(
    { async renewLease() { return true; } },
    { async execute(_received, signal) {
      return await new Promise<ArtifactOnlyExecutionOutcome>((resolve) => {
        if (signal?.aborted) resolve(outcome("manual_review"));
        else signal?.addEventListener("abort", () => resolve(outcome("manual_review")), { once: true });
      });
    } },
    { heartbeatIntervalMs: 100, leaseDurationMs: 1_000, executionTimeoutMs: 15 }
  );

  assert.equal((await worker.executeClaimedLease(lease)).kind, "manual_review");
});

test("unexpected orchestrator exceptions propagate without legacy queue settlement", async () => {
  const error = new Error("orchestrator boundary failure");
  let calls = 0;
  const worker = new ArtifactOnlyRemediationWorker(
    { async renewLease() { return true; } },
    { async execute(received) { calls++; assert.equal(received, lease); throw error; } },
    { heartbeatIntervalMs: 100, leaseDurationMs: 1_000, executionTimeoutMs: 1_000 }
  );

  await assert.rejects(worker.executeClaimedLease(lease), error);
  assert.equal(calls, 1);
});

test("worker options reject invalid or unbounded timer configurations", () => {
  const orchestrator = { async execute() { return published; } };
  const store = { async renewLease() { return true; } };
  assert.throws(() => new ArtifactOnlyRemediationWorker(store, orchestrator, { heartbeatIntervalMs: 0 }), /heartbeatIntervalMs/);
  assert.throws(() => new ArtifactOnlyRemediationWorker(store, orchestrator, { heartbeatIntervalMs: 100, leaseDurationMs: 100 }),
    /shorter than leaseDurationMs/);
  assert.throws(() => new ArtifactOnlyRemediationWorker(store, orchestrator, { executionTimeoutMs: 15 * 60_000 + 1 }),
    /executionTimeoutMs/);
});

test("adapter source has no legacy execution, mutable repository, or global-token dependency", () => {
  const source = readFileSync("src/jobs/artifact-only-remediation-worker.ts", "utf8");
  for (const forbidden of ["phase-07", "GitHubRemediationExecutor", "repositoryUrl", "GITHUB_TOKEN",
    "loadWorkItem", "completeLease", "failLease", "prepare("]) {
    assert.equal(source.includes(forbidden), false, `adapter must not reference ${forbidden}`);
  }
});
