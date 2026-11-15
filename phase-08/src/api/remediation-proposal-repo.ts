import { createHash, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { buildIdempotencyKey, isRemediationSupported, planRemediation, type FindingSummary } from "../../../phase-07/src/remediation/planner.js";
import { hasOrganizationPermission, type OrganizationPermission } from "../organizations/permissions.js";
import { executionArtifactMetadata, type RemediationExecutionArtifact, verifyExecutionArtifact } from "../remediation/execution-artifact.js";
import { renderExecutionArtifact, type TrustedRepositorySnapshot } from "../remediation/execution-artifact.js";
import type { TrustedRepositorySnapshotReader } from "../remediation/execution-artifact-preparation.js";

export class RemediationProposalError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); this.name = "RemediationProposalError"; }
}

export interface CreateRemediationProposalInput {
  tenantId: string; projectId: string; findingId: string; requesterIdentityUserId: string; actorSubject: string;
}
export interface RemediationProposalDecisionInput {
  tenantId: string; remediationId: string; identityUserId: string; decision: "approve" | "reject";
}
export interface RemediationProposalListInput {
  tenantId: string;
  projectId: string;
  identityUserId: string;
  limit: number;
  cursor?: string;
}
export interface RemediationProposalPage {
  items: Record<string, unknown>[];
  nextCursor?: string;
  hasMore: boolean;
}
export interface RemediationProposalStore {
  listByProject(input: RemediationProposalListInput): Promise<RemediationProposalPage>;
  create(input: CreateRemediationProposalInput): Promise<{ proposal: Record<string, unknown>; replayed: boolean }>;
  read(input: { tenantId: string; remediationId: string; identityUserId: string }): Promise<Record<string, unknown>>;
  decide(input: RemediationProposalDecisionInput): Promise<
    | { kind: "decided"; approvalState: "approved" | "rejected"; status: string }
    | { kind: "conflict"; approvalState: "invalidated" | string; message: string }
  >;
}

interface ProposalFinding extends FindingSummary {
  id: string;
  scanId: string;
  organizationId?: string | null;
  attemptNumber?: number;
  evidenceJson?: Prisma.JsonValue;
  createdAt?: Date;
}

function deterministicAdoptionUuid(scope: string): string {
  const hex = createHash("sha256").update(scope, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
interface ProposalBinding {
  id: string; githubRepositoryId: bigint; installationRecordId: string; ownerLogin: string; repositoryName: string;
  installation: { status: string };
}
export interface RemediationProposalArtifactContext {
  identityUserId: string;
  proposalId: string;
  tenantId: string;
  organizationId: string;
  projectId: string;
  repositoryBindingId: string;
  installationRecordId: string;
  githubRepositoryId: string;
  planHash: string;
  filePath: string;
}
interface ProposalRow {
  id: string; tenant_id: string; organization_id: string; project_id: string; scan_id: string; finding_id: string;
  requested_by_identity_user_id: string; repository_binding_id: string; github_repository_id: bigint;
  plan_hash: string; plan_snapshot: Prisma.JsonValue; approval_state: string; status: string;
  execution_artifact: Prisma.JsonValue | null; execution_artifact_hash: string | null; approved_artifact_hash: string | null;
  approved_by_identity_user_id: string | null; approved_at: Date | null;
  rejected_by_identity_user_id: string | null; rejected_at: Date | null;
  invalidated_at: Date | null; created_at: Date;
}

const RETURNING_PROPOSAL = `id, tenant_id, organization_id, project_id, scan_id, finding_id,
  requested_by_identity_user_id, repository_binding_id, github_repository_id, plan_hash, plan_snapshot,
  approval_state, status, execution_artifact, execution_artifact_hash, approved_artifact_hash,
  approved_by_identity_user_id, approved_at, rejected_by_identity_user_id,
  rejected_at, invalidated_at, created_at`;

function isWriteConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2002" || error.code === "P2034") return true;
  if (error.code !== "P2010" || !error.meta || typeof error.meta !== "object") return false;
  const databaseCode = (error.meta as { code?: unknown }).code;
  return databaseCode === "23505" || databaseCode === "40001";
}

function makePlanSnapshot(projectId: string, finding: ProposalFinding, binding: ProposalBinding): Record<string, unknown> {
  const patch = planRemediation(finding);
  return {
    schemaVersion: 1,
    plannerVersion: "phase07-planner-v1",
    projectId,
    finding: {
      id: finding.id, scanId: finding.scanId, requirementId: finding.requirementId, ruleId: finding.ruleId,
      ruleVersion: finding.ruleVersion, signal: finding.signal, outcome: finding.outcome,
      expected: finding.expected, observed: finding.observed, reason: finding.reason
    },
    repository: {
      bindingId: binding.id, repositoryId: binding.githubRepositoryId.toString(),
      installationRecordId: binding.installationRecordId, owner: binding.ownerLogin, name: binding.repositoryName
    },
    patch: { filePath: patch.filePath, title: patch.prTitle, body: patch.prBody, commitMessage: patch.commitMessage, summary: patch.summary }
  };
}

const SNAPSHOT_INTEGRITY_ERROR = "Proposal integrity validation failed.";

function recordWithExactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record);
  if (actualKeys.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) return null;
  return record;
}

