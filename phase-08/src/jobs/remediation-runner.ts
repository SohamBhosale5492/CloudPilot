import os from "node:os";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "../../../phase-07/src/github/github-connector.js";
import { parseGitHubRepoUrl } from "../../../phase-07/src/remediation/orchestrator.js";
import { buildIdempotencyKey } from "../../../phase-07/src/remediation/planner.js";
import type {
  GitHubExecutionOutcome,
  GitHubRepositoryTarget,
  PreparedGitHubRemediation
} from "../../../phase-07/src/remediation/github-executor.js";
import type { ArtifactOnlyExecutionOutcome } from "../remediation/artifact-only-execution-orchestrator.js";
import {
  REMEDIATION_LEASE_DURATION_MS,
  RemediationFailure,
  RemediationJobStore,
  RemediationLease,
  RemediationWorkItem
} from "./remediation-repo.js";

const HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_REAPER_INTERVAL_MS = 15_000;
const DEFAULT_MAX_CONCURRENCY = 5;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;

export interface RemediationExecutor {
  prepare(finding: RemediationWorkItem["finding"], idempotencyKey: string): PreparedGitHubRemediation;
  execute(target: GitHubRepositoryTarget, prepared: PreparedGitHubRemediation, signal?: AbortSignal): Promise<GitHubExecutionOutcome>;
}

export interface RemediationRunnerOptions {
  workerId?: string;
  maxConcurrency?: number;
  pollIntervalMs?: number;
  reaperIntervalMs?: number;
  maxRetryAfterMs?: number;
}

export function mapArtifactExecutionOutcome(outcome: ArtifactOnlyExecutionOutcome): GitHubExecutionOutcome {
  if (outcome.kind === "draft_pull_request") {
    return {
      kind: "pull-request",
      disposition: outcome.reconciled ? "reconciled" : "created",
      branchName: outcome.branchName,
      prNumber: outcome.pullRequestNumber,
      prUrl: outcome.pullRequestUrl,
      summary: "CloudPilot: apply approved observability remediation"
    };
  }
  if (outcome.kind === "manual_review") {
    return {
      kind: "manual-review",
      branchName: outcome.branchName ?? "",
      prNumber: outcome.pullRequestNumber ?? 0,
      prUrl: outcome.pullRequestUrl ?? "",
      summary: outcome.code,
      message: outcome.code
    };
  }
  return {
    kind: "failed",
    errorCode: outcome.code,
    retryable: outcome.code === "rate_limited",
    message: outcome.code === "rate_limited" ? "GitHub rate limited the repository request." : outcome.code,
    ...(outcome.retryAfterMs !== undefined ? { retryAfterMs: outcome.retryAfterMs } : {})
  };
}

function retryableOutcome(outcome: Extract<GitHubExecutionOutcome, { kind: "failed" }>): boolean {
  if (!outcome.retryable) return false;
  if (outcome.errorCode === "github_http_network" || outcome.errorCode === "rate_limited" || outcome.errorCode === "github_rate_limited") {
    return true;
  }
  const match = /^github_http_(\d+)$/.exec(outcome.errorCode);
  if (!match) return false;
  return [403, 408, 429, 500, 502, 503, 504].includes(Number(match[1]));
}

function failure(errorCode: string, message: string, retryable: boolean, retryAfterMs?: number): RemediationFailure {
  return {
    errorCode,
    message: redactSecrets(message).slice(0, 512),
    retryable,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
  };
}

export class RemediationRunner {
  readonly workerId: string;
  // Stage A.2.7.2 deliberately leaves this false. A.2.6 authorization is not
  // yet integrated with an artifact-only writer, so the legacy executor must
  // not claim or execute jobs in the application runtime.
  private legacyExecutionEnabled = false;
  private readonly maxConcurrency: number;
  private readonly pollIntervalMs: number;
  private readonly reaperIntervalMs: number;
  private readonly maxRetryAfterMs: number;
  private activeCount = 0;
  private claimReservations = 0;
  private shuttingDown = false;
  private shutdownTask: Promise<void> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private reaperTimer: NodeJS.Timeout | null = null;
  private readonly tasks = new Set<Promise<void>>();
  private readonly databaseOperations = new Set<Promise<unknown>>();
  private readonly controllers = new Set<AbortController>();
  private readonly heartbeatTimers = new Set<NodeJS.Timeout>();
  private readonly store: RemediationJobStore;

