import os from "node:os";
import crypto from "node:crypto";
import { PrismaClient, Scan } from "@prisma/client";
import { ScanRepository, ActiveScanConflictError, StaleWorkerError, type ScanLease } from "../db/scan-repo.js";
import { FindingRepository, FindingInput } from "../db/finding-repo.js";
import { ProjectRepository } from "../db/project-repo.js";
import { AuditRepository } from "../db/audit-repo.js";
import { sanitizeErrorDetails } from "../api/validation.js";
import { validateAndSanitizeUrl } from "../../../phase-01/demo-service/src/inspectors.js";
import {
  evaluateExpectedObservabilityModel,
  GapEngineConfig,
  GapFinding
} from "../../../phase-01/demo-service/src/gap-engine.js";
import {
  inspectExpectedObservabilityRequirement,
  InspectorConfiguration,
  InspectorEvidence
} from "../../../phase-01/demo-service/src/inspectors.js";
import type { ExpectedObservabilityModel } from "../../../phase-01/demo-service/src/expected-observability.js";
import { expectedModelDigest } from "../../../phase-01/demo-service/src/source-observability-analysis.js";

export { ActiveScanConflictError, StaleWorkerError };

export interface ScanJobTask {
  tenantId: string;
  projectId: string;
  scanId: string;
  actorId: string;
  modelOverride?: ExpectedObservabilityModel;
  fetchImpl?: typeof fetch;
}

export class ScanQueueFullError extends Error {
  readonly statusCode = 429;
  constructor(message = "Scan job queue is at maximum capacity.") {
    super(message);
    this.name = "ScanQueueFullError";
  }
}

export interface ScanRunnerOptions {
  workerId?: string;
  maxConcurrency?: number;
  maxQueueCapacity?: number;
  pollIntervalMs?: number;
  jitterMs?: number;
  leaseDurationSeconds?: number;
  heartbeatIntervalMs?: number;
  reaperIntervalMs?: number;
  fetchImpl?: typeof fetch;
  autoStart?: boolean;
}

export class BoundedScanRunner {
  readonly workerId: string;
  private readonly maxConcurrency: number;
  private readonly maxQueueCapacity: number;
  private readonly pollIntervalMs: number;
  private readonly jitterMs: number;
  private readonly leaseDurationSeconds: number;
  private readonly heartbeatIntervalMs: number;
  private readonly reaperIntervalMs: number;
  private readonly defaultFetchImpl?: typeof fetch;

  private runningCount = 0;
  private isShuttingDown = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private reaperTimer: NodeJS.Timeout | null = null;
  private activeHeartbeats: Map<string, NodeJS.Timeout> = new Map();

  private readonly scanRepo: ScanRepository;
  private readonly projectRepo: ProjectRepository;
  private readonly findingRepo: FindingRepository;
  private readonly auditRepo: AuditRepository;

