import { REMEDIATION_LEASE_DURATION_MS, type RemediationLease } from "./remediation-repo.js";
import type { ArtifactOnlyExecutionOrchestrator, ArtifactOnlyExecutionOutcome } from "../remediation/artifact-only-execution-orchestrator.js";

/** The adapter claims only persisted leases and has no work-item or legacy settlement methods. */
export interface ArtifactOnlyLeaseHeartbeat {
  claimNextPending?(workerId: string, leaseDurationMs?: number): Promise<RemediationLease | null>;
  renewLease(lease: RemediationLease, leaseDurationMs?: number): Promise<boolean>;
  reclaimExpiredLeases?(): Promise<unknown>;
}

export interface ArtifactOnlyRemediationWorkerOptions {
  readonly heartbeatIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly executionTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly autoStart?: boolean;
  readonly onError?: (stage: "reap" | "claim" | "execute") => void;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 5 * 60_000;
const MAX_HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_LEASE_DURATION_MS = 5 * 60_000;
const MAX_EXECUTION_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MAX_POLL_INTERVAL_MS = 60_000;

/**
 * Lease-only production adapter. Atomic claims start the authoritative execution
 * lifecycle in the repository transaction; the orchestrator owns all settlement.
 * This class never loads planner work items or invokes legacy settlement APIs.
 */
export class ArtifactOnlyRemediationWorker {
  readonly autoStart = false;
  private readonly heartbeatIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly executionTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly onError: ArtifactOnlyRemediationWorkerOptions["onError"];
  private runTask: Promise<void> | null = null;
  private stopController: AbortController | null = null;
  private activeExecution: Promise<unknown> | null = null;

  constructor(
    private readonly leaseStore: ArtifactOnlyLeaseHeartbeat,
    private readonly orchestrator: Pick<ArtifactOnlyExecutionOrchestrator, "execute">,
    options: ArtifactOnlyRemediationWorkerOptions = {}
  ) {
    if (options.autoStart) {
      throw new Error("ArtifactOnlyRemediationWorker autoStart cannot be enabled: background worker activation is disabled.");
    }
    this.heartbeatIntervalMs = boundedDuration(options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      "heartbeatIntervalMs", MAX_HEARTBEAT_INTERVAL_MS);
    this.leaseDurationMs = boundedDuration(options.leaseDurationMs ?? REMEDIATION_LEASE_DURATION_MS,
      "leaseDurationMs", MAX_LEASE_DURATION_MS);
    this.executionTimeoutMs = boundedDuration(options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
      "executionTimeoutMs", MAX_EXECUTION_TIMEOUT_MS);
    this.pollIntervalMs = boundedDuration(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs", MAX_POLL_INTERVAL_MS);
    this.onError = options.onError;
    if (this.heartbeatIntervalMs >= this.leaseDurationMs) {
      throw new Error("heartbeatIntervalMs must be shorter than leaseDurationMs.");
    }
  }

  /** Starts the claim loop only when the host explicitly opts in. */
  start(workerId: string): void {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(workerId)) throw new Error("Worker ID is invalid.");
    if (!this.leaseStore.claimNextPending || !this.leaseStore.reclaimExpiredLeases) {
      throw new Error("Durable claim and expiry lifecycle are required to start the remediation worker.");
    }
    if (this.runTask) return;
    this.stopController = new AbortController();
    this.runTask = this.runLoop(workerId, this.stopController.signal).finally(() => {
      this.runTask = null;
      this.stopController = null;
    });
  }

  /** Stops polling, aborts cooperative execution, then waits for in-flight work to settle. */
  async stop(): Promise<void> {
    this.stopController?.abort(new Error("worker_stopping"));
    const current = this.runTask;
    if (current) await current;
    if (this.activeExecution) await Promise.allSettled([this.activeExecution]);
  }

  private async runLoop(workerId: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let stage: "reap" | "claim" | "execute" = "reap";
      try {
        // Expiry settlement remains inside the authoritative execution lifecycle.
        await this.leaseStore.reclaimExpiredLeases!();
        if (signal.aborted) break;
        stage = "claim";
        const lease = await this.leaseStore.claimNextPending!(workerId, this.leaseDurationMs);
        if (signal.aborted) break; // A claim in flight during shutdown expires through the durable reaper.
        if (!lease) {
          await delay(this.pollIntervalMs, signal);
          continue;
        }
        stage = "execute";
        this.activeExecution = this.executeClaimedLease(lease, signal);
        await this.activeExecution;
        this.activeExecution = null;
      } catch {
        this.activeExecution = null;
        try { this.onError?.(stage); } catch { /* Diagnostics cannot affect lease safety. */ }
        if (!signal.aborted) await delay(this.pollIntervalMs, signal);
      }
    }
  }

  /** Execute exactly one selector from claimNextPending(); there is no retry loop. */
  async executeClaimedLease(lease: RemediationLease, signal?: AbortSignal): Promise<ArtifactOnlyExecutionOutcome> {
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) relayAbort();
    else signal?.addEventListener("abort", relayAbort, { once: true });

    let heartbeatInFlight: Promise<void> | null = null;
    let stopped = false;
    const heartbeat = setInterval(() => {
      if (stopped || controller.signal.aborted || heartbeatInFlight) return;
      heartbeatInFlight = this.leaseStore.renewLease(lease, this.leaseDurationMs)
        .then((renewed) => { if (!renewed) controller.abort(new Error("lease_lost")); })
        .catch(() => { controller.abort(new Error("lease_renewal_unavailable")); })
        .finally(() => { heartbeatInFlight = null; });
    }, this.heartbeatIntervalMs);
    // The timeout is a cooperative cancellation deadline. Remote requests that
    // have already been accepted still require the orchestrator's durable
    // ambiguity handling; abort cannot atomically undo a GitHub operation.
    const timeout = setTimeout(() => controller.abort(new Error("execution_timeout")), this.executionTimeoutMs);

    try {
      // Authorization, artifact validation, capability issuance and all
      // durable state transitions remain inside the trusted orchestrator.
      return await this.orchestrator.execute(lease, controller.signal);
    } finally {
      stopped = true;
      clearInterval(heartbeat);
      clearTimeout(timeout);
      signal?.removeEventListener("abort", relayAbort);
      if (heartbeatInFlight) await Promise.allSettled([heartbeatInFlight]);
    }
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function boundedDuration(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive safe integer no greater than ${maximum} milliseconds.`);
  }
  return value;
}
