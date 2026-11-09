import { createHash } from "node:crypto";
import { PrismaClient, Prisma } from "@prisma/client";
import type { AuthenticatedRouteContext, AuthenticatedRouteExtension } from "../../../phase-06/src/api/server.js";
import { IdentityResolutionError } from "../identity/identity-resolver.js";
import type { IdentityResolver } from "../identity/identity-resolver.js";
import type { VerifiedExternalIdentity } from "../identity/external-identity.js";
import { hasOrganizationPermission } from "../organizations/permissions.js";
import { RemediationExecutionPersistenceService, RemediationExecutionPersistenceError } from "../remediation/remediation-execution-persistence.js";
import type { ReconciliationLease } from "../remediation/remediation-execution-persistence.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function decodePathId(value: string): string | null {
  try { return decodeURIComponent(value); } catch { return null; }
}

function sendKnownError(context: AuthenticatedRouteContext, error: unknown): boolean {
  if (error instanceof IdentityResolutionError) {
    context.sendJson(error.statusCode, { error: error.message });
    return true;
  }
  if (error instanceof RemediationExecutionPersistenceError) {
    const statusCode =
      error.code === "reconciliation_not_authorized" || error.code === "claim_not_authorized" ? 403 :
      error.code === "invalid_input" ? 400 :
      error.code === "invalid_transition" || error.code === "execution_conflict" || error.code === "intent_conflict" ? 409 : 500;
    context.sendJson(statusCode, { error: error.code });
    return true;
  }
  return false;
}

export interface ReconciliationApiOptions {
  expectedIssuer: string;
}

/**
 * HTTP routes for human reconciliation of manual-review executions.
 *
 * All routes require:
 *   - Valid JWT (enforced by the upstream CloudPilotApiServer middleware)
 *   - Resolved IdentityUser
 *   - Active organization membership with role owner|admin AND remediation:approve permission
 *   - Valid reconciliation lease for mutating operations
 *
 * Routes:
 *   GET  /api/v1/remediation-executions/:executionId
 *     → Returns execution status and reconciliation state for a manual-review execution.
 *
 *   POST /api/v1/remediation-executions/:executionId/reconciliation/claim
 *     → Acquires a human reconciliation lease. Returns { lease: { executionId, leaseToken, expiresAt } }.
 *
 *   POST /api/v1/remediation-executions/:executionId/reconciliation/resolve
 *     → Resolves reconciliation. Body: { leaseToken, outcome: "failed"|"manual_review_required", code?: string }.
 *       Successful completion is reserved for the trusted execution workflow, which supplies runtime-verified evidence.
 */
export class RemediationReconciliationApiRoutes implements AuthenticatedRouteExtension {
  constructor(
    private readonly identities: IdentityResolver,
    private readonly persistence: RemediationExecutionPersistenceService,
    private readonly prisma: PrismaClient,
    private readonly options: ReconciliationApiOptions
  ) {}

  async handle(context: AuthenticatedRouteContext): Promise<boolean> {
    // GET /api/v1/remediation-executions/:executionId
    const inspectMatch = context.pathname.match(/^\/api\/v1\/remediation-executions\/([^/]+)$/);
    if (inspectMatch && context.method === "GET") {
      return this.handleInspect(context, inspectMatch[1]!);
    }

    // POST /api/v1/remediation-executions/:executionId/reconciliation/claim
    const claimMatch = context.pathname.match(/^\/api\/v1\/remediation-executions\/([^/]+)\/reconciliation\/claim$/);
    if (claimMatch && context.method === "POST") {
      return this.handleClaim(context, claimMatch[1]!);
    }

    // POST /api/v1/remediation-executions/:executionId/reconciliation/resolve
    const resolveMatch = context.pathname.match(/^\/api\/v1\/remediation-executions\/([^/]+)\/reconciliation\/resolve$/);
    if (resolveMatch && context.method === "POST") {
      return this.handleResolve(context, resolveMatch[1]!);
    }

    return false;
  }

