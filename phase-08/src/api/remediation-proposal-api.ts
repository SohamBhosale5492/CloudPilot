import type { AuthenticatedRouteContext, AuthenticatedRouteExtension } from "../../../phase-06/src/api/server.js";
import { hasPermission } from "../../../phase-06/src/rbac/guard.js";
import type { IdentityResolver } from "../identity/identity-resolver.js";
import { IdentityResolutionError } from "../identity/identity-resolver.js";
import type { VerifiedExternalIdentity } from "../identity/external-identity.js";
import { RemediationProposalError, type RemediationProposalStore } from "./remediation-proposal-repo.js";
import type { RemediationExecutionArtifactPreparationService } from "../remediation/execution-artifact-preparation.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function decodePathId(value: string): string | null {
  try { return decodeURIComponent(value); } catch { return null; }
}

export interface RemediationProposalApiOptions {
  expectedIssuer: string;
}

function sendKnownError(context: AuthenticatedRouteContext, error: unknown): boolean {
  if (error instanceof IdentityResolutionError || error instanceof RemediationProposalError) {
    context.sendJson(error.statusCode, { error: error.message });
    return true;
  }
  return false;
}

/** Proposal and approval routes deliberately have no scheduler/GitHub dependency. */
export class RemediationProposalApiRoutes implements AuthenticatedRouteExtension {
  constructor(
    private readonly identities: IdentityResolver,
    private readonly proposals: RemediationProposalStore,
    private readonly options: RemediationProposalApiOptions,
    private readonly artifactPreparation?: RemediationExecutionArtifactPreparationService
  ) {}

  async handle(context: AuthenticatedRouteContext): Promise<boolean> {
    const create = context.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/remediation-proposals$/);
    if (create && context.method === "POST") {
      const projectId = decodePathId(create[1]);
      if (!projectId || !UUID.test(projectId)) {
        context.sendJson(400, { error: "Invalid project ID." });
        return true;
      }
      if (!hasPermission(context.identity, "remediation:create")) {
        context.sendJson(403, { error: "Forbidden: insufficient permissions." });
        return true;
      }
      let body: unknown;
      try { body = await context.parseJsonBody(); }
      catch { context.sendJson(400, { error: "Invalid JSON request body." }); return true; }
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body as Record<string, unknown>).length !== 1 ||
          typeof (body as Record<string, unknown>).findingId !== "string" ||
          !UUID.test((body as Record<string, string>).findingId)) {
        context.sendJson(400, { error: "Request body must contain only a valid findingId." });
        return true;
      }
      try {
        const localUser = await this.resolveIdentity(context);
        const result = await this.proposals.create({
          tenantId: context.identity.tenantId,
          projectId,
          findingId: (body as Record<string, string>).findingId,
          requesterIdentityUserId: localUser.id,
          actorSubject: context.identity.userId
        });
        context.sendJson(result.replayed ? 200 : 202, { proposal: result.proposal, replayed: result.replayed });
      } catch (error) {
        if (!sendKnownError(context, error)) throw error;
      }
      return true;
    }

    const proposal = context.pathname.match(/^\/api\/v1\/remediation-proposals\/([^/]+)(?:\/(approve|reject|prepare-artifact))?$/);
    if (!proposal || !(context.method === "GET" || (context.method === "POST" && proposal[2]))) return false;
    const remediationId = decodePathId(proposal[1]);
    if (!remediationId || !UUID.test(remediationId)) {
      context.sendJson(404, { error: "Remediation proposal not found." });
      return true;
    }
    if (context.method === "GET" && !hasPermission(context.identity, "remediation:read")) {
      context.sendJson(403, { error: "Forbidden: insufficient permissions." });
      return true;
    }

    try {
      if (context.method === "GET") {
        const localUser = await this.resolveIdentity(context);
        const result = await this.proposals.read({
          tenantId: context.identity.tenantId,
          remediationId,
          identityUserId: localUser.id
        });
        context.sendJson(200, { proposal: result });
      } else if (proposal[2] === "prepare-artifact") {
        if (!this.artifactPreparation) {
          context.sendJson(503, { error: "Execution artifact preparation is unavailable." });
          return true;
        }
        if (!hasPermission(context.identity, "remediation:create")) {
          context.sendJson(403, { error: "Forbidden: insufficient permissions." });
          return true;
        }
        let body: unknown;
        try { body = await context.parseJsonBody(); }
        catch { context.sendJson(400, { error: "Invalid JSON request body." }); return true; }
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
          context.sendJson(400, { error: "Artifact preparation does not accept caller-supplied execution data." });
          return true;
        }
        const result = await this.artifactPreparation.prepare({
          tenantId: context.identity.tenantId,
          remediationId,
          identity: { issuer: this.options.expectedIssuer, subject: context.identity.userId }
        });
        context.sendJson(200, { artifactHash: result.artifactHash, replayed: result.replayed });
      } else {
        const localUser = await this.resolveIdentity(context);
        const result = await this.proposals.decide({
          tenantId: context.identity.tenantId,
          remediationId,
          identityUserId: localUser.id,
          decision: proposal[2] as "approve" | "reject"
        });
        if (result.kind === "conflict") {
          context.sendJson(409, { error: result.message, approvalState: result.approvalState });
        } else {
          context.sendJson(200, { remediationId, approvalState: result.approvalState, status: result.status });
        }
      }
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
    // Proposal operations never provision identities implicitly.
    return this.identities.resolve(identity, false);
  }
}
