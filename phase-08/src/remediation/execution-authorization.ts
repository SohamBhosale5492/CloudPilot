import { Prisma, PrismaClient } from "@prisma/client";
import { planRemediation, type FindingSummary } from "../../../phase-07/src/remediation/planner.js";
import { verifyPlanSnapshotIntegrity } from "../api/remediation-proposal-repo.js";
import { hasOrganizationPermission } from "../organizations/permissions.js";
import type { IdentityResolver } from "../identity/identity-resolver.js";
import type { VerifiedExternalIdentity } from "../identity/external-identity.js";
import {
  verifyExecutionArtifact, type RemediationExecutionArtifact
} from "./execution-artifact.js";
import type { TrustedRepositorySnapshotReader } from "./execution-artifact-preparation.js";

export type ExecutionAuthorizationFailureReason =
  | "identity_required" | "identity_not_authorized" | "proposal_not_found" | "execution_permission_denied"
  | "project_scope_invalid" | "project_not_adopted" | "installation_inactive" | "repository_binding_inactive"
  | "proposal_not_approved" | "proposal_integrity_invalid" | "artifact_integrity_invalid"
  | "artifact_context_mismatch" | "repository_state_stale" | "repository_state_unavailable"
  | "authorization_state_unavailable";

export interface RemediationExecutionAuthorization {
  readonly proposalId: string;
  readonly artifactHash: string;
  readonly identityUserId: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly repositoryBindingId: string;
  readonly githubRepositoryId: string;
  readonly installationRecordId: string;
  readonly baseRef: string;
  readonly baseCommitSha: string;
  readonly filePath: string;
  readonly originalContentBase64: string | null;
  readonly originalContentSha256: string | null;
  readonly originalBlobSha: string | null;
  readonly originalMode: "100644" | null;
  readonly originalFileType: "blob" | null;
  readonly renderedContent: string;
  readonly renderedContentSha256: string;
  readonly operation: "create" | "update";
  readonly mode: "100644";
  readonly validatedAt: string;
}

export type RemediationExecutionAuthorizationResult =
  | { readonly kind: "authorized"; readonly authorization: RemediationExecutionAuthorization }
  | { readonly kind: "denied"; readonly reason: ExecutionAuthorizationFailureReason };

export interface AuthorizeRemediationExecutionInput {
  /** Identity and tenant context must come directly from the authenticated API middleware. */
  readonly identity: VerifiedExternalIdentity | null;
  readonly tenantId: string | null;
  /** Sole caller-selected resource identifier; all artifact/repository data is loaded from persistence. */
  readonly remediationId: string;
}

export interface PersistedExecutionState {
  proposal: {
    id: string; tenantId: string; organizationId: string | null; projectId: string; findingId: string; scanId: string;
    requesterIdentityUserId: string | null; approverIdentityUserId: string | null; repositoryBindingId: string | null;
    githubRepositoryId: string | null; approvalState: string | null; status: string;
    planHash: string | null; planSnapshot: unknown; executionArtifact: unknown;
    executionArtifactHash: string | null; approvedArtifactHash: string | null;
  };
  identities: ReadonlyMap<string, string>;
  organizationStatus: string | null;
  membership: { role: string; status: string; userStatus: string; organizationStatus: string } | null;
  project: { id: string; tenantId: string; organizationId: string | null } | null;
  scan: { id: string; tenantId: string; projectId: string } | null;
  adoptionStatus: string | null;
  binding: {
    id: string; tenantId: string; organizationId: string; projectId: string;
    installationRecordId: string; githubRepositoryId: string; ownerLogin: string; repositoryName: string;
    status: string; installationOrganizationId: string; installationStatus: string;
  } | null;
  finding: FindingSummary & { id: string; scanId: string; tenantId: string; projectId: string } | null;
}

export interface RemediationExecutionAuthorizationRepository {
  load(input: { tenantId: string; remediationId: string; identityUserId: string }): Promise<PersistedExecutionState | null>;
}

