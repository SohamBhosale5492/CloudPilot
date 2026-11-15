import { Prisma, PrismaClient } from "@prisma/client";
import type { RemediationLease } from "../jobs/remediation-repo.js";
import { hasOrganizationPermission } from "../organizations/permissions.js";
import { verifyPlanSnapshotIntegrity } from "../api/remediation-proposal-repo.js";
import { verifyExecutionArtifact, type RemediationExecutionArtifact } from "./execution-artifact.js";
import {
  lockActiveBindingInstallation,
  lockActiveMember,
  lockActiveOrganization,
  lockScopedFinding,
  withSerializationRetry
} from "./postgres-lock-helpers.js";

const contextBrand: unique symbol = Symbol("TrustedClaimExecutionContext");
const trustedContexts = new WeakSet<object>();

export interface TrustedClaimExecutionContext {
  readonly [contextBrand]: true;
  readonly remediationId: string;
  readonly proposalId: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly scanId: string;
  readonly findingId: string;
  readonly requesterIdentityUserId: string;
  readonly approverIdentityUserId: string;
  readonly approvedAt: string;
  readonly repositoryBindingId: string;
  readonly installationRecordId: string;
  readonly githubInstallationId: string;
  readonly githubRepositoryId: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly baseRef: string;
  readonly baseCommitSha: string;
  readonly artifactHash: string;
  readonly filePath: string;
  readonly operation: "create" | "update";
  readonly mode: "100644";
  readonly originalContentBase64: string | null;
  readonly originalBlobSha: string | null;
  readonly originalContentSha256: string | null;
  readonly originalMode: "100644" | null;
  readonly originalFileType: "blob" | null;
  readonly renderedContentSha256: string;
  /** Returns a copy; mutations by a caller cannot alter the retained bytes. */
  readonly renderedBytes: Uint8Array;
  readonly lease: Readonly<{
    remediationId: string;
    tenantId: string;
    projectId: string;
    workerId: string;
    leaseToken: string;
    expiresAt: string;
  }>;
}

export function isTrustedClaimExecutionContext(value: unknown): value is TrustedClaimExecutionContext {
  return !!value && typeof value === "object" && trustedContexts.has(value as object);
}

interface PersistedClaimState {
  remediation: {
    id: string; tenantId: string; organizationId: string | null; projectId: string; scanId: string; findingId: string;
    status: string; workerId: string | null; leaseToken: string | null; approvalState: string | null;
    requestedByIdentityUserId: string | null; approvedByIdentityUserId: string | null; approvedAt: Date | null;
    repositoryBindingId: string | null; githubRepositoryId: bigint | null; planHash: string | null; planSnapshot: unknown;
    executionArtifact: unknown; executionArtifactHash: string | null; approvedArtifactHash: string | null;
    leaseExpiresAt: Date;
  };
  organizationStatus: string | null;
  project: { id: string; tenantId: string; organizationId: string | null } | null;
  scan: { id: string; tenantId: string; projectId: string } | null;
  finding: {
    id: string; tenantId: string; projectId: string; scanId: string; requirementId: string; ruleId: string;
    ruleVersion: string; signal: string; outcome: string; expected: string; observed: string; reason: string;
  } | null;
  adoptionStatus: string | null;
  binding: {
    id: string; tenantId: string; organizationId: string; projectId: string; installationRecordId: string;
    githubRepositoryId: bigint; ownerLogin: string; repositoryName: string; status: string;
    installation: { organizationId: string; status: string; githubInstallationId: bigint };
  } | null;
  requesterStatus: string | null;
  approverStatus: string | null;
  approverMembership: { role: string; status: string; userStatus: string; organizationStatus: string } | null;
}

interface TrustedClaimExecutionContextRepository {
  /** The implementation locks and validates the lease in a serializable transaction. */
  withLockedClaim<T>(lease: RemediationLease, build: (state: PersistedClaimState) => T | null): Promise<T | null>;
}

/**
 * Read-only persisted-state loader. The remediation row is locked for the
 * duration of validation and rechecked against database time before returning.
 */