  constructor(
    private readonly prisma: PrismaClient,
    options: ScanRunnerOptions = {}
  ) {
    this.workerId = options.workerId ?? `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
    this.maxConcurrency = options.maxConcurrency ?? 5;
    this.maxQueueCapacity = options.maxQueueCapacity ?? 50;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.jitterMs = options.jitterMs ?? 200;
    this.leaseDurationSeconds = options.leaseDurationSeconds ?? 60;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15000;
    this.reaperIntervalMs = options.reaperIntervalMs ?? 15000;
    this.defaultFetchImpl = options.fetchImpl;

    this.scanRepo = new ScanRepository(prisma);
    this.projectRepo = new ProjectRepository(prisma);
    this.findingRepo = new FindingRepository(prisma);
    this.auditRepo = new AuditRepository(prisma);

    if (options.autoStart) {
      this.startLoops();
    }
  }

  async initialize(): Promise<void> {
    // Safely reclaim only truly expired leases (never blanket fail living peers' active scans)
    try {
      const result = await this.scanRepo.reclaimExpiredLeases();
      if (result.requeued > 0 || result.permanentlyFailed > 0) {
        console.warn(`[BoundedScanRunner] Reclaimed expired leases on startup: ${result.requeued} requeued, ${result.permanentlyFailed} permanently failed.`);
      }
    } catch {
      // Non-fatal if DB is initializing
    }

    this.startLoops();
  }

  get queueLength(): number {
    return 0; // Authoritative queue is PostgreSQL
  }

  get activeWorkers(): number {
    return this.runningCount;
  }

  /**
   * Starts the polling and reaper background loops.
   */
  private startLoops(): void {
    if (this.isShuttingDown) return;

    if (!this.pollTimer) {
      this.scheduleNextPoll();
    }

    if (!this.reaperTimer) {
      this.reaperTimer = setInterval(() => {
        this.runReaper().catch(() => {});
      }, this.reaperIntervalMs);
    }
  }

  private scheduleNextPoll(): void {
    if (this.isShuttingDown) return;
    const jitter = Math.floor(Math.random() * this.jitterMs);
    this.pollTimer = setTimeout(() => {
      this.pollAndExecute().finally(() => {
        if (!this.isShuttingDown) {
          this.scheduleNextPoll();
        }
      });
    }, this.pollIntervalMs + jitter);
  }

  /**
   * Triggers an immediate poll cycle (e.g. after a new scan is enqueued).
   */
  triggerPoll(): void {
    if (this.isShuttingDown) return;
    setImmediate(() => {
      this.pollAndExecute().catch(() => {});
    });
  }

  private async runReaper(): Promise<void> {
    if (this.isShuttingDown) return;
    try {
      await this.scanRepo.reclaimExpiredLeases();
    } catch {
      // Ignore background reaper errors
    }
  }

  async shutdown(timeoutMs = 5000): Promise<void> {
    this.isShuttingDown = true;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }

    // Stop all active heartbeat timers
    for (const timer of this.activeHeartbeats.values()) {
      clearInterval(timer);
    }
    this.activeHeartbeats.clear();

    const start = Date.now();
    while (this.runningCount > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * Enqueues a scan job if queue has capacity in PostgreSQL.
   */
  async enqueue(task: ScanJobTask): Promise<void> {
    if (this.isShuttingDown) {
      throw new Error("Scan runner is shutting down; new jobs are not accepted.");
    }

    // Check PostgreSQL-backed pending queue capacity
    const pendingCount = await this.prisma.scan.count({
      where: { status: "pending" }
    });

    if (pendingCount >= this.maxQueueCapacity) {
      throw new ScanQueueFullError();
    }

    // Check DB-level active scan conflict for the project
    const activeScan = await this.scanRepo.findActiveScanForProject(task.tenantId, task.projectId);
    if (activeScan && activeScan.id !== task.scanId) {
      throw new ActiveScanConflictError(task.projectId);
    }

    // Immediately trigger a poll cycle to claim the scan
    this.triggerPoll();
  }

  /**
   * Polls PostgreSQL for the next pending scan and executes it if concurrency allows.
   */
  private async pollAndExecute(): Promise<void> {
    if (this.isShuttingDown || this.runningCount >= this.maxConcurrency) {
      return;
    }

    let claimedScan: Scan | null = null;
    try {
      claimedScan = await this.scanRepo.claimNextPendingScan(this.workerId, this.leaseDurationSeconds);
    } catch {
      return;
    }

    if (!claimedScan) {
      return;
    }

    this.runningCount++;
    this.executeClaimedScan(claimedScan)
      .finally(() => {
        this.runningCount--;
        // If there's capacity, poll immediately for more pending jobs
        if (!this.isShuttingDown && this.runningCount < this.maxConcurrency) {
          this.triggerPoll();
        }
      });
  }

  /**
   * Executes a scan claimed from PostgreSQL.
   */
  async executeClaimedScan(scan: Scan, fetchImpl?: typeof fetch): Promise<void> {
    const { tenantId, projectId, id: scanId, triggeredById } = scan;
    const actorId = triggeredById ?? "system";
    const leaseToken = scan.leaseToken;
    const lease: ScanLease = {
      tenantId,
      projectId,
      scanId,
      workerId: scan.workerId ?? this.workerId,
      leaseToken: typeof leaseToken === "string" ? leaseToken : ""
    };
    if (!lease.leaseToken) {
      console.warn(`[BoundedScanRunner] Scan ${scanId} has no claim token; refusing execution.`);
      return;
    }

    // A heartbeat error is treated as ownership loss (fail closed). DB writes
    // remain independently fenced, so abort support is only a resource saving.
    const heartbeatKey = `${tenantId}:${scanId}`;
    const abortController = new AbortController();
    let ownershipLost = false;
    let heartbeatInFlight: Promise<void> | null = null;
    const loseOwnership = (): void => {
      ownershipLost = true;
      abortController.abort();
    };
    const assertOwnership = (): void => {
      if (ownershipLost) throw new StaleWorkerError(scanId, lease.workerId);
    };
    const heartbeatTimer = setInterval(() => {
      if (ownershipLost || heartbeatInFlight) return;
      heartbeatInFlight = this.scanRepo.renewLease(lease, this.leaseDurationSeconds)
        .then((renewed) => { if (!renewed) loseOwnership(); })
        .catch(loseOwnership)
        .finally(() => { heartbeatInFlight = null; });
    }, this.heartbeatIntervalMs);
    this.activeHeartbeats.set(heartbeatKey, heartbeatTimer);
    const stopHeartbeats = async (): Promise<void> => {
      clearInterval(heartbeatTimer);
      if (heartbeatInFlight) await heartbeatInFlight;
    };

    try {
      if (!await this.scanRepo.recordRunningAudit(lease, actorId)) {
        loseOwnership();
        throw new StaleWorkerError(scanId, lease.workerId);
      }

      // Fetch project
      const project = await this.projectRepo.findById(tenantId, projectId);
      assertOwnership();
      if (!project) {
        throw new Error(`Project ${projectId} not found.`);
      }

      // Resolve expected model (checking scan's modelOverride first, then project's expectedModel)
      const model = ((scan.modelOverride ?? project.expectedModel) as ExpectedObservabilityModel | null);

      if (!model || !Array.isArray(model.requirements) || model.requirements.length === 0) {
        throw new Error("Scan cannot evaluate this project because its expected observability model has no requirements.");
      }

      // Resolve target configuration
      const targetConfig = (project.targetConfig ?? {}) as Record<string, unknown>;
      const sourceAnalysis = isRecord(targetConfig.sourceAnalysis) ? targetConfig.sourceAnalysis : undefined;
      const sourceEvidenceActive = sourceAnalysis?.modelDigest === expectedModelDigest(model);
      const sourceEvidenceByRequirement = sourceEvidenceActive && isRecord(sourceAnalysis?.evidenceByRequirement)
        ? sourceAnalysis.evidenceByRequirement : {};
      const effectiveMetricConfigs = {
        ...(sourceEvidenceActive && isRecord(sourceAnalysis?.metricConfigs) ? sourceAnalysis.metricConfigs : {}),
        ...(isRecord(targetConfig.metricConfigs) ? targetConfig.metricConfigs : {})
      };
      const telemetryFetch = fetchImpl ?? this.defaultFetchImpl ?? fetch;
      const inspectorConfig: InspectorConfiguration = {
        prometheusBaseUrl: typeof targetConfig.prometheusBaseUrl === "string" ? targetConfig.prometheusBaseUrl : undefined,
        healthBaseUrl: typeof targetConfig.healthBaseUrl === "string" ? targetConfig.healthBaseUrl : undefined,
        traceBackendUrl: typeof targetConfig.traceBackendUrl === "string" ? targetConfig.traceBackendUrl : undefined,
        metricConfigs: effectiveMetricConfigs as InspectorConfiguration["metricConfigs"],
        fetchImpl: (input, init) => telemetryFetch(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, abortController.signal]) : abortController.signal
        }),
        allowPrivateIps: true
      };

      // Gather evidence for requirements
      const evidences: InspectorEvidence[] = [];
      for (const requirement of model.requirements) {
        assertOwnership();
        try {
          const ev = await inspectExpectedObservabilityRequirement(requirement, inspectorConfig);
          evidences.push(ev);
        } catch (inspectErr) {
          evidences.push({
            signal: requirement.signal,
            requirementId: requirement.id,
            collectedAt: new Date().toISOString(),
            available: false,
            complete: false,
            provenance: {
              target: safeTargetUrl(inspectorConfig.healthBaseUrl ?? inspectorConfig.prometheusBaseUrl),
              adapter: "error-capture"
            },
            diagnostics: [
              {
                code: "STATUS_ERROR",
                severity: "error",
                message: sanitizeErrorDetails(inspectErr)
              }
            ]
          });
        }
      }
      assertOwnership();

      // Pure deterministic Gap Engine evaluation
      const gapEngineConfig: GapEngineConfig = {
        metricConfigs: effectiveMetricConfigs as GapEngineConfig["metricConfigs"],
        maxHealthEvidenceAgeMs: 60000,
        evaluatedAt: new Date()
      };

      const findings = evaluateExpectedObservabilityModel(model, evidences, gapEngineConfig);
      const evidenceByRequirement = new Map(evidences.map((evidence) => [evidence.requirementId, evidence]));

      const findingInputs: FindingInput[] = findings.map((f: GapFinding) => ({
        requirementId: f.requirementId,
        ruleId: f.rule.id,
        ruleVersion: f.rule.version,
        signal: f.signal,
        outcome: f.outcome,
        expected: f.expected,
        observed: f.observed,
        reason: f.reason,
        evidenceJson: {
          provenance: f.evidenceProvenance,
          evidence: evidenceByRequirement.get(f.requirementId) ?? null,
          sourceEvidence: sourceEvidenceByRequirement[f.requirementId] ?? null,
          sourceModelDigest: sourceEvidenceActive ? sourceAnalysis?.modelDigest : null
        }
      }));

      if (sourceEvidenceActive && Array.isArray(sourceAnalysis?.findings)) {
        for (const candidate of sourceAnalysis.findings) {
          if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.ruleId !== "string" ||
              typeof candidate.title !== "string" || typeof candidate.expected !== "string" || typeof candidate.observed !== "string" ||
              typeof candidate.risk !== "string" || !["low", "medium", "high"].includes(String(candidate.severity)) ||
              !["gap", "incomplete"].includes(String(candidate.status)) || !Array.isArray(candidate.evidence)) continue;
          const sourceEvidence = candidate.evidence.filter((item): item is Record<string, unknown> => isRecord(item) &&
            typeof item.path === "string" && typeof item.line === "number" && Number.isInteger(item.line) && typeof item.claim === "string");
          findingInputs.push({
            requirementId: `source:${candidate.id}`,
            ruleId: candidate.ruleId,
            ruleVersion: "1.0.0",
            signal: candidate.ruleId.includes("HEALTH") ? "health" : candidate.ruleId.includes("TRACING") ? "trace" : "metric",
            outcome: candidate.status === "gap" ? "gap" : "unknown",
            expected: candidate.expected,
            observed: candidate.observed,
            reason: `Source-level assessment only; this result does not assert a runtime failure. ${candidate.risk}`,
            evidenceJson: {
              provenance: { target: "uploaded-source-snapshot", adapter: "deterministic-node-express-source-rules" },
              sourceAssessment: { kind: "source_configuration", severity: candidate.severity, status: candidate.status, risk: candidate.risk },
              sourceEvidence,
              sourceDigest: sourceAnalysis.sourceDigest
            }
          });
        }
      }

      // Atomic completion & findings publication (fails if worker lost its lease)
      await stopHeartbeats();
      assertOwnership();
      await this.scanRepo.completeScanWithFindings(lease, findingInputs, actorId);
    } catch (err) {
      await stopHeartbeats();
      if (err instanceof StaleWorkerError || ownershipLost) {
        console.warn(`[BoundedScanRunner] Stale worker publication aborted for scan ${scanId}.`);
        return;
      }

      const sanitized = sanitizeErrorDetails(err);
      try {
        // Failure state and its terminal audit are committed together, and
        // only when this exact token still owns an unexpired lease.
        await this.scanRepo.failScanWithLease(lease, sanitized, actorId);
      } catch {
        // Ignore if lease already lost
      }
    } finally {
      // Clear heartbeat ticker
      clearInterval(heartbeatTimer);
      this.activeHeartbeats.delete(heartbeatKey);
    }
  }
}

function safeTargetUrl(value: string | undefined): string {
  if (!value) return "unknown";
  const validated = validateAndSanitizeUrl(value, { allowPrivateIps: true });
  return validated.sanitizedUrl ?? "<invalid-target>";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