  private async handleInspect(context: AuthenticatedRouteContext, rawId: string): Promise<boolean> {
    const executionId = decodePathId(rawId);
    if (!executionId || !UUID_RE.test(executionId)) {
      context.sendJson(404, { error: "Remediation execution not found." });
      return true;
    }
    try {
      const actor = await this.resolveIdentity(context);
      const row = await this.loadExecutionForActor(executionId, actor.id);
      if (!row) {
        context.sendJson(404, { error: "Remediation execution not found or insufficient permissions." });
        return true;
      }
      context.sendJson(200, { execution: row });
    } catch (error) {
      if (!sendKnownError(context, error)) throw error;
    }
    return true;
  }

  private async handleClaim(context: AuthenticatedRouteContext, rawId: string): Promise<boolean> {
    const executionId = decodePathId(rawId);
    if (!executionId || !UUID_RE.test(executionId)) {
      context.sendJson(404, { error: "Remediation execution not found." });
      return true;
    }
    try {
      const actor = await this.resolveIdentity(context);
      // Re-validate active org membership and remediation:approve on every claim.
      const membershipOk = await this.validateActorPermissionForExecution(executionId, actor.id);
      if (!membershipOk) {
        context.sendJson(403, { error: "Forbidden: active owner or admin membership with remediation:approve is required." });
        return true;
      }
      const lease = await this.persistence.beginReconciliation({ executionId, actorIdentityUserId: actor.id });
      if (!lease) {
        context.sendJson(409, { error: "Cannot claim reconciliation lease: execution is not in manual_review_required state, or another reconciliation is active." });
        return true;
      }
      context.sendJson(200, {
        lease: {
          executionId: lease.executionId,
          organizationId: lease.organizationId,
          leaseToken: lease.leaseToken,
          expiresAt: lease.expiresAt
        }
      });
    } catch (error) {
      if (!sendKnownError(context, error)) throw error;
    }
    return true;
  }