function serializePlanSnapshot(snapshot: unknown): string | null {
  try {
    const root = recordWithExactKeys(snapshot, ["schemaVersion", "plannerVersion", "projectId", "finding", "repository", "patch"]);
    if (!root || root.schemaVersion !== 1 || root.plannerVersion !== "phase07-planner-v1" || typeof root.projectId !== "string") return null;
    const finding = recordWithExactKeys(root.finding, ["id", "scanId", "requirementId", "ruleId", "ruleVersion", "signal", "outcome", "expected", "observed", "reason"]);
    const repository = recordWithExactKeys(root.repository, ["bindingId", "repositoryId", "installationRecordId", "owner", "name"]);
    const patch = recordWithExactKeys(root.patch, ["filePath", "title", "body", "commitMessage", "summary"]);
    if (!finding || !repository || !patch) return null;
    if (Object.values(finding).some((value) => typeof value !== "string") ||
        Object.values(repository).some((value) => typeof value !== "string") ||
        Object.values(patch).some((value) => typeof value !== "string") ||
        typeof repository.repositoryId !== "string" || !/^[1-9]\d*$/.test(repository.repositoryId)) return null;

    // Retain v1's creation key order explicitly. JSONB may reorder object keys
    // on storage, so this reconstructs the same bytes independently of read order.
    const canonical = {
      schemaVersion: 1,
      plannerVersion: "phase07-planner-v1",
      projectId: root.projectId,
      finding: {
        id: finding.id, scanId: finding.scanId, requirementId: finding.requirementId, ruleId: finding.ruleId,
        ruleVersion: finding.ruleVersion, signal: finding.signal, outcome: finding.outcome,
        expected: finding.expected, observed: finding.observed, reason: finding.reason
      },
      repository: {
        bindingId: repository.bindingId, repositoryId: repository.repositoryId,
        installationRecordId: repository.installationRecordId, owner: repository.owner, name: repository.name
      },
      patch: {
        filePath: patch.filePath, title: patch.title, body: patch.body,
        commitMessage: patch.commitMessage, summary: patch.summary
      }
    };
    const serialized = JSON.stringify(canonical);
    return Buffer.byteLength(serialized, "utf8") <= 65536 ? serialized : null;
  } catch {
    return null;
  }
}

