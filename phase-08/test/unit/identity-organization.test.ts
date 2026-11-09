import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, type IdentityUser, type Organization, type OrganizationMember } from "@prisma/client";
import type { AuthenticatedRouteContext } from "../../../phase-06/src/api/server.js";
import {
  IdentityOrganizationApiRoutes,
  OrganizationApiService,
  OrganizationCreateRateLimiter
} from "../../src/api/identity-organization-api.js";
import { IdentityResolutionError, IdentityResolver, PrismaIdentityResolver } from "../../src/identity/identity-resolver.js";
import {
  normalizeOrganizationName,
  organizationRequestHash,
  OrganizationServiceError,
  validateOrganizationIdempotencyKey
} from "../../src/organizations/organization-service.js";
import { hasOrganizationPermission } from "../../src/organizations/permissions.js";

const issuer = "https://login.microsoftonline.com/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/v2.0";
const user = {
  id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", status: "active", displayName: null, email: null,
  emailVerifiedAt: null, createdAt: new Date("2026-11-01T00:00:00Z"), updatedAt: new Date("2026-11-01T00:00:00Z"),
  lastAuthenticatedAt: new Date("2026-11-01T00:00:00Z")
} as IdentityUser;

function identityResolverFixture(options: { userCreateError?: Error } = {}) {
  const users = new Map<string, IdentityUser>();
  const external = new Map<string, { id: string; issuer: string; subject: string; userId: string }>();
  const keyOf = (issuerValue: string, subjectValue: string) => `${issuerValue}\0${subjectValue}`;
  const tx = {
    identityUser: {
      async create({ data }: { data: Partial<IdentityUser> }) {
        if (options.userCreateError) throw options.userCreateError;
        const value = { ...user, ...data, id: randomUUID() } as IdentityUser;
        users.set(value.id, value);
        return value;
      },
      async update({ where, data }: { where: { id: string }; data: Partial<IdentityUser> }) {
        const value = { ...users.get(where.id)!, ...data } as IdentityUser;
        users.set(where.id, value);
        return value;
      }
    },
    externalIdentity: {
      async findUnique({ where }: { where: { issuer_subject: { issuer: string; subject: string } } }) {
        const found = external.get(keyOf(where.issuer_subject.issuer, where.issuer_subject.subject));
        return found ? { ...found, user: users.get(found.userId) } : null;
      },
      async create({ data }: { data: { issuer: string; subject: string; userId: string; lastAuthenticatedAt?: Date } }) {
        const key = keyOf(data.issuer, data.subject);
        if (external.has(key)) throw new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002", clientVersion: "5.22.0", meta: { target: ["issuer", "subject"] }
        });
        const value = { ...data, id: randomUUID() };
        external.set(key, value);
        return value;
      },
      async update({ where, data }: { where: { id: string }; data: { lastAuthenticatedAt: Date } }) {
        const found = [...external.values()].find((row) => row.id === where.id)!;
        Object.assign(found, data);
        return found;
      }
    }
  };
  const prisma = {
    ...tx,
    async $transaction<T>(callback: (transaction: typeof tx) => Promise<T>): Promise<T> { return callback(tx); }
  };
  return { resolver: new PrismaIdentityResolver(prisma as never), users, external };
}

function request(method: string, path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  const url = new URL(path, "http://localhost");
  const response: { status?: number; data?: unknown } = {};
  const context = {
    req: { headers } as unknown as AuthenticatedRouteContext["req"],
    res: {} as AuthenticatedRouteContext["res"],
    method,
    pathname: url.pathname,
    url,
    identity: { userId: "entra-subject", tenantId: "legacy-tid", roles: ["viewer"] },
    parseJsonBody: async () => body,
    sendJson: (statusCode: number, data: unknown) => { response.status = statusCode; response.data = data; }
  } satisfies AuthenticatedRouteContext;
  return { context, response };
}

