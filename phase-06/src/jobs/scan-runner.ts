import { PrismaClient } from "@prisma/client";
import { ScanRepository, ActiveScanConflictError } from "../db/scan-repo.js";
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

export { ActiveScanConflictError };

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
  maxConcurrency?: number;
  maxQueueCapacity?: number;
  fetchImpl?: typeof fetch;
}

export class BoundedScanRunner {
  private readonly maxConcurrency: number;
  private readonly maxQueueCapacity: number;
  private readonly queue: ScanJobTask[] = [];
  private runningCount = 0;
  private isShuttingDown = false;
  /** Track all in-process (pending in queue + running) projectIds per tenant for conflict detection. */
  private readonly inProcessProjects = new Set<string>();
  private readonly scanRepo: ScanRepository;
  private readonly projectRepo: ProjectRepository;
  private readonly findingRepo: FindingRepository;
  private readonly auditRepo: AuditRepository;
  private readonly defaultFetchImpl?: typeof fetch;

  constructor(
    private readonly prisma: PrismaClient,
    options: ScanRunnerOptions = {}
  ) {
    this.maxConcurrency = options.maxConcurrency ?? 5;
    this.maxQueueCapacity = options.maxQueueCapacity ?? 50;
    this.defaultFetchImpl = options.fetchImpl;
    this.scanRepo = new ScanRepository(prisma);
    this.projectRepo = new ProjectRepository(prisma);
    this.findingRepo = new FindingRepository(prisma);
    this.auditRepo = new AuditRepository(prisma);
  }

  async initialize(): Promise<void> {
    const recovered = await this.scanRepo.recoverOrphanedScans();
    if (recovered > 0) {
      console.warn(`[BoundedScanRunner] Recovered and failed ${recovered} orphaned scans from previous run.`);
    }
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get activeWorkers(): number {
    return this.runningCount;
  }

  async shutdown(timeoutMs = 5000): Promise<void> {
    this.isShuttingDown = true;
    const start = Date.now();
    while (this.runningCount > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * Enqueues a scan job if queue has capacity.
   *
   * Conflict detection is two-stage:
   * 1. In-process: rejects if the same (tenantId, projectId) is already queued or running.
   * 2. Database: rejects if a DB-persisted active scan exists that was not created by this call.
   *
   * NOTE: This is an in-process queue. Under multiple API replicas, only the
   * DB partial unique index (idx_scans_active_project) provides true distributed
   * conflict detection. Duplicate scans from different replicas will be caught by
   * the database constraint but may not return 409 from this method.
   * This limitation is documented in README.md and deferred to a durable job queue.
   */
  async enqueue(task: ScanJobTask): Promise<void> {
    if (this.isShuttingDown) {
      throw new Error("Scan runner is shutting down; new jobs are not accepted.");
    }

    if (this.queue.length >= this.maxQueueCapacity) {
      throw new ScanQueueFullError();
    }

    // In-process conflict check covers both queued and running tasks
    const projectKey = `${task.tenantId}:${task.projectId}`;
    if (this.inProcessProjects.has(projectKey)) {
      throw new ActiveScanConflictError(task.projectId);
    }

    // DB-level check: catch scans that were persisted before this task was created
    const activeScan = await this.scanRepo.findActiveScanForProject(task.tenantId, task.projectId);
    if (activeScan && activeScan.id !== task.scanId) {
      throw new ActiveScanConflictError(task.projectId);
    }

    this.inProcessProjects.add(projectKey);
    this.queue.push(task);
    this.processNext();
  }

  private processNext(): void {
    if (this.runningCount >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }

    const nextTask = this.queue.shift();
    if (!nextTask) {
      return;
    }

    this.runningCount++;
    const projectKey = `${nextTask.tenantId}:${nextTask.projectId}`;
    this.executeTask(nextTask).finally(() => {
      this.runningCount--;
      this.inProcessProjects.delete(projectKey);
      this.processNext();
    });
  }

  private async executeTask(task: ScanJobTask): Promise<void> {
    const { tenantId, projectId, scanId, actorId, modelOverride } = task;

    try {
      // 1. Mark scan as running
      await this.scanRepo.updateStatus(tenantId, scanId, {
        status: "running",
        startedAt: new Date()
      });

      await this.auditRepo.record({
        tenantId,
        actorId,
        action: "SCAN_RUNNING",
        resourceType: "scan",
        resourceId: scanId,
        projectId
      });

      // 2. Fetch project
      const project = await this.projectRepo.findById(tenantId, projectId);
      if (!project) {
        throw new Error(`Project ${projectId} not found.`);
      }

      // 3. Resolve expected model
      const model = (modelOverride ?? project.expectedModel) as ExpectedObservabilityModel | null;

      if (!model || !Array.isArray(model.requirements) || model.requirements.length === 0) {
        // No requirements to evaluate
        await this.scanRepo.updateStatus(tenantId, scanId, {
          status: "completed",
          completedAt: new Date()
        });

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

      // 4. Resolve target configuration
      const targetConfig = (project.targetConfig ?? {}) as Record<string, unknown>;
      const inspectorConfig: InspectorConfiguration = {
        prometheusBaseUrl: typeof targetConfig.prometheusBaseUrl === "string" ? targetConfig.prometheusBaseUrl : undefined,
        healthBaseUrl: typeof targetConfig.healthBaseUrl === "string" ? targetConfig.healthBaseUrl : undefined,
        traceBackendUrl: typeof targetConfig.traceBackendUrl === "string" ? targetConfig.traceBackendUrl : undefined,
        logBackendUrl: typeof targetConfig.logBackendUrl === "string" ? targetConfig.logBackendUrl : undefined,
        alertBackendUrl: typeof targetConfig.alertBackendUrl === "string" ? targetConfig.alertBackendUrl : undefined,
        fetchImpl: task.fetchImpl ?? this.defaultFetchImpl,
        allowPrivateIps: true
      };

      // 5. Gather evidence for requirements
      const evidences: InspectorEvidence[] = [];
      for (const requirement of model.requirements) {
        try {
          const ev = await inspectExpectedObservabilityRequirement(requirement, inspectorConfig);
          evidences.push(ev);
        } catch (inspectErr) {
          // Wrap error as diagnostic on evidence rather than crashing entire scan
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

      // 6. Evaluate model via Gap Engine
      const gapEngineConfig: GapEngineConfig = {
        metricConfigs: targetConfig.metricConfigs as GapEngineConfig["metricConfigs"],
        maxHealthEvidenceAgeMs: 60000,
        evaluatedAt: new Date()
      };

      const findings = evaluateExpectedObservabilityModel(model, evidences, gapEngineConfig);

      // 7. Persist findings
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

      await this.findingRepo.createMany(tenantId, projectId, scanId, findingInputs);

      // 8. Mark scan completed
      await this.scanRepo.updateStatus(tenantId, scanId, {
        status: "completed",
        completedAt: new Date()
      });

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
      const sanitized = sanitizeErrorDetails(err);
      await this.scanRepo.updateStatus(tenantId, scanId, {
        status: "failed",
        error: sanitized,
        completedAt: new Date()
      });

      await this.auditRepo.record({
        tenantId,
        actorId,
        action: "SCAN_FAILED",
        resourceType: "scan",
        resourceId: scanId,
        projectId,
        metadata: { error: sanitized }
      });
    }
  }
}
