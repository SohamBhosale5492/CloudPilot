import { REMEDIATION_LEASE_DURATION_MS, type RemediationLease } from "./remediation-repo.js";
import type { ArtifactOnlyExecutionOrchestrator, ArtifactOnlyExecutionOutcome } from "../remediation/artifact-only-execution-orchestrator.js";

/** The adapter deliberately has no queue claim, work-item, or legacy settlement methods. */
export interface ArtifactOnlyLeaseHeartbeat {
  renewLease(lease: RemediationLease, leaseDurationMs?: number): Promise<boolean>;
}

export interface ArtifactOnlyRemediationWorkerOptions {
  readonly heartbeatIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly executionTimeoutMs?: number;
  readonly autoStart?: boolean;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 5 * 60_000;
const MAX_HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_LEASE_DURATION_MS = 5 * 60_000;
const MAX_EXECUTION_TIMEOUT_MS = 15 * 60_000;

/**
 * Lease-only adapter for a later worker composition. The orchestrator remains
 * the sole owner of durable execution transitions and queue projection updates.
 * This class neither claims jobs nor settles them through legacy repository APIs.
 */
export class ArtifactOnlyRemediationWorker {
  readonly autoStart = false;
  private readonly heartbeatIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly executionTimeoutMs: number;

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
    if (this.heartbeatIntervalMs >= this.leaseDurationMs) {
      throw new Error("heartbeatIntervalMs must be shorter than leaseDurationMs.");
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

function boundedDuration(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive safe integer no greater than ${maximum} milliseconds.`);
  }
  return value;
}