/** Loads a tenant-scoped proposal and all current authorization/ownership facts in one read transaction. */
export class PrismaRemediationExecutionAuthorizationRepository implements RemediationExecutionAuthorizationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  load(input: { tenantId: string; remediationId: string; identityUserId: string }): Promise<PersistedExecutionState | null> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        id: string; tenant_id: string; organization_id: string | null; project_id: string; finding_id: string;
        scan_id: string; requested_by_identity_user_id: string | null; approved_by_identity_user_id: string | null;
        repository_binding_id: string | null; github_repository_id: bigint | null; approval_state: string | null;
        status: string; plan_hash: string | null; plan_snapshot: unknown; execution_artifact: unknown;
        execution_artifact_hash: string | null; approved_artifact_hash: string | null;
      }>>`
        SELECT id, tenant_id, organization_id, project_id, finding_id, scan_id,
          requested_by_identity_user_id, approved_by_identity_user_id, repository_binding_id, github_repository_id,
          approval_state, status, plan_hash, plan_snapshot, execution_artifact, execution_artifact_hash, approved_artifact_hash
        FROM remediations WHERE id = ${input.remediationId} AND tenant_id = ${input.tenantId}
      `;
      const proposal = rows[0];
      if (!proposal) return null;
      const organizationId = proposal.organization_id;
      const [organization, membership, project, scan, adoption, binding, finding, userRows] = await Promise.all([
        organizationId ? tx.organization.findUnique({ where: { id: organizationId }, select: { status: true } }) : null,
        organizationId ? tx.organizationMember.findFirst({
          where: { organizationId, userId: input.identityUserId },
          select: { role: true, status: true, user: { select: { status: true } }, organization: { select: { status: true } } }
        }) : null,
        tx.project.findFirst({ where: { id: proposal.project_id, tenantId: proposal.tenant_id }, select: { id: true, tenantId: true, organizationId: true } }),
        tx.scan.findFirst({ where: { id: proposal.scan_id, tenantId: proposal.tenant_id, projectId: proposal.project_id }, select: { id: true, tenantId: true, projectId: true } }),
        organizationId ? tx.projectOrganizationAdoption.findFirst({
          where: { tenantId: proposal.tenant_id, organizationId, projectId: proposal.project_id }, select: { status: true }
        }) : null,
        proposal.repository_binding_id ? tx.projectGitHubRepository.findUnique({
          where: { id: proposal.repository_binding_id },
          select: {
            id: true, tenantId: true, organizationId: true, projectId: true, installationRecordId: true,
            githubRepositoryId: true, ownerLogin: true, repositoryName: true, status: true,
            installation: { select: { organizationId: true, status: true } }
          }
        }) : null,
        tx.finding.findUnique({
          where: { id: proposal.finding_id },
          select: { id: true, scanId: true, tenantId: true, projectId: true, requirementId: true, ruleId: true,
            ruleVersion: true, signal: true, outcome: true, expected: true, observed: true, reason: true }
        }),
        tx.identityUser.findMany({
          where: { id: { in: [input.identityUserId, proposal.requested_by_identity_user_id, proposal.approved_by_identity_user_id].filter((id): id is string => id !== null) } },
          select: { id: true, status: true }
        })
      ]);
      const statuses = new Map(userRows.map((user) => [user.id, user.status]));
      return {
        proposal: {
          id: proposal.id, tenantId: proposal.tenant_id, organizationId: proposal.organization_id,
          projectId: proposal.project_id, findingId: proposal.finding_id, scanId: proposal.scan_id,
          requesterIdentityUserId: proposal.requested_by_identity_user_id,
          approverIdentityUserId: proposal.approved_by_identity_user_id,
          repositoryBindingId: proposal.repository_binding_id,
          githubRepositoryId: proposal.github_repository_id?.toString() ?? null,
          approvalState: proposal.approval_state, status: proposal.status, planHash: proposal.plan_hash,
          planSnapshot: proposal.plan_snapshot, executionArtifact: proposal.execution_artifact,
          executionArtifactHash: proposal.execution_artifact_hash, approvedArtifactHash: proposal.approved_artifact_hash
        },
        identities: statuses,
        organizationStatus: organization?.status ?? null,
        membership: membership ? {
          role: membership.role, status: membership.status, userStatus: membership.user.status,
          organizationStatus: membership.organization.status
        } : null,
        project,
        scan,
        adoptionStatus: adoption?.status ?? null,
        binding: binding ? {
          id: binding.id, tenantId: binding.tenantId, organizationId: binding.organizationId,
          projectId: binding.projectId, installationRecordId: binding.installationRecordId,
          githubRepositoryId: binding.githubRepositoryId.toString(), ownerLogin: binding.ownerLogin,
          repositoryName: binding.repositoryName, status: binding.status,
          installationOrganizationId: binding.installation.organizationId, installationStatus: binding.installation.status
        } : null,
        finding: finding as PersistedExecutionState["finding"]
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}

