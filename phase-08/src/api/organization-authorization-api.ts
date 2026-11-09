import type { AuthenticatedRouteContext, AuthenticatedRouteExtension } from "../../../phase-06/src/api/server.js";
import type { IdentityResolver } from "../identity/identity-resolver.js";
import type { VerifiedExternalIdentity } from "../identity/external-identity.js";
import { PrismaOrganizationAuthorizationService } from "../organizations/authorization-service.js";
import { ProjectAdoptionError, PrismaProjectAdoptionService } from "../organizations/project-adoption-service.js";

export interface OrganizationAuthorizationRoutesOptions {
  expectedIssuer: string;
  allowFirstUseProvisioning: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sendKnownError(context: AuthenticatedRouteContext, error: unknown): boolean {
  if (error instanceof ProjectAdoptionError) {
    context.sendJson(error.statusCode, { error: error.message });
    return true;
  }
  return false;
}

/** Organization APIs resolve local identity by exact verified issuer and subject. */
export class OrganizationAuthorizationApiRoutes implements AuthenticatedRouteExtension {
  constructor(
    private readonly identities: IdentityResolver,
    private readonly authorization: PrismaOrganizationAuthorizationService,
    private readonly adoptions: PrismaProjectAdoptionService,
    private readonly options: OrganizationAuthorizationRoutesOptions
  ) {}

  async handle(context: AuthenticatedRouteContext): Promise<boolean> {
    const statusMatch = context.pathname.match(/^\/api\/v1\/organizations\/([^/]+)\/integrations\/status$/);
    const requestMatch = context.pathname.match(/^\/api\/v1\/organizations\/([^/]+)\/project-adoptions$/);
    const decisionMatch = context.pathname.match(/^\/api\/v1\/organizations\/([^/]+)\/project-adoptions\/([^/]+)\/(approve|reject)$/);
    if (!statusMatch && !requestMatch && !decisionMatch) return false;
    const organizationId = this.decodeId((statusMatch ?? requestMatch ?? decisionMatch)![1]);
    if (!organizationId || !UUID.test(organizationId)) {
      context.sendJson(400, { error: "Invalid organization ID." });
      return true;
    }
    try {
      const identity = await this.resolveIdentity(context);
      if (statusMatch && context.method === "GET") {
        const authorized = await this.authorization.authorize(identity.id, organizationId, "organization:integrations");
        if (!authorized) {
          context.sendJson(404, { error: "Organization not found." });
          return true;
        }
        // The current schema has no installation/binding table. Report this as
        // unavailable rather than deriving connection state from repositoryUrl.
        context.sendJson(200, { organizationId, githubApp: { available: false, status: "not_configured" } });
        return true;
      }

      if (requestMatch && context.method === "POST") {
        const body = await this.readBody(context);
        if (body === null) return true;
        if (Object.keys(body).length !== 1 || typeof body.projectId !== "string" || !UUID.test(body.projectId)) {
          context.sendJson(400, { error: "Request body must contain a valid projectId." });
          return true;
        }
        const idempotencyKey = context.req.headers["idempotency-key"];
        if (typeof idempotencyKey !== "string") {
          context.sendJson(400, { error: "A valid Idempotency-Key header is required." });
          return true;
        }
        const result = await this.adoptions.request({
          tenantId: context.identity.tenantId,
          organizationId,
          projectId: body.projectId,
          identityUserId: identity.id,
          idempotencyKey
        });
        const adoption = result.adoption as { id: string; status: string; createdAt: Date };
        context.sendJson(result.replayed ? 200 : 202, {
          adoption: { id: adoption.id, status: adoption.status, projectId: body.projectId },
          replayed: result.replayed
        });
        return true;
      }

      if (decisionMatch && context.method === "POST") {
        const adoptionId = this.decodeId(decisionMatch[2]);
        if (!adoptionId || !UUID.test(adoptionId)) {
          context.sendJson(400, { error: "Invalid project adoption ID." });
          return true;
        }
        const body = await this.readBody(context);
        if (body === null) return true;
        if (Object.keys(body).length !== 1 || typeof body.projectId !== "string" || !UUID.test(body.projectId)) {
          context.sendJson(400, { error: "Request body must contain a valid projectId." });
          return true;
        }
        const result = await this.adoptions.decide({
          tenantId: context.identity.tenantId,
          organizationId,
          projectId: body.projectId,
          identityUserId: identity.id,
          idempotencyKey: "decision",
          adoptionId,
          decision: decisionMatch[3] as "approve" | "reject"
        });
        context.sendJson(200, { adoption: result });
        return true;
      }

      context.sendJson(404, { error: "Route not found." });
      return true;
    } catch (error) {
      if (sendKnownError(context, error)) return true;
      throw error;
    }
  }

  private async resolveIdentity(context: AuthenticatedRouteContext) {
    const principal: VerifiedExternalIdentity = {
      issuer: this.options.expectedIssuer,
      subject: context.identity.userId
    };
    return this.identities.resolve(principal, this.options.allowFirstUseProvisioning);
  }

  private async readBody(context: AuthenticatedRouteContext): Promise<Record<string, unknown> | null> {
    let value: unknown;
    try { value = await context.parseJsonBody(); }
    catch { context.sendJson(400, { error: "Invalid JSON request body." }); return null; }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      context.sendJson(400, { error: "Request body must be a JSON object." });
      return null;
    }
    return value as Record<string, unknown>;
  }

  private decodeId(value: string): string | null {
    try {
      const decoded = decodeURIComponent(value);
      return decoded.length > 0 && decoded.length <= 64 && !decoded.includes("/") ? decoded : null;
    } catch { return null; }
  }
}