  constructor(
    store: RemediationJobStore,
    private readonly executor: RemediationExecutor,
    options: RemediationRunnerOptions = {}
  ) {
    this.store = store;
    this.workerId = options.workerId ?? `${os.hostname()}:${process.pid}:${randomUUID()}`;
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.reaperIntervalMs = options.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;

    if (!Number.isSafeInteger(this.maxConcurrency) || this.maxConcurrency < 1) {
      throw new Error("maxConcurrency must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 10) {
      throw new Error("pollIntervalMs must be at least 10 milliseconds.");
    }
    if (!Number.isSafeInteger(this.reaperIntervalMs) || this.reaperIntervalMs < 100) {
      throw new Error("reaperIntervalMs must be at least 100 milliseconds.");
    }
    if (!Number.isSafeInteger(this.maxRetryAfterMs) || this.maxRetryAfterMs < 0) {
      throw new Error("maxRetryAfterMs must be a non-negative integer.");
    }

  }

  get activeWorkers(): number {
    return this.activeCount;
  }

  async initialize(): Promise<void> {
    if (this.shuttingDown || !this.legacyExecutionEnabled) return;
    await this.trackDatabase(() => this.store.reclaimExpiredLeases());
    this.startLoops();
  }

  start(): void {
    if (!this.legacyExecutionEnabled) return;
    this.startLoops();
  }

  triggerPoll(): void {
    if (this.shuttingDown || !this.legacyExecutionEnabled) return;
    setImmediate(() => void this.pollOnce());
  }

  async pollOnce(): Promise<boolean> {
    if (!this.legacyExecutionEnabled || this.shuttingDown || this.activeCount + this.claimReservations >= this.maxConcurrency) return false;
    this.claimReservations++;
    try {
      const lease = await this.trackDatabase(() => this.store.claimNextPending(this.workerId, REMEDIATION_LEASE_DURATION_MS));
      if (!lease) return false;
      // A claim already in flight when shutdown starts is intentionally left
      // leased; expiry recovery will make it available to another process.
      if (this.shuttingDown) return false;
      this.activeCount++;
      const controller = new AbortController();
      this.controllers.add(controller);
      const task = this.executeClaimedJob(lease, controller.signal).finally(() => {
        this.activeCount--;
        this.tasks.delete(task);
        this.controllers.delete(controller);
        if (!this.shuttingDown) this.triggerPoll();
      });
      this.tasks.add(task);
      return true;
    } finally {
      this.claimReservations--;
    }
  }

  async executeClaimedJob(lease: RemediationLease, signal?: AbortSignal): Promise<void> {
    if (!this.legacyExecutionEnabled) return;
    let leaseLost = false;
    let heartbeatRunning = false;
    const heartbeatOperations = new Set<Promise<void>>();
    const heartbeat = setInterval(() => {
      if (heartbeatRunning || leaseLost || this.shuttingDown || signal?.aborted) return;
      heartbeatRunning = true;
      const operation = this.trackDatabase(() => this.store.renewLease(lease, REMEDIATION_LEASE_DURATION_MS))
        .then((renewed) => { if (!renewed) leaseLost = true; })
        .catch(() => { /* Final writes are fenced by DB time and lease token. */ })
        .finally(() => { heartbeatRunning = false; heartbeatOperations.delete(operation); });
      heartbeatOperations.add(operation);
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimers.add(heartbeat);

    try {
      const work = await this.trackDatabase(() => this.store.loadWorkItem(lease));
      if (!work || leaseLost || this.shuttingDown || signal?.aborted) return;

      const target = work.repositoryUrl ? parseGitHubRepoUrl(work.repositoryUrl) : null;
      if (!target) {
        await this.trackDatabase(() => this.store.failLease(lease, failure(
          "invalid_repository",
          "The project does not declare a valid GitHub repository URL.",
          false
        )));
        return;
      }

      const idempotencyKey = buildIdempotencyKey(
        work.tenantId,
        work.findingId,
        work.finding.ruleId,
        work.finding.ruleVersion
      );

      let prepared: PreparedGitHubRemediation;
      try {
        prepared = this.executor.prepare(work.finding, idempotencyKey);
      } catch {
        await this.trackDatabase(() => this.store.failLease(lease, failure(
          "invalid_remediation",
          "Remediation input is invalid or unsupported.",
          false
        )));
        return;
      }
      if (leaseLost || this.shuttingDown || signal?.aborted) return;

      const outcome = await this.executor.execute(target, prepared, signal);
      if (leaseLost || this.shuttingDown || signal?.aborted) return;

      if (outcome.kind === "failed") {
        const retryAfterMs = typeof outcome.retryAfterMs === "number" && Number.isFinite(outcome.retryAfterMs) && outcome.retryAfterMs > 0
          ? Math.min(Math.floor(outcome.retryAfterMs), this.maxRetryAfterMs)
          : undefined;
        await this.trackDatabase(() => this.store.failLease(lease, failure(
          outcome.errorCode,
          outcome.message,
          retryableOutcome(outcome),
          retryAfterMs
        )));
        return;
      }

      await this.trackDatabase(() => this.store.completeLease(lease, outcome));
    } catch {
      if (!leaseLost && !this.shuttingDown && !signal?.aborted) {
        await this.trackDatabase(() => this.store.failLease(lease, failure(
          "worker_crash",
          "Worker execution failed unexpectedly.",
          true
        ))).catch(() => false);
      }
    } finally {
      clearInterval(heartbeat);
      this.heartbeatTimers.delete(heartbeat);
      await Promise.allSettled([...heartbeatOperations]);
    }
  }

  /**
   * Stops polling/reaping and aborts active GitHub requests. It waits up to
   * timeoutMs for worker tasks; unfinished remote work is left running without
   * heartbeats or further DB writes, so its lease expires for normal recovery.
   * In-flight database calls are drained before this method resolves so the
   * host can safely disconnect Prisma afterward.
   */
  shutdown(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      return Promise.reject(new Error("shutdown timeout must be a non-negative integer."));
    }
    this.shuttingDown = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    this.pollTimer = null;
    this.reaperTimer = null;

    for (const timer of this.heartbeatTimers) clearInterval(timer);
    for (const controller of this.controllers) controller.abort();

    this.shutdownTask = (async () => {
      await this.drainDatabaseOperations();
      const pending = [...this.tasks];
      if (pending.length > 0) {
        let timeout: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            Promise.allSettled(pending),
            new Promise<void>((resolve) => { timeout = setTimeout(resolve, timeoutMs); })
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }
      // Worker tasks check shuttingDown before every later DB write. Drain any
      // calls that began before shutdown, but do not wait for remote requests.
      await this.drainDatabaseOperations();
    })();
    return this.shutdownTask;
  }

  private startLoops(): void {
    if (this.shuttingDown || !this.legacyExecutionEnabled) return;
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        while (this.activeCount + this.claimReservations < this.maxConcurrency) {
          void this.pollOnce();
          if (this.claimReservations > 0) break;
        }
      }, this.pollIntervalMs);
    }
    if (!this.reaperTimer) {
      this.reaperTimer = setInterval(() => {
        if (this.shuttingDown) return;
        void this.trackDatabase(() => this.store.reclaimExpiredLeases()).catch(() => {});
      }, this.reaperIntervalMs);
    }
  }

  private trackDatabase<T>(operation: () => Promise<T>): Promise<T> {
    let task: Promise<T>;
    try {
      task = operation();
    } catch (error) {
      task = Promise.reject(error);
    }
    this.databaseOperations.add(task);
    void task.then(
      () => this.databaseOperations.delete(task),
      () => this.databaseOperations.delete(task)
    );
    return task;
  }

  private async drainDatabaseOperations(): Promise<void> {
    while (this.databaseOperations.size > 0) {
      await Promise.allSettled([...this.databaseOperations]);
    }
  }
}
