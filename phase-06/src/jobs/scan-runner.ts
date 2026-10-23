import os from "node:os";
import crypto from "node:crypto";
import { PrismaClient, Scan } from "@prisma/client";
import { ScanRepository, ActiveScanConflictError, StaleWorkerError } from "../db/scan-repo.js";
import { FindingRepository, FindingInput } from "../db/finding-repo.js";
import { ProjectRepository } from "../db/project-repo.js";
import { AuditRepository } from "../db/audit-repo.js";
import { sanitizeErrorDetails } from "../api/validation.js";
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

    // Start background heartbeat lease renewal ticker
    const heartbeatKey = `${tenantId}:${scanId}`;
    const heartbeatTimer = setInterval(() => {
      this.scanRepo.renewLease(tenantId, scanId, this.workerId, this.leaseDurationSeconds).catch(() => {});
    }, this.heartbeatIntervalMs);
    this.activeHeartbeats.set(heartbeatKey, heartbeatTimer);

    try {
      await this.auditRepo.record({
        tenantId,
        actorId,
        action: "SCAN_RUNNING",
        resourceType: "scan",
        resourceId: scanId,
        projectId
      });

      // Fetch project
      const project = await this.projectRepo.findById(tenantId, projectId);
      if (!project) {
        throw new Error(`Project ${projectId} not found.`);
      }

      // Resolve expected model (checking scan's modelOverride first, then project's expectedModel)
      const model = ((scan.modelOverride ?? project.expectedModel) as ExpectedObservabilityModel | null);

      if (!model || !Array.isArray(model.requirements) || model.requirements.length === 0) {
        // No requirements: complete scan with 0 findings atomically
        await this.scanRepo.completeScanWithFindings(tenantId, projectId, scanId, this.workerId, []);

        await this.auditRepo.record({
          tenantId,
          actorId,
          action: "SCAN_COMPLETED",
          resourceType: "scan",
          resourceId: scanId,
          projectId,
          metadata: { totalFindings: 0 }
        });
        return;
      }

      // Resolve target configuration
      const targetConfig = (project.targetConfig ?? {}) as Record<string, unknown>;
      const inspectorConfig: InspectorConfiguration = {
        prometheusBaseUrl: typeof targetConfig.prometheusBaseUrl === "string" ? targetConfig.prometheusBaseUrl : undefined,
        healthBaseUrl: typeof targetConfig.healthBaseUrl === "string" ? targetConfig.healthBaseUrl : undefined,
        traceBackendUrl: typeof targetConfig.traceBackendUrl === "string" ? targetConfig.traceBackendUrl : undefined,
        logBackendUrl: typeof targetConfig.logBackendUrl === "string" ? targetConfig.logBackendUrl : undefined,
        alertBackendUrl: typeof targetConfig.alertBackendUrl === "string" ? targetConfig.alertBackendUrl : undefined,
        fetchImpl: fetchImpl ?? this.defaultFetchImpl,
        allowPrivateIps: true
      };

      // Gather evidence for requirements
      const evidences: InspectorEvidence[] = [];
      for (const requirement of model.requirements) {
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
              target: inspectorConfig.healthBaseUrl ?? inspectorConfig.prometheusBaseUrl ?? "unknown",
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

      // Pure deterministic Gap Engine evaluation
      const gapEngineConfig: GapEngineConfig = {
        metricConfigs: targetConfig.metricConfigs as GapEngineConfig["metricConfigs"],
        maxHealthEvidenceAgeMs: 60000,
        evaluatedAt: new Date()
      };

      const findings = evaluateExpectedObservabilityModel(model, evidences, gapEngineConfig);

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
          provenance: f.evidenceProvenance
        }
      }));

      // Atomic completion & findings publication (fails if worker lost its lease)
      await this.scanRepo.completeScanWithFindings(tenantId, projectId, scanId, this.workerId, findingInputs);

      await this.auditRepo.record({
        tenantId,
        actorId,
        action: "SCAN_COMPLETED",
        resourceType: "scan",
        resourceId: scanId,
        projectId,
        metadata: { totalFindings: findings.length }
      });
    } catch (err) {
      if (err instanceof StaleWorkerError) {
        console.warn(`[BoundedScanRunner] Stale worker publication aborted: ${err.message}`);
        return;
      }

      const sanitized = sanitizeErrorDetails(err);
      try {
        await this.scanRepo.failScanWithLease(tenantId, scanId, this.workerId, sanitized);
      } catch {
        // Ignore if lease already lost
      }

      await this.auditRepo.record({
        tenantId,
        actorId,
        action: "SCAN_FAILED",
        resourceType: "scan",
        resourceId: scanId,
        projectId,
        metadata: { error: sanitized }
      });
    } finally {
      // Clear heartbeat ticker
      clearInterval(heartbeatTimer);
      this.activeHeartbeats.delete(heartbeatKey);
    }
  }
}
