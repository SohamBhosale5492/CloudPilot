import type { AuthenticatedRouteContext, AuthenticatedRouteExtension } from "../../../phase-06/src/api/server.js";
import { IdentityResolutionError, type IdentityResolver } from "../identity/identity-resolver.js";
import type { VerifiedExternalIdentity } from "../identity/external-identity.js";
import { PrismaOrganizationAuthorizationService } from "../organizations/authorization-service.js";
import { GitHubConnectIntentError, GitHubConnectIntentService } from "../github/connect-intent.js";

export interface GitHubConnectIntentRouteOptions {
  expectedIssuer: string;
  allowFirstUseProvisioning: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Authenticated organization-scoped initiation only; no callback handling lives here. */
export class GitHubConnectIntentApiRoutes implements AuthenticatedRouteExtension {
  constructor(
    private readonly identities: IdentityResolver,
    private readonly authorization: PrismaOrganizationAuthorizationService,
    private readonly intents: GitHubConnectIntentService,
    private readonly options: GitHubConnectIntentRouteOptions
  ) {}

  async handle(context: AuthenticatedRouteContext): Promise<boolean> {
    const match = context.pathname.match(/^\/api\/v1\/organizations\/([^/]+)\/github\/installations\/start$/);
    if (!match || context.method !== "POST") return false;

    let organizationId: string;
    try { organizationId = decodeURIComponent(match[1]); }
    catch { context.sendJson(400, { error: "Invalid organization ID." }); return true; }
    if (!UUID.test(organizationId)) {
      context.sendJson(400, { error: "Invalid organization ID." });
      return true;
    }

    try {
      let body: unknown;
      try { body = await context.parseJsonBody(); }
      catch { context.sendJson(400, { error: "Invalid JSON request body." }); return true; }
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
        context.sendJson(400, { error: "This endpoint does not accept client-supplied state or redirect values." });
        return true;
      }

      const principal: VerifiedExternalIdentity = {
        issuer: this.options.expectedIssuer,
        subject: context.identity.userId
      };
      const identity = await this.identities.resolve(principal, this.options.allowFirstUseProvisioning);
      const authorized = await this.authorization.authorize(identity.id, organizationId, "organization:integrations:manage");
      if (!authorized) {
        // Hide whether an organization exists when the caller lacks an active
        // membership or the owner/admin integration-management permission.
        context.sendJson(404, { error: "Organization not found." });
        return true;
      }

      const result = await this.intents.create({ organizationId, identityUserId: identity.id });
      context.sendJson(201, result);
      return true;
    } catch (error) {
      if (error instanceof IdentityResolutionError) {
        context.sendJson(error.statusCode, { error: error.message });
        return true;
      }
      if (error instanceof GitHubConnectIntentError) {
        context.sendJson(503, { error: error.message });
        return true;
      }
      // Do not echo database/provider errors; in particular, never return a
      // state or URL when persistence or its audit transaction failed.
      context.sendJson(503, { error: "Unable to create a GitHub installation request. Verify database availability and backend GitHub App configuration." });
      return true;
    }
  }
}