function hashPlan(snapshot: Record<string, unknown>): string {
  const serialized = serializePlanSnapshot(snapshot);
  if (!serialized) throw new Error(SNAPSHOT_INTEGRITY_ERROR);
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

/** Verifies a persisted v1 snapshot using the same fixed-order serialization as creation. */
export function verifyPlanSnapshotIntegrity(snapshot: unknown, storedHash: unknown): boolean {
  if (typeof storedHash !== "string" || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const serialized = serializePlanSnapshot(snapshot);
  if (!serialized) return false;
  const actualHash = createHash("sha256").update(serialized, "utf8").digest("hex");
  return actualHash === storedHash;
}

function assertPlanSnapshotIntegrity(row: ProposalRow): void {
  if (!verifyPlanSnapshotIntegrity(row.plan_snapshot, row.plan_hash)) {
    throw new RemediationProposalError(409, SNAPSHOT_INTEGRITY_ERROR);
  }
}

function artifactScope(row: ProposalRow) {
  const snapshot = row.plan_snapshot as Record<string, any>;
  return {
    proposalId: row.id, tenantId: row.tenant_id, organizationId: row.organization_id,
    projectId: row.project_id, repositoryBindingId: row.repository_binding_id,
    githubRepositoryId: row.github_repository_id.toString(),
    installationRecordId: snapshot.repository.installationRecordId, planHash: row.plan_hash
  };
}

function assertArtifactIntegrity(row: ProposalRow): RemediationExecutionArtifact | null {
  if (row.execution_artifact === null && row.execution_artifact_hash === null && row.approved_artifact_hash === null) return null;
  if (!row.execution_artifact || !row.execution_artifact_hash ||
      !verifyExecutionArtifact(row.execution_artifact, row.execution_artifact_hash, artifactScope(row)) ||
      (row.approval_state === "approved"
        ? row.approved_artifact_hash !== row.execution_artifact_hash
        : row.approved_artifact_hash !== null))
    throw new RemediationProposalError(409, "Proposal integrity validation failed.");
  return row.execution_artifact as unknown as RemediationExecutionArtifact;
}

function derivePrDeliveryStatus(status: string, executionStatus?: string | null): string {
  if (status === "merged") return "pr_merged";
  if (status === "closed") return "pr_closed";
  if (status === "open" || executionStatus === "completed") return "draft_pr_created";
  if (status === "failed" || executionStatus === "failed" || executionStatus === "manual_review") return "failed";
  if (status === "executing" || status === "queued" || executionStatus === "running" || executionStatus === "leased" || executionStatus === "queued") return "in_progress";
  return "not_started";
}

function deriveFindingResolution(latest: { scanId: string; outcome: string; completedAt: Date | null } | null): {
  status: "resolved" | "unresolved" | "unverified";
  resolvedScanId: string | null;
  latestScanId: string | null;
  latestOutcome: string | null;
  verifiedAt: string | null;
} {
  if (!latest) {
    return { status: "unverified", resolvedScanId: null, latestScanId: null, latestOutcome: null, verifiedAt: null };
  }
  const verifiedAt = latest.completedAt ? latest.completedAt.toISOString() : null;
  if (latest.outcome === "pass") {
    return { status: "resolved", resolvedScanId: latest.scanId, latestScanId: latest.scanId, latestOutcome: latest.outcome, verifiedAt };
  }
  return { status: "unresolved", resolvedScanId: null, latestScanId: latest.scanId, latestOutcome: latest.outcome, verifiedAt };
}

function publicProposal(row: ProposalRow): Record<string, unknown> {
  const artifact = assertArtifactIntegrity(row);
  return {
    id: row.id, organizationId: row.organization_id, projectId: row.project_id, findingId: row.finding_id,
    requestedByIdentityUserId: row.requested_by_identity_user_id, repositoryBindingId: row.repository_binding_id,
    githubRepositoryId: row.github_repository_id.toString(), planHash: row.plan_hash, plan: row.plan_snapshot,
    approvalState: row.approval_state, status: row.status, prDeliveryStatus: derivePrDeliveryStatus(row.status), approvedByIdentityUserId: row.approved_by_identity_user_id,
    approvedAt: row.approved_at?.toISOString() ?? null, rejectedByIdentityUserId: row.rejected_by_identity_user_id,
    executionArtifact: artifact ? executionArtifactMetadata(artifact, row.execution_artifact_hash!) : null,
    approvedArtifactHash: row.approved_artifact_hash,
    rejectedAt: row.rejected_at?.toISOString() ?? null, invalidatedAt: row.invalidated_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString()
  };
}

export class PrismaRemediationProposalRepository implements RemediationProposalStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly artifactSnapshots?: TrustedRepositorySnapshotReader
  ) {}

  async create(input: CreateRemediationProposalInput): Promise<{ proposal: Record<string, unknown>; replayed: boolean }> {
    let conflictIdentity: { key: string; hash: string; binding: string; repositoryId: bigint; organizationId: string; findingId: string } | null = null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const context = await this.loadContext(tx, input.tenantId, input.projectId, input.findingId, input.requesterIdentityUserId, "remediation:create", { adoptPreAdoptionFinding: true });
        const snapshot = makePlanSnapshot(context.project.id, context.finding, context.binding);
        const planHash = hashPlan(snapshot);
        const idempotencyKey = buildIdempotencyKey(input.tenantId, context.finding.id, context.finding.ruleId, context.finding.ruleVersion);
        conflictIdentity = { key: idempotencyKey, hash: planHash, binding: context.binding.id, repositoryId: context.binding.githubRepositoryId, organizationId: context.project.organizationId!, findingId: context.finding.id };
        const prior = await tx.$queryRaw<ProposalRow[]>`SELECT ${Prisma.raw(RETURNING_PROPOSAL)} FROM remediations WHERE idempotency_key = ${idempotencyKey} LIMIT 1`;
        if (prior[0]) return this.replayOrConflict(prior[0], input, context, planHash);

        const id = randomUUID();
        const inserted = await tx.$queryRaw<ProposalRow[]>`
          INSERT INTO remediations (
            id, tenant_id, organization_id, project_id, scan_id, finding_id, idempotency_key, status,
            retries_left, requested_by_identity_user_id, repository_binding_id, github_repository_id,
            plan_hash, plan_snapshot, approval_state
          ) VALUES (
            ${id}, ${input.tenantId}, ${context.project.organizationId}::uuid, ${context.project.id}, ${context.finding.scanId},
            ${context.finding.id}, ${idempotencyKey}, 'pending_approval', 3, ${input.requesterIdentityUserId}::uuid,
            ${context.binding.id}::uuid, ${context.binding.githubRepositoryId}, ${planHash}, ${JSON.stringify(snapshot)}::jsonb, 'pending'
          ) RETURNING ${Prisma.raw(RETURNING_PROPOSAL)}
        `;
        const row = inserted[0];
        if (!row) throw new Error("Proposal insert did not return a row.");
        assertPlanSnapshotIntegrity(row);
        await tx.auditEvent.create({ data: {
          tenantId: input.tenantId, organizationId: context.project.organizationId, projectId: context.project.id,
          actorId: input.actorSubject, actorIdentityUserId: input.requesterIdentityUserId,
          action: "REMEDIATION_PROPOSAL_CREATED", resourceType: "remediation", resourceId: row.id,
          metadataJson: { findingId: row.finding_id, ...(row.finding_id !== input.findingId ? { sourceFindingId: input.findingId, sourceScanId: context.sourceScanId } : {}), planHash, repositoryBindingId: context.binding.id, githubRepositoryId: context.binding.githubRepositoryId.toString() }
        } });
        await tx.organizationAuditEvent.create({ select: { id: true }, data: {
          organizationId: context.project.organizationId!, tenantId: input.tenantId, projectId: context.project.id,
          actorType: "user", actorUserId: input.requesterIdentityUserId, action: "REMEDIATION_PROPOSAL_CREATED",
          targetType: "remediation", targetId: row.id,
          metadata: { planHash, repositoryBindingId: context.binding.id, githubRepositoryId: context.binding.githubRepositoryId.toString(), ...(row.finding_id !== input.findingId ? { findingId: row.finding_id, sourceFindingId: input.findingId, sourceScanId: context.sourceScanId } : {}) }
        } });
        return { proposal: publicProposal(row), replayed: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof RemediationProposalError) throw error;
      if (!isWriteConflict(error)) throw error;
      const conflict = conflictIdentity as { key: string; hash: string; binding: string; repositoryId: bigint; organizationId: string; findingId: string } | null;
      if (conflict) {
        const winner = await this.prisma.$queryRaw<ProposalRow[]>`
          SELECT ${Prisma.raw(RETURNING_PROPOSAL)} FROM remediations WHERE idempotency_key = ${conflict.key} LIMIT 1
        `;
        if (winner[0] && winner[0].tenant_id === input.tenantId && winner[0].project_id === input.projectId &&
            winner[0].finding_id === conflict.findingId && winner[0].organization_id === conflict.organizationId &&
            winner[0].repository_binding_id === conflict.binding && winner[0].github_repository_id === conflict.repositoryId &&
            winner[0].plan_hash === conflict.hash && winner[0].approval_state !== null) {
          assertPlanSnapshotIntegrity(winner[0]);
          return { proposal: publicProposal(winner[0]), replayed: true };
        }
      }
      throw new RemediationProposalError(409, "The proposal changed concurrently or conflicts with an existing remediation.");
    }
  }

  private replayOrConflict(
    prior: ProposalRow, input: CreateRemediationProposalInput,
    context: Awaited<ReturnType<PrismaRemediationProposalRepository["loadContext"]>>, planHash: string
  ) {
    if (prior.tenant_id !== input.tenantId || prior.project_id !== input.projectId || prior.finding_id !== context.finding.id ||
        prior.organization_id !== context.project.organizationId || prior.repository_binding_id !== context.binding.id ||
        prior.github_repository_id !== context.binding.githubRepositoryId || prior.plan_hash !== planHash || prior.approval_state === null) {
      throw new RemediationProposalError(409, "An existing remediation conflicts with the current proposal context.");
    }
    assertPlanSnapshotIntegrity(prior);
    return { proposal: publicProposal(prior), replayed: true };
  }

  async listByProject(input: RemediationProposalListInput): Promise<RemediationProposalPage> {
    const project = await this.prisma.project.findFirst({
      where: { id: input.projectId, tenantId: input.tenantId },
      select: { id: true, organizationId: true }
    });
    if (!project) throw new RemediationProposalError(404, "Project not found.");
    if (!project.organizationId) return { items: [], hasMore: false };
    const member = await this.prisma.organizationMember.findFirst({
      where: {
        organizationId: project.organizationId,
        userId: input.identityUserId,
        status: "active",
        user: { is: { status: "active" } },
        organization: { is: { status: "active" } }
      },
      select: { role: true }
    });
    if (!member || !hasOrganizationPermission(member.role, "remediation:read")) {
      throw new RemediationProposalError(404, "Project not found.");
    }

    let cursorRow: { id: string; created_at: Date } | undefined;
    if (input.cursor) {
      const cursorRows = await this.prisma.$queryRaw<Array<{ id: string; created_at: Date }>>`
        SELECT id, created_at FROM remediations
        WHERE id = ${input.cursor}
          AND tenant_id = ${input.tenantId}
          AND project_id = ${input.projectId}
          AND organization_id = ${project.organizationId}::uuid
          AND approval_state IS NOT NULL
        LIMIT 1
      `;
      cursorRow = cursorRows[0];
      if (!cursorRow) throw new RemediationProposalError(400, "Invalid remediation proposal cursor.");
    }

    const rows = await this.prisma.$queryRaw<ProposalRow[]>`
      SELECT ${Prisma.raw(RETURNING_PROPOSAL)} FROM remediations
      WHERE tenant_id = ${input.tenantId}
        AND project_id = ${input.projectId}
        AND organization_id = ${project.organizationId}::uuid
        AND approval_state IS NOT NULL
        ${cursorRow ? Prisma.sql`AND (created_at < ${cursorRow.created_at} OR (created_at = ${cursorRow.created_at} AND id < ${cursorRow.id}))` : Prisma.empty}
      ORDER BY created_at DESC, id DESC
      LIMIT ${input.limit + 1}
    `;
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const items = [];
    for (const row of pageRows) {
      assertPlanSnapshotIntegrity(row);
      const checked = await this.invalidateIfFindingResolved(this.prisma, row);
      const latestOutcome = await this.findLatestFindingOutcomeForProposal(this.prisma, checked.row);
      const invalidationReason = await this.resolveInvalidationReason(this.prisma, checked.row, checked.resolvedScanId);
      items.push({
        ...publicProposal(checked.row),
        findingResolution: deriveFindingResolution(latestOutcome),
        ...(invalidationReason ? { invalidationReason } : {})
      });
    }
    return {
      items,
      hasMore,
      ...(hasMore && pageRows.length > 0 ? { nextCursor: pageRows[pageRows.length - 1].id } : {})
    };
  }

  async read(input: { tenantId: string; remediationId: string; identityUserId: string }): Promise<Record<string, unknown>> {
    const rows = await this.prisma.$queryRaw<ProposalRow[]>`
      SELECT ${Prisma.raw(RETURNING_PROPOSAL)} FROM remediations WHERE id = ${input.remediationId} AND tenant_id = ${input.tenantId} LIMIT 1
    `;
    const row = rows[0];
    if (!row?.organization_id || row.approval_state === null) throw new RemediationProposalError(404, "Remediation proposal not found.");
    const member = await this.prisma.organizationMember.findFirst({
      where: { organizationId: row.organization_id, userId: input.identityUserId, status: "active", user: { is: { status: "active" } }, organization: { is: { status: "active" } } },
      select: { role: true }
    });
    if (!member || !hasOrganizationPermission(member.role, "remediation:read")) throw new RemediationProposalError(404, "Remediation proposal not found.");
    assertPlanSnapshotIntegrity(row);
    assertArtifactIntegrity(row);
    const checked = await this.invalidateIfFindingResolved(this.prisma, row);
    const latestOutcome = await this.findLatestFindingOutcomeForProposal(this.prisma, checked.row);
    const invalidationReason = await this.resolveInvalidationReason(this.prisma, checked.row, checked.resolvedScanId);
    const execution = await this.prisma.remediationExecution.findFirst({
      where: { remediationId: row.id, tenantId: row.tenant_id, organizationId: row.organization_id, projectId: row.project_id },
      select: { status: true, stage: true, attemptNumber: true, commitSha: true, branchName: true,
        pullRequestNumber: true, pullRequestUrl: true, failureCode: true, updatedAt: true }
    });
    return { ...publicProposal(checked.row), prDeliveryStatus: derivePrDeliveryStatus(checked.row.status, execution?.status), findingResolution: deriveFindingResolution(latestOutcome), ...(invalidationReason ? { invalidationReason } : {}), permissions: {
      prepareArtifact: hasOrganizationPermission(member.role, "remediation:create"),
      approve: hasOrganizationPermission(member.role, "remediation:approve")
    }, execution: execution ? {
      status: execution.status, stage: execution.stage, attemptNumber: execution.attemptNumber,
      commitSha: execution.commitSha, branchName: execution.branchName,
      pullRequestNumber: execution.pullRequestNumber, pullRequestUrl: execution.pullRequestUrl,
      failureCode: execution.failureCode, updatedAt: execution.updatedAt.toISOString()
    } : null };
  }

  /**
   * Trusted generation entry point. It accepts only persisted proposal identity;
   * plan, finding, repository scope, patch, and artifact hash are all derived here.
   */
  async prepareExecutionArtifact(input: {
    tenantId: string; remediationId: string; identityUserId: string;
  }): Promise<{ artifactHash: string; replayed: boolean }> {
    const artifactSnapshots = this.artifactSnapshots;
    if (!artifactSnapshots) throw new RemediationProposalError(503, "Execution artifact preparation is unavailable.");
    const prepared = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<ProposalRow[]>`
        SELECT ${Prisma.raw(RETURNING_PROPOSAL)} FROM remediations
        WHERE id = ${input.remediationId} AND tenant_id = ${input.tenantId} FOR UPDATE
      `;
      const row = rows[0];
      if (!row?.organization_id || row.approval_state === null) throw new RemediationProposalError(404, "Remediation proposal not found.");
      await this.requireMembership(tx, input.identityUserId, row.organization_id, "remediation:create");
      assertPlanSnapshotIntegrity(row);
      if (row.approval_state !== "pending" || row.status !== "pending_approval")
        throw new RemediationProposalError(409, "The proposal is no longer eligible for an execution artifact.");
      const resolvedCheck = await this.invalidateIfFindingResolved(tx, row, input.identityUserId);
      if (resolvedCheck.resolvedScanId) {
        throw new RemediationProposalError(409, "The original finding was resolved in a newer completed scan; review a new proposal if the gap recurs.");
      }
      if (row.execution_artifact !== null || row.execution_artifact_hash !== null) {
        const existing = assertArtifactIntegrity(row);
        if (existing && row.execution_artifact_hash) return { kind: "replay" as const, replay: row.execution_artifact_hash };
        throw new RemediationProposalError(409, "The proposal already has an immutable execution artifact.");
      }
      const current = await this.loadContext(tx, row.tenant_id, row.project_id, row.finding_id,
        input.identityUserId, "remediation:create");
      const currentPlan = makePlanSnapshot(current.project.id, current.finding, current.binding);
      if (current.project.organizationId !== row.organization_id || current.binding.id !== row.repository_binding_id ||
          current.binding.githubRepositoryId !== row.github_repository_id || hashPlan(currentPlan) !== row.plan_hash)
        throw new RemediationProposalError(409, "The proposal context changed; review a new proposal.");
      const patch = planRemediation(current.finding);
      const persistedPatch = (row.plan_snapshot as Record<string, any>).patch;
      if (patch.filePath !== persistedPatch.filePath || patch.prTitle !== persistedPatch.title ||
          patch.prBody !== persistedPatch.body || patch.commitMessage !== persistedPatch.commitMessage ||
          patch.summary !== persistedPatch.summary)
        throw new RemediationProposalError(409, "The proposal context changed; review a new proposal.");
      const context: RemediationProposalArtifactContext = {
        identityUserId: input.identityUserId, proposalId: row.id, tenantId: row.tenant_id, organizationId: row.organization_id,
        projectId: row.project_id, repositoryBindingId: current.binding.id,
        installationRecordId: current.binding.installationRecordId,
        githubRepositoryId: current.binding.githubRepositoryId.toString(),
        planHash: row.plan_hash, filePath: patch.filePath
      };
      return { kind: "ready" as const, context, finding: current.finding };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    if (prepared.kind === "replay") return { artifactHash: prepared.replay, replayed: true };
    let snapshot: TrustedRepositorySnapshot;
    try {
      snapshot = await artifactSnapshots.readSnapshot({
        identityUserId: prepared.context.identityUserId,
        tenantId: prepared.context.tenantId,
        organizationId: prepared.context.organizationId,
        projectId: prepared.context.projectId,
        repositoryBindingId: prepared.context.repositoryBindingId,
        installationRecordId: prepared.context.installationRecordId,
        immutableRepositoryId: prepared.context.githubRepositoryId,
        filePath: prepared.context.filePath
      });
    } catch {
      throw new RemediationProposalError(502, "Trusted repository snapshot could not be read.");
    }
    if (!snapshot || typeof snapshot !== "object" || snapshot.immutableRepositoryId !== prepared.context.githubRepositoryId)
      throw new RemediationProposalError(409, "The trusted repository snapshot does not match the proposal.");
    let sealed: { artifact: RemediationExecutionArtifact; artifactHash: string };
    try {
      sealed = renderExecutionArtifact({
        scope: {
          proposalId: prepared.context.proposalId, tenantId: prepared.context.tenantId,
          organizationId: prepared.context.organizationId, projectId: prepared.context.projectId,
          repositoryBindingId: prepared.context.repositoryBindingId,
          githubRepositoryId: prepared.context.githubRepositoryId,
          installationRecordId: prepared.context.installationRecordId, planHash: prepared.context.planHash
        },
        finding: prepared.finding,
        snapshot
      });
    } catch {
      throw new RemediationProposalError(409, "Trusted repository snapshot validation failed.");
    }
    const expectedOperation = snapshot.file.content === null ? "create" : "update";
    if (sealed.artifact.filePath !== prepared.context.filePath || sealed.artifact.operation !== expectedOperation ||
        sealed.artifact.plannerVersion !== "phase07-planner-v1" || sealed.artifact.planHash !== prepared.context.planHash)
      throw new RemediationProposalError(409, "Generated artifact does not match the approved plan.");
    return this.#persistPreparedExecutionArtifact({ ...input, sealed });
  }

  async #persistPreparedExecutionArtifact(input: {
    tenantId: string; remediationId: string; identityUserId: string;
    sealed: { artifact: RemediationExecutionArtifact; artifactHash: string };
  }): Promise<{ artifactHash: string; replayed: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<ProposalRow[]>`
        SELECT ${Prisma.raw(RETURNING_PROPOSAL)} FROM remediations
        WHERE id = ${input.remediationId} AND tenant_id = ${input.tenantId} FOR UPDATE
      `;
      const row = rows[0];
      if (!row?.organization_id || row.approval_state === null) throw new RemediationProposalError(404, "Remediation proposal not found.");
      await this.requireMembership(tx, input.identityUserId, row.organization_id, "remediation:create");
      assertPlanSnapshotIntegrity(row);
      if (!verifyExecutionArtifact(input.sealed.artifact, input.sealed.artifactHash, artifactScope(row)))
        throw new RemediationProposalError(409, "Execution artifact validation failed.");
      if (row.approval_state !== "pending" || row.status !== "pending_approval")
        throw new RemediationProposalError(409, "The proposal is no longer eligible for an execution artifact.");
      const resolvedCheck = await this.invalidateIfFindingResolved(tx, row, input.identityUserId);
      if (resolvedCheck.resolvedScanId) {
        throw new RemediationProposalError(409, "The original finding was resolved in a newer completed scan; review a new proposal if the gap recurs.");
      }
      if (row.execution_artifact !== null || row.execution_artifact_hash !== null) {
        const existing = assertArtifactIntegrity(row);
        if (existing && row.execution_artifact_hash === input.sealed.artifactHash)
          return { artifactHash: input.sealed.artifactHash, replayed: true };
        throw new RemediationProposalError(409, "The proposal already has an immutable execution artifact.");
      }
      const current = await this.currentSnapshot(tx, row.tenant_id, row.organization_id, row.project_id, row.finding_id,
        input.identityUserId, row.repository_binding_id, row.github_repository_id, "remediation:create");
      if (!current || current.planHash !== row.plan_hash)
        throw new RemediationProposalError(409, "The proposal context changed; review a new proposal.");
      const updated = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE remediations SET execution_artifact = ${JSON.stringify(input.sealed.artifact)}::jsonb,
          execution_artifact_hash = ${input.sealed.artifactHash}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${row.id} AND tenant_id = ${row.tenant_id} AND organization_id = ${row.organization_id}::uuid
          AND project_id = ${row.project_id} AND repository_binding_id = ${row.repository_binding_id}::uuid
          AND github_repository_id = ${row.github_repository_id} AND plan_hash = ${row.plan_hash}
          AND approval_state = 'pending' AND status = 'pending_approval'
          AND execution_artifact IS NULL AND execution_artifact_hash IS NULL
        RETURNING id
      `;
      if (updated.length !== 1) throw new RemediationProposalError(409, "The proposal changed concurrently.");
      await this.auditDecision(tx, row.organization_id, row.tenant_id, row.project_id, row.id, input.identityUserId,
        "REMEDIATION_EXECUTION_ARTIFACT_CREATED", {
          planHash: row.plan_hash, artifactHash: input.sealed.artifactHash,
          repositoryBindingId: row.repository_binding_id, githubRepositoryId: row.github_repository_id.toString()
        });
      return { artifactHash: input.sealed.artifactHash, replayed: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async decide(input: RemediationProposalDecisionInput): Promise<
    | { kind: "decided"; approvalState: "approved" | "rejected"; status: string }
    | { kind: "conflict"; approvalState: "invalidated" | string; message: string }
  > {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<ProposalRow[]>`
          SELECT ${Prisma.raw(RETURNING_PROPOSAL)} FROM remediations WHERE id = ${input.remediationId} AND tenant_id = ${input.tenantId} FOR UPDATE
        `;
        const row = rows[0];
        if (!row?.organization_id || row.approval_state === null) throw new RemediationProposalError(404, "Remediation proposal not found.");
        await this.requireMembership(tx, input.identityUserId, row.organization_id, "remediation:approve");
        assertPlanSnapshotIntegrity(row);
        const artifact = assertArtifactIntegrity(row);
        if (row.approval_state === "invalidated") {
          return { kind: "conflict", approvalState: "invalidated", message: "This proposal has been invalidated and cannot be approved or rejected." };
        }
        if (row.approval_state !== "pending" || row.status !== "pending_approval") {
          return { kind: "conflict", approvalState: row.approval_state, message: "The proposal has already transitioned." };
        }
        const resolvedCheck = await this.invalidateIfFindingResolved(tx, row, input.identityUserId);
        if (resolvedCheck.resolvedScanId) {
          return { kind: "conflict", approvalState: "invalidated", message: "The original finding was resolved in a newer completed scan; review a new proposal if the gap recurs." };
        }
        if (input.decision === "approve" && (!artifact || !row.execution_artifact_hash)) {
          return { kind: "conflict", approvalState: row.approval_state, message: "A verified execution artifact is required before approval." };
        }

        const current = await this.currentSnapshot(tx, row.tenant_id, row.organization_id, row.project_id, row.finding_id,
          input.identityUserId, row.repository_binding_id, row.github_repository_id);
        if (!current || current.planHash !== row.plan_hash) {
          const changed = await tx.$queryRaw<Array<{ id: string }>>`
            UPDATE remediations SET approval_state = 'invalidated', invalidated_by_identity_user_id = ${input.identityUserId}::uuid,
              invalidated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ${row.id} AND tenant_id = ${row.tenant_id} AND status = 'pending_approval' AND approval_state = 'pending'
            RETURNING id
          `;
          if (changed.length !== 1) return { kind: "conflict", approvalState: "pending", message: "The proposal changed concurrently." };
          await this.auditDecision(tx, row.organization_id, row.tenant_id, row.project_id, row.id, input.identityUserId,
            "REMEDIATION_PROPOSAL_INVALIDATED", { reason: "plan_or_binding_changed", planHash: row.plan_hash });
          return { kind: "conflict", approvalState: "invalidated", message: "The plan or verified repository binding changed; review a new proposal." };
        }

        const nextState = input.decision === "approve" ? "approved" : "rejected";
        const changed = input.decision === "approve"
          ? await tx.$queryRaw<Array<{ id: string }>>`
              UPDATE remediations SET approval_state = 'approved', status = 'pending', approved_by_identity_user_id = ${input.identityUserId}::uuid,
                approved_at = CURRENT_TIMESTAMP, approved_artifact_hash = ${row.execution_artifact_hash},
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ${row.id} AND tenant_id = ${row.tenant_id} AND organization_id = ${row.organization_id}::uuid
                AND project_id = ${row.project_id} AND repository_binding_id = ${row.repository_binding_id}::uuid
                AND github_repository_id = ${row.github_repository_id} AND plan_hash = ${row.plan_hash}
                AND execution_artifact_hash = ${row.execution_artifact_hash}
                AND status = 'pending_approval' AND approval_state = 'pending' RETURNING id
            `
          : await tx.$queryRaw<Array<{ id: string }>>`
              UPDATE remediations SET approval_state = 'rejected', rejected_by_identity_user_id = ${input.identityUserId}::uuid,
                rejected_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
              WHERE id = ${row.id} AND tenant_id = ${row.tenant_id} AND organization_id = ${row.organization_id}::uuid
                AND project_id = ${row.project_id} AND repository_binding_id = ${row.repository_binding_id}::uuid
                AND github_repository_id = ${row.github_repository_id} AND plan_hash = ${row.plan_hash}
                AND status = 'pending_approval' AND approval_state = 'pending' RETURNING id
            `;
        if (changed.length !== 1) return { kind: "conflict", approvalState: "pending", message: "The proposal changed concurrently." };
        await this.auditDecision(tx, row.organization_id, row.tenant_id, row.project_id, row.id, input.identityUserId,
          input.decision === "approve" ? "REMEDIATION_APPROVED" : "REMEDIATION_REJECTED",
          { planHash: row.plan_hash, artifactHash: input.decision === "approve" ? row.execution_artifact_hash : null,
            repositoryBindingId: row.repository_binding_id, githubRepositoryId: row.github_repository_id.toString() });
        return { kind: "decided", approvalState: nextState, status: input.decision === "approve" ? "pending" : row.status };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof RemediationProposalError) throw error;
      if (isWriteConflict(error)) return { kind: "conflict", approvalState: "pending", message: "The proposal changed concurrently." };
      throw error;
    }
  }

  private async loadContext(
    tx: Prisma.TransactionClient, tenantId: string, projectId: string, findingId: string, identityUserId: string,
    permission: OrganizationPermission, options?: { adoptPreAdoptionFinding?: boolean }
  ) {
    const project = await tx.project.findFirst({ where: { id: projectId, tenantId }, select: { id: true, organizationId: true } });
    if (!project?.organizationId) throw new RemediationProposalError(404, "An adopted organization project is required.");
    await this.requireMembership(tx, identityUserId, project.organizationId, permission);
    const adoption = await tx.projectOrganizationAdoption.findFirst({
      where: { tenantId, organizationId: project.organizationId, projectId, status: "approved" }, select: { id: true }
    });
    if (!adoption) throw new RemediationProposalError(409, "Project adoption must be approved before proposing remediation.");
    const binding = await tx.projectGitHubRepository.findFirst({
      where: { tenantId, organizationId: project.organizationId, projectId, status: "active", installation: { is: { status: "active" } } },
      select: { id: true, githubRepositoryId: true, installationRecordId: true, ownerLogin: true, repositoryName: true, installation: { select: { status: true } } }
    });
    if (!binding) throw new RemediationProposalError(409, "An active verified GitHub repository binding is required.");
    const finding = await tx.finding.findFirst({
      where: { id: findingId, tenantId, projectId },
      select: { id: true, organizationId: true, scanId: true, attemptNumber: true, requirementId: true, ruleId: true, ruleVersion: true, signal: true, outcome: true, expected: true, observed: true, reason: true, evidenceJson: true, createdAt: true }
    });
    if (!finding) throw new RemediationProposalError(404, "Finding not found.");
    if (finding.outcome !== "gap") throw new RemediationProposalError(422, "Only gap findings can be proposed for remediation.");
    if (!isRemediationSupported(finding.signal, finding.outcome)) throw new RemediationProposalError(422, "This finding signal is not supported for remediation.");
    try { planRemediation(finding); } catch { throw new RemediationProposalError(422, "No safe remediation plan is available for this finding."); }
    const scoped = await this.ensureOrganizationScopedFinding(tx, tenantId, project.organizationId, projectId, adoption.id, finding as ProposalFinding, Boolean(options?.adoptPreAdoptionFinding));
    return { project, finding: scoped.finding, sourceScanId: scoped.sourceScanId, binding: binding as ProposalBinding };
  }

  private async currentSnapshot(
    tx: Prisma.TransactionClient, tenantId: string, organizationId: string, projectId: string, findingId: string,
    identityUserId: string, bindingId: string, repositoryId: bigint,
    permission: OrganizationPermission = "remediation:approve"
  ): Promise<{ planHash: string } | null> {
    try {
      const context = await this.loadContext(tx, tenantId, projectId, findingId, identityUserId, permission);
      if (context.project.organizationId !== organizationId || context.binding.id !== bindingId || context.binding.githubRepositoryId !== repositoryId) return null;
      return { planHash: hashPlan(makePlanSnapshot(projectId, context.finding, context.binding)) };
    } catch (error) {
      if (error instanceof RemediationProposalError) return null;
      throw error;
    }
  }

  private async ensureOrganizationScopedFinding(
    tx: Prisma.TransactionClient, tenantId: string, organizationId: string, projectId: string, _adoptionId: string,
    finding: ProposalFinding, adoptPreAdoptionFinding: boolean
  ): Promise<{ finding: ProposalFinding; sourceScanId: string }> {
    const scanClient = (tx as unknown as { scan?: Prisma.TransactionClient["scan"] }).scan;
    const scan = scanClient
      ? await scanClient.findFirst({
          where: { id: finding.scanId, tenantId, projectId },
          select: {
            id: true, organizationId: true, status: true, triggeredById: true, startedAt: true,
            completedAt: true, error: true, attemptCount: true, maxAttempts: true, modelOverride: true, createdAt: true
          }
        })
      : null;
    if (scanClient && !scan) throw new RemediationProposalError(404, "Scan not found.");
    if (finding.organizationId !== undefined && finding.organizationId !== null && finding.organizationId !== organizationId) {
      throw new RemediationProposalError(409, "Finding organization does not match the adopted project organization.");
    }
    if (scan && scan.organizationId !== null && scan.organizationId !== organizationId) {
      throw new RemediationProposalError(409, "Scan organization does not match the adopted project organization.");
    }

    const needsScanAdoption = Boolean(scan && scan.organizationId === null);
    const needsFindingAdoption = finding.organizationId === null || needsScanAdoption;
    if (!needsFindingAdoption) {
      return { finding, sourceScanId: finding.scanId };
    }
    if (!adoptPreAdoptionFinding || !scanClient || !scan) {
      throw new RemediationProposalError(409, "Finding is not scoped to the adopted project organization.");
    }
    if (scan.status !== "completed") {
      throw new RemediationProposalError(409, "Only findings from completed scans can be proposed for remediation.");
    }

    const adoptedScanId = needsScanAdoption
      ? deterministicAdoptionUuid(`cloudpilot:adopted-scan:v1:${tenantId}:${organizationId}:${projectId}:${scan.id}`)
      : scan.id;
    if (needsScanAdoption) {
      const existingScan = await scanClient.findFirst({
        where: { id: adoptedScanId, tenantId, organizationId, projectId },
        select: { id: true }
      });
      if (!existingScan) {
        await scanClient.create({
          data: {
            id: adoptedScanId,
            tenantId,
            organizationId,
            projectId,
            status: scan.status,
            triggeredById: scan.triggeredById ?? null,
            startedAt: scan.startedAt ?? null,
            completedAt: scan.completedAt ?? null,
            error: scan.error ?? null,
            attemptCount: scan.attemptCount ?? 1,
            maxAttempts: scan.maxAttempts ?? 3,
            modelOverride: scan.modelOverride === null || scan.modelOverride === undefined
              ? Prisma.JsonNull
              : (scan.modelOverride as Prisma.InputJsonValue),
            createdAt: scan.createdAt ?? new Date()
          },
          select: { id: true }
        });
      }
    }

    const adoptedFindingId = deterministicAdoptionUuid(
      `cloudpilot:adopted-finding:v1:${tenantId}:${organizationId}:${projectId}:${adoptedScanId}:${finding.id}`
    );
    const existingFinding = await tx.finding.findFirst({
      where: { id: adoptedFindingId, tenantId, organizationId, projectId, scanId: adoptedScanId },
      select: {
        id: true, organizationId: true, scanId: true, attemptNumber: true, requirementId: true, ruleId: true,
        ruleVersion: true, signal: true, outcome: true, expected: true, observed: true, reason: true,
        evidenceJson: true, createdAt: true
      }
    });
    if (existingFinding) {
      return { finding: existingFinding as ProposalFinding, sourceScanId: scan.id };
    }
    await tx.finding.create({
      data: {
        id: adoptedFindingId,
        tenantId,
        organizationId,
        projectId,
        scanId: adoptedScanId,
        attemptNumber: finding.attemptNumber ?? 1,
        requirementId: finding.requirementId,
        ruleId: finding.ruleId,
        ruleVersion: finding.ruleVersion,
        signal: finding.signal,
        outcome: finding.outcome,
        expected: finding.expected,
        observed: finding.observed,
        reason: finding.reason,
        evidenceJson: finding.evidenceJson === null || finding.evidenceJson === undefined
          ? {}
          : (finding.evidenceJson as Prisma.InputJsonValue),
        createdAt: finding.createdAt ?? new Date()
      },
      select: { id: true }
    });
    return {
      finding: { ...finding, id: adoptedFindingId, scanId: adoptedScanId, organizationId },
      sourceScanId: scan.id
    };
  }

  private async findLatestFindingOutcomeForProposal(
    client: PrismaClient | Prisma.TransactionClient,
    row: ProposalRow
  ): Promise<{ scanId: string; outcome: string; completedAt: Date | null } | null> {
    const rows = await client.$queryRaw<Array<{ scan_id: string; outcome: string; completed_at: Date | null }>>`
      SELECT s.id AS scan_id, resolved.outcome AS outcome, s.completed_at AS completed_at
      FROM findings orig
      JOIN scans orig_s
        ON orig_s.id = orig.scan_id
       AND orig_s.tenant_id = orig.tenant_id
       AND orig_s.project_id = orig.project_id
      JOIN scans s
        ON s.tenant_id = orig.tenant_id
       AND s.project_id = orig.project_id
      JOIN findings resolved
        ON resolved.scan_id = s.id
       AND resolved.tenant_id = s.tenant_id
       AND resolved.project_id = s.project_id
      WHERE orig.id = ${row.finding_id}
        AND orig.tenant_id = ${row.tenant_id}
        AND orig.project_id = ${row.project_id}
        AND s.id <> orig.scan_id
        AND s.status = 'completed'
        AND COALESCE(s.completed_at, s.created_at) > GREATEST(COALESCE(orig_s.completed_at, orig_s.created_at), ${row.created_at})
        AND resolved.requirement_id = orig.requirement_id
        AND resolved.rule_id = orig.rule_id
        AND resolved.rule_version = orig.rule_version
        AND resolved.signal = orig.signal
      ORDER BY COALESCE(s.completed_at, s.created_at) DESC, s.id DESC
      LIMIT 1
    `;
    if (!rows[0]) return null;
    return { scanId: rows[0].scan_id, outcome: rows[0].outcome, completedAt: rows[0].completed_at };
  }

  private async findResolvedScanForProposal(
    client: PrismaClient | Prisma.TransactionClient,
    row: ProposalRow
  ): Promise<{ scanId: string; completedAt: Date | null } | null> {
    const latest = await this.findLatestFindingOutcomeForProposal(client, row);
    if (!latest || latest.outcome !== "pass") return null;
    return { scanId: latest.scanId, completedAt: latest.completedAt };
  }

  private async invalidateIfFindingResolved(
    client: PrismaClient | Prisma.TransactionClient,
    row: ProposalRow,
    actorIdentityUserId?: string
  ): Promise<{ row: ProposalRow; resolvedScanId: string | null }> {
    if (row.approval_state !== "pending" || row.status !== "pending_approval") {
      return { row, resolvedScanId: null };
    }
    const resolved = await this.findResolvedScanForProposal(client, row);
    if (!resolved) return { row, resolvedScanId: null };

    const invalidatedBy = actorIdentityUserId ?? row.requested_by_identity_user_id;
    const updated = await client.$queryRaw<ProposalRow[]>`
      UPDATE remediations
      SET approval_state = 'invalidated',
          invalidated_by_identity_user_id = ${invalidatedBy}::uuid,
          invalidated_at = COALESCE(invalidated_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${row.id}
        AND tenant_id = ${row.tenant_id}
        AND status = 'pending_approval'
        AND approval_state = 'pending'
      RETURNING ${Prisma.raw(RETURNING_PROPOSAL)}
    `;
    const nextRow = updated[0] ?? row;
    if (updated[0]) {
      await client.organizationAuditEvent.create({
        select: { id: true },
        data: {
          organizationId: row.organization_id,
          tenantId: row.tenant_id,
          projectId: row.project_id,
          actorType: actorIdentityUserId ? "user" : "system",
          ...(actorIdentityUserId ? { actorUserId: actorIdentityUserId } : { systemActorId: "stale-proposal-check" }),
          action: "REMEDIATION_PROPOSAL_INVALIDATED",
          targetType: "remediation",
          targetId: row.id,
          metadata: { reason: "finding_resolved", resolvedScanId: resolved.scanId, planHash: row.plan_hash } as Prisma.InputJsonValue
        }
      });
    }
    return { row: nextRow, resolvedScanId: resolved.scanId };
  }

  private async resolveInvalidationReason(
    client: PrismaClient | Prisma.TransactionClient,
    row: ProposalRow,
    resolvedScanId?: string | null
  ): Promise<string | null> {
    if (row.approval_state !== "invalidated") return null;
    if (resolvedScanId) {
      return "The original finding was resolved in a newer completed scan.";
    }
    const resolved = await this.findResolvedScanForProposal(client, row);
    if (resolved) {
      return "The original finding was resolved in a newer completed scan.";
    }
    return "The plan, repository binding, or underlying finding state changed; review a new proposal if needed.";
  }

  private async requireMembership(
    tx: Prisma.TransactionClient, identityUserId: string, organizationId: string, permission: OrganizationPermission
  ): Promise<void> {
    const membership = await tx.organizationMember.findFirst({
      where: { organizationId, userId: identityUserId, status: "active", user: { is: { status: "active" } }, organization: { is: { status: "active" } } },
      select: { role: true }
    });
    if (!membership || !hasOrganizationPermission(membership.role, permission)) throw new RemediationProposalError(404, "Remediation proposal not found.");
  }

  private async auditDecision(
    tx: Prisma.TransactionClient, organizationId: string, tenantId: string, projectId: string, remediationId: string,
    actorUserId: string, action: string, metadata: Record<string, string | null>
  ): Promise<void> {
    await tx.organizationAuditEvent.create({ select: { id: true }, data: {
      organizationId, tenantId, projectId, actorType: "user", actorUserId, action,
      targetType: "remediation", targetId: remediationId, metadata: metadata as Prisma.InputJsonValue
    } });
  }
}
