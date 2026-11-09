import type { IdentityUser } from "@prisma/client";
import { createHash } from "node:crypto";
import type { AuthenticatedRouteContext, AuthenticatedRouteExtension } from "../../../phase-06/src/api/server.js";
import { VerifiedExternalIdentity } from "../identity/external-identity.js";
import { IdentityResolutionError, IdentityResolver } from "../identity/identity-resolver.js";
import {
  normalizeOrganizationName,
  OrganizationCursor,
  OrganizationServiceError,
  PrismaOrganizationService,
  validateOrganizationIdempotencyKey
} from "../organizations/organization-service.js";

export interface OrganizationApiService {
  getProfile(userId: string): Promise<IdentityUser | null>;
  create(input: { creatorUserId: string; idempotencyKey: string; displayName: string }, perUserLimit: number): ReturnType<PrismaOrganizationService["create"]>;
  listForUser(userId: string, limit: number, cursor?: OrganizationCursor): ReturnType<PrismaOrganizationService["listForUser"]>;
}

export interface IdentityOrganizationApiOptions {
  expectedIssuer: string;
  allowFirstUseProvisioning: boolean;
  organizationCreationEnabled: boolean;
  perUserOrganizationLimit: number;
}

interface RateWindow { startedAt: number; count: number }

/** Process-local best-effort throttle; the database-backed lifetime limit is authoritative. */
export class OrganizationCreateRateLimiter {
  private readonly windows = new Map<string, RateWindow>();
  constructor(private readonly maxRequests = 10, private readonly windowMs = 60_000, private readonly maxKeys = 10_000) {}

  allow(userId: string, now = Date.now()): boolean {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) this.windows.delete(key);
    }
    let current = this.windows.get(userId);
    if (!current) {
      if (this.windows.size >= this.maxKeys) return false;
      current = { startedAt: now, count: 0 };
      this.windows.set(userId, current);
    }
    if (now - current.startedAt >= this.windowMs) {
      current.startedAt = now;
      current.count = 0;
    }
    if (current.count >= this.maxRequests) return false;
    current.count++;
    return true;
  }
}

function encodeCursor(cursor: OrganizationCursor): string {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }), "utf8").toString("base64url");
}

function decodeCursor(value: string): OrganizationCursor | null {
  if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (!parsed || typeof parsed.createdAt !== "string" || typeof parsed.id !== "string" || parsed.id.length > 64) return null;
    const createdAt = new Date(parsed.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== parsed.createdAt) return null;
    return { createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

function pageOptions(context: AuthenticatedRouteContext): { limit: number; cursor?: OrganizationCursor } | null {
  const limits = context.url.searchParams.getAll("limit");
  const cursors = context.url.searchParams.getAll("cursor");
  if (limits.length > 1 || cursors.length > 1) return null;
  let limit = 20;
  if (limits.length) {
    if (!/^(?:[1-9]\d*)$/.test(limits[0])) return null;
    limit = Number(limits[0]);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return null;
  }
  if (!cursors.length) return { limit };
  const cursor = decodeCursor(cursors[0]);
  return cursor ? { limit, cursor } : null;
}

function sendError(context: AuthenticatedRouteContext, error: unknown): void {
  if (error instanceof IdentityResolutionError || error instanceof OrganizationServiceError) {
    context.sendJson(error.statusCode, { error: error.message });
    return;
  }
  throw error;
}

/** New SaaS routes use a local identity and membership model, never JWT role claims. */
export class IdentityOrganizationApiRoutes implements AuthenticatedRouteExtension {
  constructor(
    private readonly identities: IdentityResolver,
    private readonly organizations: OrganizationApiService,
    private readonly options: IdentityOrganizationApiOptions,
    private readonly rateLimiter = new OrganizationCreateRateLimiter()
  ) {}

  async handle(context: AuthenticatedRouteContext): Promise<boolean> {
    if (context.method === "GET" && context.pathname === "/api/v1/me") {
      await this.getMe(context);
      return true;
    }
    if (context.method === "GET" && context.pathname === "/api/v1/organizations") {
      await this.listOrganizations(context);
      return true;
    }
    if (context.method === "POST" && context.pathname === "/api/v1/organizations") {
      await this.createOrganization(context);
      return true;
    }
    return false;
  }

  private principal(context: AuthenticatedRouteContext): VerifiedExternalIdentity {
    // CloudPilotApiServer only calls extensions after JWT verification. userId is
    // the verifier's mapped sub; expectedIssuer is the exact validated issuer.
    return { issuer: this.options.expectedIssuer, subject: context.identity.userId };
  }

  private resolveUser(context: AuthenticatedRouteContext): Promise<IdentityUser> {
    return this.identities.resolve(this.principal(context), this.options.allowFirstUseProvisioning);
  }

  private async getMe(context: AuthenticatedRouteContext): Promise<void> {
    try {
      const user = await this.resolveUser(context);
      context.sendJson(200, {
        user: {
          id: user.id,
          displayName: user.displayName,
          email: user.emailVerifiedAt ? user.email : null,
          status: user.status,
          createdAt: user.createdAt
        }
      });
    } catch (error) { sendError(context, error); }
  }

  private async listOrganizations(context: AuthenticatedRouteContext): Promise<void> {
    const options = pageOptions(context);
    if (!options) {
      context.sendJson(400, { error: "Invalid limit or cursor." });
      return;
    }
    try {
      const user = await this.resolveUser(context);
      const page = await this.organizations.listForUser(user.id, options.limit, options.cursor);
      context.sendJson(200, {
        items: page.items,
        nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
        hasMore: page.hasMore
      });
    } catch (error) { sendError(context, error); }
  }

  private async createOrganization(context: AuthenticatedRouteContext): Promise<void> {
    if (!this.options.organizationCreationEnabled) {
      context.sendJson(403, { error: "Organization creation is disabled." });
      return;
    }
    let body: unknown;
    try { body = await context.parseJsonBody(); }
    catch {
      context.sendJson(400, { error: "Invalid JSON request body." });
      return;
    }
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "displayName")) {
      context.sendJson(400, { error: "Request body must contain only displayName." });
      return;
    }

    let displayName: string;
    let idempotencyKey: string;
    try {
      displayName = normalizeOrganizationName((body as Record<string, unknown>).displayName);
      idempotencyKey = validateOrganizationIdempotencyKey(context.req.headers["idempotency-key"]);
    } catch (error) {
      sendError(context, error);
      return;
    }

    try {
      const principal = this.principal(context);
      const throttleKey = createHash("sha256").update(`${principal.issuer}\0${principal.subject}`).digest("hex");
      if (!this.rateLimiter.allow(throttleKey)) {
        context.sendJson(429, { error: "Organization creation rate limit exceeded." });
        return;
      }
      const user = await this.identities.resolve(principal, this.options.allowFirstUseProvisioning);
      const result = await this.organizations.create({ creatorUserId: user.id, idempotencyKey, displayName }, this.options.perUserOrganizationLimit);
      context.sendJson(result.replayed ? 200 : 201, {
        organization: {
          id: result.organization.id,
          displayName: result.organization.displayName,
          status: result.organization.status,
          createdAt: result.organization.createdAt
        },
        membership: { role: result.membership.role, status: result.membership.status }
      });
    } catch (error) { sendError(context, error); }
  }
}