class PrismaTrustedClaimExecutionContextRepository implements TrustedClaimExecutionContextRepository {
  constructor(private readonly prisma: PrismaClient) {}

  withLockedClaim<T>(lease: RemediationLease, build: (state: PersistedClaimState) => T | null): Promise<T | null> {
    return withSerializationRetry(() => this.prisma.$transaction((tx) => this.withLockedClaimInTransaction(tx, lease, build), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));

  }

  withLockedClaimInTransaction<T>(tx: Prisma.TransactionClient, lease: RemediationLease,
    build: (state: PersistedClaimState) => T | null): Promise<T | null> {
    return (async () => {
      const locked = await tx.$queryRaw<Array<PersistedClaimState["remediation"]>>`
        SELECT id, tenant_id AS "tenantId", organization_id AS "organizationId", project_id AS "projectId",
          scan_id AS "scanId", finding_id AS "findingId", status, worker_id AS "workerId",
          lease_token::text AS "leaseToken", lease_expires_at AS "leaseExpiresAt", approval_state AS "approvalState",
          requested_by_identity_user_id AS "requestedByIdentityUserId",
          approved_by_identity_user_id AS "approvedByIdentityUserId", approved_at AS "approvedAt",
          repository_binding_id AS "repositoryBindingId", github_repository_id AS "githubRepositoryId",
          plan_hash AS "planHash", plan_snapshot AS "planSnapshot", execution_artifact AS "executionArtifact",
          execution_artifact_hash AS "executionArtifactHash", approved_artifact_hash AS "approvedArtifactHash"
        FROM remediations
        WHERE id = ${lease.id}
          AND tenant_id = ${lease.tenantId}
          AND project_id = ${lease.projectId}
          AND status = 'running'
          AND worker_id = ${lease.workerId}
          AND lease_token = ${lease.leaseToken}::uuid
          AND lease_expires_at > clock_timestamp()
        FOR UPDATE
      `;
      if (locked.length !== 1) return null;
      const remediation = locked[0];
      if (!remediation?.organizationId || !remediation.requestedByIdentityUserId || !remediation.approvedByIdentityUserId ||
          !remediation.repositoryBindingId || !remediation.githubRepositoryId) return null;

      // Lock every authorization-bearing row until context issuance. Concurrent
      // revocation/reassignment either commits before these locks (and fails the
      // predicates) or waits until this serializable preparation has completed.
      const bindingIdentity = await tx.projectGitHubRepository.findFirst({
        where: { id: remediation.repositoryBindingId, tenantId: remediation.tenantId,
          organizationId: remediation.organizationId, projectId: remediation.projectId,
          githubRepositoryId: remediation.githubRepositoryId },
        select: { installationRecordId: true }
      });
      if (!bindingIdentity) return null;
      const authorizationLocks = await Promise.all([
        lockActiveOrganization(tx, remediation.organizationId),
        tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM projects WHERE id = ${remediation.projectId} AND tenant_id = ${remediation.tenantId} AND organization_id = ${remediation.organizationId}::uuid FOR SHARE`,
        tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM scans WHERE id = ${remediation.scanId} AND tenant_id = ${remediation.tenantId} AND project_id = ${remediation.projectId} FOR SHARE`,
        lockScopedFinding(tx, remediation.tenantId, remediation.projectId, remediation.scanId, remediation.findingId),
        tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM project_organization_adoptions WHERE tenant_id = ${remediation.tenantId} AND organization_id = ${remediation.organizationId}::uuid AND project_id = ${remediation.projectId} AND status = 'approved' FOR SHARE`,
        lockActiveBindingInstallation(tx, { tenantId: remediation.tenantId, organizationId: remediation.organizationId,
          projectId: remediation.projectId, bindingId: remediation.repositoryBindingId,
          installationId: bindingIdentity.installationRecordId, githubRepositoryId: remediation.githubRepositoryId.toString() }),
        tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM identity_users WHERE id = ${remediation.requestedByIdentityUserId}::uuid AND status = 'active' FOR SHARE`,
        tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM identity_users WHERE id = ${remediation.approvedByIdentityUserId}::uuid AND status = 'active' FOR SHARE`,
        lockActiveMember(tx, remediation.organizationId, remediation.approvedByIdentityUserId)
      ]);
      if (authorizationLocks.some((result) => Array.isArray(result) ? result.length !== 1 : !result)) return null;

      const [organization, project, scan, finding, adoption, binding, identities, membership] = await Promise.all([
        tx.organization.findUnique({ where: { id: remediation.organizationId }, select: { status: true } }),
        tx.project.findFirst({
          where: { id: remediation.projectId, tenantId: remediation.tenantId, organizationId: remediation.organizationId },
          select: { id: true, tenantId: true, organizationId: true }
        }),
        tx.scan.findFirst({
          where: { id: remediation.scanId, tenantId: remediation.tenantId, projectId: remediation.projectId },
          select: { id: true, tenantId: true, projectId: true }
        }),
        tx.finding.findFirst({
          where: { id: remediation.findingId, tenantId: remediation.tenantId, projectId: remediation.projectId, scanId: remediation.scanId },
          select: { id: true, tenantId: true, projectId: true, scanId: true, requirementId: true,
            ruleId: true, ruleVersion: true, signal: true, outcome: true, expected: true, observed: true, reason: true }
        }),
        tx.projectOrganizationAdoption.findFirst({
          where: { tenantId: remediation.tenantId, organizationId: remediation.organizationId,
            projectId: remediation.projectId, status: "approved" }, select: { status: true }
        }),
        tx.projectGitHubRepository.findFirst({
          where: { id: remediation.repositoryBindingId, tenantId: remediation.tenantId,
            organizationId: remediation.organizationId, projectId: remediation.projectId,
            githubRepositoryId: remediation.githubRepositoryId, status: "active",
            installation: { is: { organizationId: remediation.organizationId, status: "active", organization: { is: { status: "active" } } } } },
          select: { id: true, tenantId: true, organizationId: true, projectId: true, installationRecordId: true,
            githubRepositoryId: true, ownerLogin: true, repositoryName: true, status: true,
            installation: { select: { organizationId: true, status: true, githubInstallationId: true } } }
        }),
        tx.identityUser.findMany({
          where: { id: { in: [remediation.requestedByIdentityUserId, remediation.approvedByIdentityUserId] } },
          select: { id: true, status: true }
        }),
        tx.organizationMember.findFirst({
          where: { organizationId: remediation.organizationId, userId: remediation.approvedByIdentityUserId,
            status: "active", user: { is: { status: "active" } }, organization: { is: { status: "active" } } },
          select: { role: true, status: true, user: { select: { status: true } }, organization: { select: { status: true } } }
        })
      ]);
      const identityStatuses = new Map(identities.map((identity) => [identity.id, identity.status]));
      const state: PersistedClaimState = {
        remediation,
        organizationStatus: organization?.status ?? null,
        project,
        scan,
        finding,
        adoptionStatus: adoption?.status ?? null,
        binding: binding ? { ...binding, githubRepositoryId: binding.githubRepositoryId,
          installation: { ...binding.installation, githubInstallationId: binding.installation.githubInstallationId } } : null,
        requesterStatus: identityStatuses.get(remediation.requestedByIdentityUserId) ?? null,
        approverStatus: identityStatuses.get(remediation.approvedByIdentityUserId) ?? null,
        approverMembership: membership ? { role: membership.role, status: membership.status,
          userStatus: membership.user.status, organizationStatus: membership.organization.status } : null
      };
      const result = build(state);
      if (!result) return null;

      const stillOwned = await tx.$queryRaw<Array<{ id: string; leaseExpiresAt: Date }>>`
        SELECT id, lease_expires_at AS "leaseExpiresAt" FROM remediations
        WHERE id = ${lease.id}
          AND tenant_id = ${lease.tenantId}
          AND project_id = ${lease.projectId}
          AND status = 'running'
          AND worker_id = ${lease.workerId}
          AND lease_token = ${lease.leaseToken}::uuid
          AND lease_expires_at > clock_timestamp()
        FOR UPDATE
      `;
      return stillOwned.length === 1 ? result : null;
    })();
  }
}

/** Builds contexts only after persisted proposal, artifact, relationship, approval and lease checks. */
export class TrustedClaimExecutionContextService {
  private readonly repository: TrustedClaimExecutionContextRepository;

  constructor(prisma: PrismaClient) {
    this.repository = new PrismaTrustedClaimExecutionContextRepository(prisma);
  }

  prepare(lease: RemediationLease): Promise<TrustedClaimExecutionContext | null> {
    return this.repository.withLockedClaim(lease, (state) => this.buildContext(lease, state));
  }

  /** Builds the same trusted context inside an already-open serializable claim transaction. */
  prepareWithinTransaction(tx: Prisma.TransactionClient, lease: RemediationLease): Promise<TrustedClaimExecutionContext | null> {
    if (!(this.repository instanceof PrismaTrustedClaimExecutionContextRepository)) return Promise.resolve(null);
    return this.repository.withLockedClaimInTransaction(tx, lease, (state) => this.buildContext(lease, state));
  }

  private buildContext(lease: RemediationLease, state: PersistedClaimState): TrustedClaimExecutionContext | null {
    const r = state.remediation;
    const orgId = r.organizationId;
    const binding = state.binding;
    const membership = state.approverMembership;
    if (r.id !== lease.id || r.tenantId !== lease.tenantId || r.projectId !== lease.projectId ||
        r.status !== "running" || r.workerId !== lease.workerId || r.leaseToken !== lease.leaseToken ||
        r.approvalState !== "approved" || !r.approvedAt || !r.requestedByIdentityUserId || !r.approvedByIdentityUserId ||
        state.requesterStatus !== "active" || state.approverStatus !== "active" || !orgId || state.organizationStatus !== "active" ||
        // Conservative policy pending product review: the requester must remain
        // an active identity, and the approver must still be an active member
        // with remediation:approve. The prior API authorization contract did
        // not define whether approval survives later membership revocation.
        !membership || membership.status !== "active" || membership.userStatus !== "active" ||
        membership.organizationStatus !== "active" || !hasOrganizationPermission(membership.role, "remediation:approve") ||
        !state.project || state.project.id !== r.projectId || state.project.tenantId !== r.tenantId || state.project.organizationId !== orgId ||
        !state.scan || state.scan.id !== r.scanId || state.scan.tenantId !== r.tenantId || state.scan.projectId !== r.projectId ||
        !state.finding || state.finding.id !== r.findingId || state.finding.tenantId !== r.tenantId ||
        state.finding.projectId !== r.projectId || state.finding.scanId !== r.scanId || state.adoptionStatus !== "approved" ||
        !binding || binding.status !== "active" || binding.tenantId !== r.tenantId || binding.organizationId !== orgId ||
        binding.projectId !== r.projectId || binding.id !== r.repositoryBindingId || binding.githubRepositoryId !== r.githubRepositoryId ||
        binding.installation.organizationId !== orgId || binding.installation.status !== "active" ||
        binding.installation.githubInstallationId <= 0n ||
        !this.planSnapshotMatches(r.planSnapshot, r, state, binding) ||
        !r.planHash || !verifyPlanSnapshotIntegrity(r.planSnapshot, r.planHash) || !r.executionArtifactHash ||
        r.approvedArtifactHash !== r.executionArtifactHash || !r.githubRepositoryId || r.githubRepositoryId <= 0n) return null;

    const artifactScope = {
      proposalId: r.id, tenantId: r.tenantId, organizationId: orgId, projectId: r.projectId,
      repositoryBindingId: binding.id, githubRepositoryId: r.githubRepositoryId.toString(),
      installationRecordId: binding.installationRecordId, planHash: r.planHash
    };
    if (!verifyExecutionArtifact(r.executionArtifact, r.executionArtifactHash, artifactScope)) return null;
    const artifact = r.executionArtifact as RemediationExecutionArtifact;
    const bytes = Buffer.from(artifact.renderedContent, "utf8");
    const leaseExpiry = state.remediation.leaseExpiresAt;
    if (!(leaseExpiry instanceof Date) || !Number.isFinite(leaseExpiry.getTime())) return null;
    const leaseIdentity = Object.freeze({ remediationId: r.id, tenantId: r.tenantId, projectId: r.projectId,
      workerId: lease.workerId, leaseToken: lease.leaseToken, expiresAt: leaseExpiry.toISOString() });
    const context = Object.freeze({
      [contextBrand]: true as const,
      remediationId: r.id, proposalId: r.id, tenantId: r.tenantId, organizationId: orgId,
      projectId: r.projectId, scanId: r.scanId, findingId: r.findingId,
      requesterIdentityUserId: r.requestedByIdentityUserId, approverIdentityUserId: r.approvedByIdentityUserId,
      approvedAt: r.approvedAt.toISOString(), repositoryBindingId: binding.id,
      installationRecordId: binding.installationRecordId,
      githubInstallationId: binding.installation.githubInstallationId.toString(),
      githubRepositoryId: binding.githubRepositoryId.toString(),
      repositoryOwner: binding.ownerLogin, repositoryName: binding.repositoryName,
      baseRef: artifact.baseRef, baseCommitSha: artifact.baseCommitSha, artifactHash: r.executionArtifactHash,
      filePath: artifact.filePath, operation: artifact.operation, mode: artifact.renderedMode,
      originalContentBase64: artifact.originalContentBase64,
      originalBlobSha: artifact.originalBlobSha, originalContentSha256: artifact.originalContentSha256,
      originalMode: artifact.originalMode, originalFileType: artifact.originalFileType,
      renderedContentSha256: artifact.renderedContentSha256,
      get renderedBytes(): Uint8Array { return new Uint8Array(bytes); },
      lease: leaseIdentity
    }) as TrustedClaimExecutionContext;
    trustedContexts.add(context);
    return context;
  }

  private planSnapshotMatches(
    value: unknown,
    remediation: PersistedClaimState["remediation"],
    state: PersistedClaimState,
    binding: NonNullable<PersistedClaimState["binding"]>
  ): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value) || !state.finding) return false;
    const root = value as Record<string, unknown>;
    const repository = root.repository;
    const finding = root.finding;
    const patch = root.patch;
    if (!repository || typeof repository !== "object" || Array.isArray(repository) ||
        !finding || typeof finding !== "object" || Array.isArray(finding) ||
        !patch || typeof patch !== "object" || Array.isArray(patch)) return false;
    const repo = repository as Record<string, unknown>;
    const savedFinding = finding as Record<string, unknown>;
    const savedPatch = patch as Record<string, unknown>;
    const currentFinding = state.finding;
    const artifactValue = remediation.executionArtifact;
    if (!artifactValue || typeof artifactValue !== "object" || Array.isArray(artifactValue)) return false;
    return root.schemaVersion === 1 && root.plannerVersion === "phase07-planner-v1" &&
      root.projectId === remediation.projectId && repo.bindingId === binding.id &&
      repo.repositoryId === binding.githubRepositoryId.toString() &&
      repo.installationRecordId === binding.installationRecordId &&
      repo.owner === binding.ownerLogin && repo.name === binding.repositoryName &&
      savedPatch.filePath === (artifactValue as Record<string, unknown>).filePath &&
      savedFinding.id === currentFinding.id && savedFinding.scanId === currentFinding.scanId &&
      savedFinding.requirementId === currentFinding.requirementId && savedFinding.ruleId === currentFinding.ruleId &&
      savedFinding.ruleVersion === currentFinding.ruleVersion && savedFinding.signal === currentFinding.signal &&
      savedFinding.outcome === currentFinding.outcome && savedFinding.expected === currentFinding.expected &&
      savedFinding.observed === currentFinding.observed && savedFinding.reason === currentFinding.reason;
  }
}
