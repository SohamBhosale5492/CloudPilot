import type { AuthenticatedRouteContext, AuthenticatedRouteExtension } from "../../../phase-06/src/api/server.js";
import { IdentityResolutionError, type IdentityResolver } from "../identity/identity-resolver.js";
import type { VerifiedExternalIdentity } from "../identity/external-identity.js";
import {
  GitHubInstallationCallbackError,
  GitHubInstallationCallbackService,
  parseGitHubInstallationId,
  isValidGitHubConnectState
} from "../github/installation-callback.js";
import { GitHubInstallationVerificationError } from "../github/installation-verifier.js";

export interface GitHubInstallationCallbackRouteOptions {
  expectedIssuer: string;
  allowFirstUseProvisioning: boolean;
}

export class GitHubInstallationCallbackApiRoutes implements AuthenticatedRouteExtension {
  constructor(
    private readonly identities: IdentityResolver,
    private readonly callback: GitHubInstallationCallbackService,
    private readonly options: GitHubInstallationCallbackRouteOptions
  ) {}

  async handle(context: AuthenticatedRouteContext): Promise<boolean> {
    if (context.pathname !== "/api/v1/github/installations/callback" || context.method !== "POST") return false;

    let body: unknown;
    try { body = await context.parseJsonBody(); }
    catch { context.sendJson(400, { error: "Invalid JSON request body." }); return true; }
    if (!isRecord(body) || Object.keys(body).sort().join(",") !== "installationId,setupAction,state" ||
        typeof body.installationId !== "string" || !parseGitHubInstallationId(body.installationId) ||
        !isValidGitHubConnectState(body.state) || (body.setupAction !== "install" && body.setupAction !== "update")) {
      context.sendJson(400, { error: "Callback requires installationId, state, and setupAction 'install' or 'update'." });
      return true;
    }

    try {
      const principal: VerifiedExternalIdentity = {
        issuer: this.options.expectedIssuer,
        subject: context.identity.userId
      };
      const identity = await this.identities.resolve(principal, this.options.allowFirstUseProvisioning);
      const result = await this.callback.complete({
        identityUserId: identity.id,
        installationId: body.installationId,
        state: body.state
      });
      context.sendJson(result.alreadyConnected ? 200 : 201, result);
      return true;
    } catch (error) {
      if (error instanceof IdentityResolutionError) {
        context.sendJson(error.statusCode, { error: error.message });
        return true;
      }
      if (error instanceof GitHubInstallationCallbackError) {
        const statusCode = error.code === "intent_expired_or_consumed" || error.code === "installation_conflict" ? 409
          : error.code === "initiator_mismatch" ? 403
            : error.code === "organization_forbidden" ? 404 : 400;
        context.sendJson(statusCode, { error: error.message });
        return true;
      }
      if (error instanceof GitHubInstallationVerificationError) {
        const statusCode = error.code === "installation_suspended" || error.code === "insufficient_permissions" ? 422
          : error.code === "github_not_found" ? 404
            : error.code === "github_unauthorized" || error.code === "github_forbidden" ? 502 : 503;
        context.sendJson(statusCode, { error: error.message });
        return true;
      }
      // Database errors are intentionally generic. No callback state, JWT,
      // credential material, or upstream response detail is returned or logged.
      context.sendJson(503, { error: "GitHub installation could not be saved. Retry the callback or start a new installation request." });
      return true;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