function api(options: Partial<ConstructorParameters<typeof IdentityOrganizationApiRoutes>[2]> = {}) {
  const resolutions: Array<{ issuer: string; subject: string; allow: boolean }> = [];
  const identities: IdentityResolver = {
    async resolve(identity, allowProvisioning) {
      resolutions.push({ ...identity, allow: allowProvisioning });
      if (identity.subject === "unknown") throw new IdentityResolutionError(403, "This identity is not provisioned for CloudPilot.");
      return user;
    }
  };
  const orgCalls: unknown[] = [];
  const organizations: OrganizationApiService = {
    async getProfile() { return user; },
    async create(input) {
      orgCalls.push(input);
      const org = {
        id: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb", displayName: input.displayName, status: "active",
        createdByUserId: input.creatorUserId, creationIdempotencyKey: input.idempotencyKey,
        creationRequestHash: organizationRequestHash(input.displayName),
        createdAt: new Date("2026-11-01T01:00:00Z"), updatedAt: new Date("2026-11-01T01:00:00Z")
      } as unknown as Organization;
      return {
        organization: org,
        membership: { organizationId: org.id, userId: input.creatorUserId, role: "owner", status: "active" } as unknown as OrganizationMember,
        replayed: input.idempotencyKey === "replay"
      };
    },
    async listForUser(_userId, limit, cursor) {
      orgCalls.push({ limit, cursor });
      return { items: [], hasMore: false };
    }
  };
  const routes = new IdentityOrganizationApiRoutes(identities, organizations, {
    expectedIssuer: issuer,
    allowFirstUseProvisioning: false,
    organizationCreationEnabled: true,
    perUserOrganizationLimit: 5,
    ...options
  });
  return { routes, resolutions, orgCalls };
}

test("verified Entra subject resolves by configured issuer and does not use token role or tenant as organization context", async () => {
  const { routes, resolutions } = api();
  const req = request("GET", "/api/v1/me");
  await routes.handle(req.context);
  assert.equal(req.response.status, 200);
  assert.deepEqual(resolutions[0], { issuer, subject: "entra-subject", allow: false });
  assert.equal((req.response.data as { user: { id: string } }).user.id, user.id);
});

test("unknown identity is rejected when first-use provisioning is disabled", async () => {
  const { routes } = api();
  const req = request("GET", "/api/v1/me");
  req.context.identity.userId = "unknown";
  await routes.handle(req.context);
  assert.equal(req.response.status, 403);
});

test("Prisma resolver provisions exact issuer/subject once and does not accept email as an identity key", async () => {
  const { resolver, users, external } = identityResolverFixture();
  const identity = { issuer, subject: "opaque-subject" };
  const first = await resolver.resolve(identity, true);
  const second = await resolver.resolve(identity, false);
  assert.equal(first.id, second.id);
  assert.equal(users.size, 1);
  assert.equal(external.size, 1);
  const otherSubject = await resolver.resolve({ issuer, subject: "different-subject" }, true);
  assert.notEqual(first.id, otherSubject.id);
  assert.equal(users.size, 2);
});

test("unrelated Prisma unique violations are not treated as external-identity races", async () => {
  const unrelated = new Prisma.PrismaClientKnownRequestError("duplicate email", {
    code: "P2002", clientVersion: "5.22.0", meta: { target: ["email"] }
  });
  const { resolver } = identityResolverFixture({ userCreateError: unrelated });
  await assert.rejects(resolver.resolve({ issuer, subject: "new-subject" }, true), (error) => error === unrelated);
});

test("organization display names normalize NFC and trim while preserving inner spaces", () => {
  assert.equal(normalizeOrganizationName("  Cafe\u0301  Platform  "), "Café  Platform");
  assert.equal(
    organizationRequestHash(normalizeOrganizationName("Café")),
    organizationRequestHash(normalizeOrganizationName("Cafe\u0301"))
  );
  assert.throws(() => normalizeOrganizationName(" \n "), OrganizationServiceError);
  assert.throws(() => normalizeOrganizationName("x".repeat(121)), OrganizationServiceError);
});