  private async handleResolve(context: AuthenticatedRouteContext, rawId: string): Promise<boolean> {
    const executionId = decodePathId(rawId);
    if (!executionId || !UUID_RE.test(executionId)) {
      context.sendJson(404, { error: "Remediation execution not found." });
      return true;
    }
    let body: unknown;
    try { body = await context.parseJsonBody(); }
    catch { context.sendJson(400, { error: "Invalid JSON request body." }); return true; }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      context.sendJson(400, { error: "Request body must be a JSON object." });
      return true;
    }
    const b = body as Record<string, unknown>;
    const leaseToken = typeof b.leaseToken === "string" ? b.leaseToken : null;
    const outcome = b.outcome as string | undefined;
    const code = typeof b.code === "string" ? b.code : undefined;
    if (!leaseToken || !UUID_RE.test(leaseToken)) {
      context.sendJson(400, { error: "leaseToken must be a valid UUID." });
      return true;
    }
    if (outcome !== "failed" && outcome !== "manual_review_required") {
      context.sendJson(400, { error: "outcome must be one of: failed, manual_review_required." });
      return true;
    }
    try {
      const actor = await this.resolveIdentity(context);
      // Re-validate authorization on every resolve operation.
      const membershipOk = await this.validateActorPermissionForExecution(executionId, actor.id);
      if (!membershipOk) {
        context.sendJson(403, { error: "Forbidden: active owner or admin membership with remediation:approve is required." });
        return true;
      }
      // Build the ReconciliationLease from the token; organizationId comes from the execution.
      const orgId = await this.getExecutionOrganizationId(executionId);
      if (!orgId) {
        context.sendJson(404, { error: "Remediation execution not found." });
        return true;
      }
      const lease: ReconciliationLease = {
        executionId,
        organizationId: orgId,
        actorIdentityUserId: actor.id,
        leaseToken,
        expiresAt: "" // expiresAt is not used by resolveReconciliation; it validates via DB
      };
      const resolved = await this.persistence.resolveReconciliation({
        lease,
        outcome: outcome as "failed" | "manual_review_required",
        ...(code !== undefined ? { code } : {})
      });
      if (!resolved) {
        context.sendJson(409, { error: "Cannot resolve: lease expired, unauthorized, or execution not in reconciliation_in_progress state." });
        return true;
      }
      context.sendJson(200, { executionId, outcome });
    } catch (error) {
      if (!sendKnownError(context, error)) throw error;
    }
    return true;
  }

  private resolveIdentity(context: AuthenticatedRouteContext) {
    const identity: VerifiedExternalIdentity = {
      issuer: this.options.expectedIssuer,
      subject: context.identity.userId
    };
    return this.identities.resolve(identity, false);
  }

  /** Returns the execution row for a manual-review execution the actor has permission to inspect. */
  private async loadExecutionForActor(executionId: string, actorId: string) {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string; tenantId: string; organizationId: string; projectId: string; remediationId: string;
      status: string; stage: string | null; attemptNumber: number; reconciliationStatus: string;
      reconciliationOutcome: string | null; failureStage: string | null; failureCode: string | null;
      commitSha: string | null; branchName: string | null; pullRequestNumber: number | null;
      pullRequestUrl: string | null; manualReviewAt: string | null; createdAt: string; updatedAt: string;
      actorRole: string;
    }>>`
      SELECT e.id, e.tenant_id AS "tenantId", e.organization_id AS "organizationId", e.project_id AS "projectId",
        e.remediation_id AS "remediationId", e.status, e.stage, e.attempt_number AS "attemptNumber",
        e.reconciliation_status AS "reconciliationStatus", e.reconciliation_outcome AS "reconciliationOutcome",
        e.failure_stage AS "failureStage", e.failure_code AS "failureCode",
        e.commit_sha AS "commitSha", e.branch_name AS "branchName",
        e.pull_request_number AS "pullRequestNumber", e.pull_request_url AS "pullRequestUrl",
        e.manual_review_at AS "manualReviewAt", e.created_at AS "createdAt", e.updated_at AS "updatedAt",
        m.role AS "actorRole"
      FROM remediation_executions e
      JOIN organizations o ON o.id = e.organization_id AND o.status = 'active'
      JOIN organization_members m ON m.organization_id = e.organization_id
        AND m.user_id = ${actorId}::uuid AND m.status = 'active'
      JOIN identity_users u ON u.id = m.user_id AND u.status = 'active'
      WHERE e.id = ${executionId}::uuid
        AND e.status IN ('manual_review_required', 'reconciliation_in_progress', 'reconciliation_resolved')
    `;
    const row = rows[0];
    if (!row || !hasOrganizationPermission(row.actorRole, "remediation:approve")) return null;
    const { actorRole: _, ...rest } = row;
    return rest;
  }

  /** Validates that the actor is an active owner/admin with remediation:approve for the execution's org. */
  private async validateActorPermissionForExecution(executionId: string, actorId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ role: string }>>`
      SELECT m.role FROM remediation_executions e
      JOIN organizations o ON o.id = e.organization_id AND o.status = 'active'
      JOIN organization_members m ON m.organization_id = e.organization_id
        AND m.user_id = ${actorId}::uuid AND m.status = 'active'
      JOIN identity_users u ON u.id = m.user_id AND u.status = 'active'
      WHERE e.id = ${executionId}::uuid
        AND e.status IN ('manual_review_required', 'reconciliation_in_progress')
        AND m.role IN ('owner', 'admin')
    `;
    const row = rows[0];
    return !!row && hasOrganizationPermission(row.role, "remediation:approve");
  }

  /** Returns the organization_id for an execution (needed to construct ReconciliationLease). */
  private async getExecutionOrganizationId(executionId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<Array<{ organizationId: string }>>`
      SELECT organization_id AS "organizationId" FROM remediation_executions WHERE id = ${executionId}::uuid
    `;
    return rows[0]?.organizationId ?? null;
  }
}