/**
 * Read-only execution authorization contract. This is deliberately not wired
 * to the worker. The current policy has no remediation:execute permission, so
 * execution authorization requires the existing owner/admin remediation:approve
 * permission. A future worker integration must use conditional GitHub writes
 * against baseCommitSha to close the unavoidable read/write TOCTOU window.
 */
export class RemediationExecutionAuthorizationService {
  constructor(
    private readonly identities: IdentityResolver,
    private readonly repository: RemediationExecutionAuthorizationRepository,
    private readonly snapshots: TrustedRepositorySnapshotReader,
    private readonly expectedIssuer: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  async authorize(input: AuthorizeRemediationExecutionInput): Promise<RemediationExecutionAuthorizationResult> {
    if (!input.identity || !input.tenantId || !input.remediationId || input.identity.issuer !== this.expectedIssuer || !input.identity.subject)
      return denied("identity_required");
    let user: Awaited<ReturnType<IdentityResolver["resolve"]>>;
    try { user = await this.identities.resolve(input.identity, false); }
    catch { return denied("identity_not_authorized"); }
    if (user.status !== "active") return denied("identity_not_authorized");

    let state: PersistedExecutionState | null;
    try { state = await this.repository.load({ tenantId: input.tenantId, remediationId: input.remediationId, identityUserId: user.id }); }
    catch { return denied("authorization_state_unavailable"); }
    if (!state) return denied("proposal_not_found");
    const { proposal, membership } = state;
    if (proposal.tenantId !== input.tenantId || !proposal.organizationId) return denied("project_scope_invalid");
    if (!membership || membership.status !== "active" || membership.userStatus !== "active" || membership.organizationStatus !== "active" ||
        state.organizationStatus !== "active" || !hasOrganizationPermission(membership.role, "remediation:approve"))
      return denied("execution_permission_denied");
    if (!state.project || state.project.id !== proposal.projectId || state.project.tenantId !== proposal.tenantId ||
        state.project.organizationId !== proposal.organizationId) return denied("project_scope_invalid");
    if (!state.scan || state.scan.id !== proposal.scanId || state.scan.tenantId !== proposal.tenantId ||
        state.scan.projectId !== proposal.projectId) return denied("project_scope_invalid");
    if (state.adoptionStatus !== "approved") return denied("project_not_adopted");
    if (!state.binding || state.binding.status !== "active") return denied("repository_binding_inactive");
    if (state.binding.installationStatus !== "active" || state.binding.installationOrganizationId !== proposal.organizationId)
      return denied("installation_inactive");
    if (state.binding.tenantId !== proposal.tenantId || state.binding.organizationId !== proposal.organizationId ||
        state.binding.projectId !== proposal.projectId || state.binding.id !== proposal.repositoryBindingId ||
        state.binding.githubRepositoryId !== proposal.githubRepositoryId) return denied("repository_binding_inactive");
    if (proposal.approvalState !== "approved" || proposal.status !== "pending_approval" ||
        !proposal.requesterIdentityUserId || !proposal.approverIdentityUserId ||
        state.identities.get(proposal.requesterIdentityUserId) !== "active" ||
        state.identities.get(proposal.approverIdentityUserId) !== "active") return denied("proposal_not_approved");
    if (!proposal.planHash || !verifyPlanSnapshotIntegrity(proposal.planSnapshot, proposal.planHash))
      return denied("proposal_integrity_invalid");
    if (!proposal.executionArtifact || !proposal.executionArtifactHash || proposal.approvedArtifactHash !== proposal.executionArtifactHash ||
        !verifyExecutionArtifact(proposal.executionArtifact, proposal.executionArtifactHash)) return denied("artifact_integrity_invalid");

    const artifact = proposal.executionArtifact as RemediationExecutionArtifact;
    const snapshot = proposal.planSnapshot as Record<string, any>;
    const binding = state.binding;
    if (artifact.proposalId !== proposal.id || artifact.tenantId !== proposal.tenantId ||
        artifact.organizationId !== proposal.organizationId || artifact.projectId !== proposal.projectId ||
        artifact.repositoryBindingId !== binding.id || artifact.githubRepositoryId !== binding.githubRepositoryId ||
        artifact.installationRecordId !== binding.installationRecordId || artifact.planHash !== proposal.planHash ||
        snapshot.projectId !== proposal.projectId || snapshot.repository.bindingId !== binding.id ||
        snapshot.repository.repositoryId !== binding.githubRepositoryId ||
        snapshot.repository.installationRecordId !== binding.installationRecordId ||
        snapshot.repository.owner !== binding.ownerLogin || snapshot.repository.name !== binding.repositoryName ||
        !state.finding || state.finding.tenantId !== proposal.tenantId || state.finding.projectId !== proposal.projectId ||
        state.finding.id !== proposal.findingId || state.finding.scanId !== proposal.scanId ||
        !sameFinding(snapshot.finding, state.finding) || !matchesTrustedPlan(snapshot.patch, state.finding, artifact) ||
        artifact.filePath !== snapshot.patch.filePath ||
        (artifact.operation === "create") !== (artifact.originalContentBase64 === null)) return denied("artifact_context_mismatch");

    let current;
    try {
      current = await this.snapshots.readSnapshot({
        identityUserId: user.id, tenantId: proposal.tenantId, organizationId: proposal.organizationId,
        projectId: proposal.projectId, repositoryBindingId: binding.id, installationRecordId: binding.installationRecordId,
        immutableRepositoryId: binding.githubRepositoryId, filePath: artifact.filePath
      });
    } catch { return denied("repository_state_unavailable"); }
    if (current.immutableRepositoryId !== artifact.githubRepositoryId || current.baseRef !== artifact.baseRef ||
        current.baseCommitSha !== artifact.baseCommitSha || current.filePath !== artifact.filePath || current.file.isRegularFile !== true)
      return denied("repository_state_stale");
    if (artifact.operation === "create") {
      if (current.file.content !== null || current.file.contentBase64 !== null || current.file.blobSha !== null ||
          current.file.mode !== null || current.file.fileType !== null) return denied("repository_state_stale");
    } else if (current.file.content === null || current.file.contentBase64 !== artifact.originalContentBase64 ||
        current.file.blobSha !== artifact.originalBlobSha || current.file.mode !== artifact.originalMode ||
        current.file.fileType !== artifact.originalFileType) return denied("repository_state_stale");

    const authorization: RemediationExecutionAuthorization = Object.freeze({
      proposalId: proposal.id, artifactHash: proposal.executionArtifactHash, identityUserId: user.id,
      tenantId: proposal.tenantId, organizationId: proposal.organizationId, projectId: proposal.projectId,
      repositoryBindingId: binding.id, githubRepositoryId: binding.githubRepositoryId,
      installationRecordId: binding.installationRecordId, baseRef: artifact.baseRef,
      baseCommitSha: artifact.baseCommitSha, filePath: artifact.filePath,
      originalContentBase64: artifact.originalContentBase64, originalContentSha256: artifact.originalContentSha256,
      originalBlobSha: artifact.originalBlobSha, originalMode: artifact.originalMode,
      originalFileType: artifact.originalFileType, renderedContent: artifact.renderedContent,
      renderedContentSha256: artifact.renderedContentSha256, operation: artifact.operation,
      mode: artifact.renderedMode, validatedAt: this.now().toISOString()
    });
    return { kind: "authorized", authorization };
  }
}

function sameFinding(snapshot: unknown, finding: PersistedExecutionState["finding"]): boolean {
  if (!snapshot || typeof snapshot !== "object" || !finding) return false;
  const value = snapshot as Record<string, unknown>;
  return ["id", "scanId", "requirementId", "ruleId", "ruleVersion", "signal", "outcome", "expected", "observed", "reason"]
    .every((key) => typeof value[key] === "string" && value[key] === finding[key as keyof typeof finding]);
}

function matchesTrustedPlan(plan: unknown, finding: FindingSummary, artifact: RemediationExecutionArtifact): boolean {
  if (!plan || typeof plan !== "object") return false;
  try {
    const trusted = planRemediation(finding);
    const stored = plan as Record<string, unknown>;
    return stored.filePath === trusted.filePath && stored.title === trusted.prTitle && stored.body === trusted.prBody &&
      stored.commitMessage === trusted.commitMessage && stored.summary === trusted.summary && artifact.filePath === trusted.filePath;
  } catch { return false; }
}

function denied(reason: ExecutionAuthorizationFailureReason): RemediationExecutionAuthorizationResult {
  return { kind: "denied", reason };
}