test("organization idempotency keys have a bounded explicit format", () => {
  assert.equal(validateOrganizationIdempotencyKey("request:123"), "request:123");
  assert.throws(() => validateOrganizationIdempotencyKey(""), /Idempotency-Key/);
  assert.throws(() => validateOrganizationIdempotencyKey("x".repeat(129)), /Idempotency-Key/);
});

test("organization permissions are separate from Phase 06 role permissions and deny unknown roles", () => {
  assert.equal(hasOrganizationPermission("owner", "organization:delete"), true);
  assert.equal(hasOrganizationPermission("admin", "organization:delete"), false);
  assert.equal(hasOrganizationPermission("admin", "organization:members:manage"), true);
  for (const role of ["owner", "admin", "operator", "viewer"]) {
    assert.equal(hasOrganizationPermission(role, "organization:integrations"), true);
  }
  assert.equal(hasOrganizationPermission("owner", "organization:integrations:manage"), true);
  assert.equal(hasOrganizationPermission("admin", "organization:integrations:manage"), true);
  assert.equal(hasOrganizationPermission("operator", "organization:integrations:manage"), false);
  assert.equal(hasOrganizationPermission("viewer", "organization:integrations:manage"), false);
  assert.equal(hasOrganizationPermission("operator", "scan:create"), true);
  assert.equal(hasOrganizationPermission("viewer", "remediation:create"), false);
  assert.equal(hasOrganizationPermission("global-admin", "project:delete"), false);
});

test("organization creation validates input, returns atomic owner shape and handles replay status", async () => {
  const { routes, orgCalls } = api();
  const first = request("POST", "/api/v1/organizations", { displayName: "  Example  " }, { "idempotency-key": "create-1" });
  await routes.handle(first.context);
  assert.equal(first.response.status, 201);
  assert.equal((first.response.data as { organization: { displayName: string }; membership: { role: string } }).organization.displayName, "Example");
  assert.equal((first.response.data as { membership: { role: string } }).membership.role, "owner");
  assert.equal((orgCalls[0] as { displayName: string }).displayName, "Example");

  const replay = request("POST", "/api/v1/organizations", { displayName: "Example" }, { "idempotency-key": "replay" });
  await routes.handle(replay.context);
  assert.equal(replay.response.status, 200);
});

test("organization creation rejects missing idempotency key, extra fields, and disabled creation", async () => {
  const { routes } = api();
  const missing = request("POST", "/api/v1/organizations", { displayName: "Org" });
  await routes.handle(missing.context);
  assert.equal(missing.response.status, 400);
  const extra = request("POST", "/api/v1/organizations", { displayName: "Org", ownerId: "spoof" }, { "idempotency-key": "a" });
  await routes.handle(extra.context);
  assert.equal(extra.response.status, 400);
  const disabledApi = api({ organizationCreationEnabled: false }).routes;
  const disabled = request("POST", "/api/v1/organizations", { displayName: "Org" }, { "idempotency-key": "a" });
  await disabledApi.handle(disabled.context);
  assert.equal(disabled.response.status, 403);
});

test("organization listing uses bounded keyset cursor parameters and excludes caller-selected user IDs", async () => {
  const { routes, orgCalls } = api();
  const valid = request("GET", "/api/v1/organizations?limit=4");
  await routes.handle(valid.context);
  assert.equal(valid.response.status, 200);
  assert.deepEqual(orgCalls[0], { limit: 4, cursor: undefined });
  const invalid = request("GET", "/api/v1/organizations?limit=101");
  await routes.handle(invalid.context);
  assert.equal(invalid.response.status, 400);
});

test("organization create rate limiter bounds requests and resets its window", () => {
  const limiter = new OrganizationCreateRateLimiter(2, 100, 2);
  assert.equal(limiter.allow("principal-a", 0), true);
  assert.equal(limiter.allow("principal-a", 1), true);
  assert.equal(limiter.allow("principal-a", 2), false);
  assert.equal(limiter.allow("principal-a", 101), true);
});
