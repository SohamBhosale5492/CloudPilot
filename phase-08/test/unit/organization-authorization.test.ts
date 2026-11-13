import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import type { AuthenticatedRouteContext } from "../../../phase-06/src/api/server.js";
import { OrganizationAuthorizationApiRoutes } from "../../src/api/organization-authorization-api.js";
import type { IdentityResolver } from "../../src/identity/identity-resolver.js";
import { PrismaOrganizationAuthorizationService } from "../../src/organizations/authorization-service.js";
import { PrismaProjectAdoptionService } from "../../src/organizations/project-adoption-service.js";
import {
  GitHubRepositoryBindingUnavailableError,
  PrismaGitHubRepositoryBindingResolver,
  PrismaTrustedOrganizationGitHubAuthorizationService
} from "../../src/github/organization-authorization-contract.js";
import { hasOrganizationPermission } from "../../src/organizations/permissions.js";

const org = "11111111-1111-4111-8111-111111111111";
const otherOrg = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "22222222-2222-4222-8222-222222222222";
const tenant = "verified-entra-tenant";
const user = "33333333-3333-4333-8333-333333333333";

test("persisted GitHub binding resolver scopes active repository and installation to the same project organization", async () => {
  const queries: unknown[] = [];
  let active = true;
  const tx = { projectGitHubRepository: { async findFirst(args: unknown) {
    queries.push(args);
    return active ? { githubRepositoryId: 9007199254740993n, installation: { githubInstallationId: 9007199254740995n } } : null;
  } } } as never;
  const resolver = new PrismaGitHubRepositoryBindingResolver();
  assert.deepEqual(await resolver.findActiveBinding(tx, { tenantId: tenant, organizationId: org, projectId }), {
    repositoryId: "9007199254740993", installationId: "9007199254740995"
  });
  assert.deepEqual(queries[0], { where: {
    organizationId: org, tenantId: tenant, projectId, status: "active",
    installation: { is: { organizationId: org, status: "active" } }
  }, select: { githubRepositoryId: true, installation: { select: { githubInstallationId: true } } } });
  active = false;
  assert.equal(await resolver.findActiveBinding(tx, { tenantId: tenant, organizationId: org, projectId }), null);
});

test("integration status permission is available to all active org roles while management stays owner/admin only", () => {
  for (const role of ["owner", "admin", "operator", "viewer"]) {
    assert.equal(hasOrganizationPermission(role, "organization:integrations"), true, role);
  }
  for (const role of ["owner", "admin"]) assert.equal(hasOrganizationPermission(role, "organization:integrations:manage"), true);
  for (const role of ["operator", "viewer"]) assert.equal(hasOrganizationPermission(role, "organization:integrations:manage"), false);
  assert.equal(hasOrganizationPermission("global-admin", "organization:integrations"), false);
});

test("remediation approval is a dedicated owner/admin permission and is distinct from integration management", () => {
  for (const role of ["owner", "admin"]) {
    assert.equal(hasOrganizationPermission(role, "remediation:approve"), true, role);
  }
  for (const role of ["operator", "viewer"]) {
    assert.equal(hasOrganizationPermission(role, "remediation:approve"), false, role);
  }
  assert.equal(hasOrganizationPermission("operator", "remediation:create"), true);
});

test("organization permission lookup requires active membership, user, organization, and the requested database role", async () => {
  const queries: unknown[] = [];
  let row: { role: string } | null = { role: "viewer" };
  const prisma = { organizationMember: { async findFirst(args: unknown) { queries.push(args); return row; } } } as unknown as PrismaClient;
  const auth = new PrismaOrganizationAuthorizationService(prisma);
  assert.equal((await auth.authorize(user, org, "organization:integrations"))?.role, "viewer");
  assert.deepEqual(queries[0], { where: {
    organizationId: org, userId: user, status: "active", user: { is: { status: "active" } }, organization: { is: { status: "active" } }
  }, select: { role: true } });
  row = null; // inactive, missing, or cross-org membership is represented as no active row
  assert.equal(await auth.authorize(user, org, "organization:integrations"), null);
});

test("GitHub capability resolution rechecks membership, verified tenant ownership, approved adoption, and active binding", async () => {
  const calls: string[] = [];
  let role = "admin";
  let project: unknown = { id: projectId };
  let adoption: unknown = { id: "adoption" };
  let binding: { installationId: string; repositoryId: string } | null = { installationId: "81", repositoryId: "92" };
  const database = {
    organizationMember: { async findFirst(args: { where: { organizationId: string; userId: string } }) {
      calls.push("membership");
      assert.equal(args.where.userId, user);
      return args.where.organizationId === org ? { role } : null;
    } },
    project: { async findFirst(args: { where: { id: string; tenantId: string; organizationId: string } }) {
      calls.push("project");
      if (args.where.id !== projectId || args.where.tenantId !== tenant || args.where.organizationId !== org) return null;
      return project;
    } },
    projectOrganizationAdoption: { async findFirst(args: { where: Record<string, unknown> }) {
      calls.push("adoption"); assert.equal(args.where.status, "approved"); assert.equal(args.where.tenantId, tenant); return adoption;
    } }
  };
  const prisma = { $transaction: async (callback: (tx: any) => Promise<unknown>) => callback(database) } as unknown as PrismaClient;
  const service = new PrismaTrustedOrganizationGitHubAuthorizationService(prisma, {
    async findActiveBinding(_tx, input) { calls.push("binding"); assert.deepEqual(input, { organizationId: org, tenantId: tenant, projectId }); return binding; }
  });
  const access = await service.resolveAuthorizedRepository({ identityUserId: user, tenantId: tenant, organizationId: org, projectId, permission: "repository:remediate" });
  assert.deepEqual({ installationId: access.installationId, repositoryId: access.repositoryId }, { installationId: "81", repositoryId: "92" });
  assert.deepEqual(calls, ["membership", "project", "adoption", "binding"]);

  role = "operator";
  await assert.rejects(service.resolveAuthorizedRepository({ identityUserId: user, tenantId: tenant, organizationId: org, projectId, permission: "repository:remediate" }), /forbidden/i);
  role = "viewer";
  const read = await service.resolveAuthorizedRepository({ identityUserId: user, tenantId: tenant, organizationId: org, projectId, permission: "repository:read" });
  assert.equal(read.repositoryId, "92");

  role = "admin"; project = null;
  await assert.rejects(service.resolveAuthorizedRepository({ identityUserId: user, tenantId: "another-tenant", organizationId: org, projectId, permission: "repository:read" }), /not found/i);
  await assert.rejects(service.resolveAuthorizedRepository({ identityUserId: user, tenantId: tenant, organizationId: otherOrg, projectId, permission: "repository:read" }), /forbidden/i);
  project = { id: projectId }; adoption = null;
  await assert.rejects(service.resolveAuthorizedRepository({ identityUserId: user, tenantId: tenant, organizationId: org, projectId, permission: "repository:read" }), /not approved/i);
  adoption = { id: "adoption" }; binding = null;
  await assert.rejects(service.resolveAuthorizedRepository({ identityUserId: user, tenantId: tenant, organizationId: org, projectId, permission: "repository:read" }), GitHubRepositoryBindingUnavailableError);
});

test("membership revocation before execution fails closed on the next authorization check", async () => {
  let active = true;
  const database = {
    organizationMember: { async findFirst() { return active ? { role: "admin" } : null; } },
    project: { async findFirst() { return { id: projectId }; } },
    projectOrganizationAdoption: { async findFirst() { return { id: "adoption" }; } }
  };
  const prisma = { $transaction: async (callback: (tx: any) => Promise<unknown>) => callback(database) } as unknown as PrismaClient;
  const service = new PrismaTrustedOrganizationGitHubAuthorizationService(prisma, {
    async findActiveBinding() { return { installationId: "8", repositoryId: "9" }; }
  });
  const input = { identityUserId: user, tenantId: tenant, organizationId: org, projectId, permission: "repository:read" as const };
  assert.equal((await service.resolveAuthorizedRepository(input)).repositoryId, "9");
  active = false;
  await assert.rejects(service.resolveAuthorizedRepository(input), /forbidden/i);
});

test("approval atomically assigns only a same-tenant legacy project and writes an organization audit event", async () => {
  const events: unknown[] = [];
  const writes: unknown[] = [];
  const tx = {
    organizationMember: { async findFirst() { return { role: "owner" }; } },
    projectOrganizationAdoption: {
      async findFirst() { return { id: "adoption", tenantId: tenant, organizationId: org, projectId, status: "pending", requestedByIdentityUserId: "requester" }; },
      async updateMany(args: unknown) { writes.push(["adoption", args]); return { count: 1 }; }
    },
    project: { async updateMany(args: unknown) { writes.push(["project", args]); return { count: 1 }; } },
    organizationAuditEvent: { async create(args: unknown) { events.push(args); } }
  };
  const prisma = { $transaction: async (callback: (tx: any) => Promise<unknown>) => callback(tx) } as unknown as PrismaClient;
  const service = new PrismaProjectAdoptionService(prisma);
  const result = await service.decide({ tenantId: tenant, organizationId: org, projectId, identityUserId: user, idempotencyKey: "unused", adoptionId: "adoption", decision: "approve" });
  assert.deepEqual(result, { id: "adoption", status: "approved" });
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], ["project", { where: { id: projectId, tenantId: tenant, organizationId: null }, data: { organizationId: org } }]);
  assert.equal(events.length, 1);
  assert.deepEqual((events[0] as { data: Record<string, unknown> }).data, {
    organizationId: org, tenantId: tenant, projectId, adoptionId: "adoption", actorUserId: user,
    action: "PROJECT_ADOPTION_APPROVED", targetType: "project_organization_adoption", targetId: "adoption",
    metadata: { projectId, status: "approved" }
  });
});

test("adoption request is scoped to verified tenant, requires an unowned legacy project, and records provenance atomically", async () => {
  const observed: unknown[] = [];
  const tx = {
    organizationMember: { async findFirst(args: unknown) { observed.push(["membership", args]); return { role: "admin" }; } },
    project: { async findFirst(args: unknown) { observed.push(["project", args]); return { id: projectId, organizationId: null }; } },
    projectOrganizationAdoption: {
      async findUnique(args: unknown) { observed.push(["idempotency", args]); return null; },
      async create(args: { data: Record<string, unknown> }) {
        observed.push(["create", args]);
        return { id: "adoption", status: "pending", ...args.data };
      }
    },
    organizationAuditEvent: { async create(args: unknown) { observed.push(["audit", args]); } }
  };
  const prisma = { $transaction: async (callback: (tx: any) => Promise<unknown>, options: unknown) => {
    assert.deepEqual(options, { isolationLevel: "Serializable" });
    return callback(tx);
  } } as unknown as PrismaClient;
  const result = await new PrismaProjectAdoptionService(prisma).request({
    tenantId: tenant, organizationId: org, projectId, identityUserId: user, idempotencyKey: "adopt-1"
  });
  assert.equal(result.replayed, false);
  assert.equal((result.adoption as { status: string }).status, "pending");
  const projectQuery = observed.find((item) => (item as unknown[])[0] === "project") as unknown[];
  assert.deepEqual(projectQuery[1], { where: { id: projectId, tenantId: tenant }, select: { id: true, organizationId: true } });
  const create = observed.find((item) => (item as unknown[])[0] === "create") as unknown[];
  const createData = (create[1] as { data: Record<string, unknown> }).data;
  assert.equal(createData.tenantId, tenant);
  assert.equal(createData.organizationId, org);
  assert.deepEqual(createData.provenance, { source: "authenticated-organization-project-adoption", tenantVerifiedByApi: true });
  assert.equal(observed.filter((item) => (item as unknown[])[0] === "audit").length, 1);
});

test("rejection never changes legacy project ownership", async () => {
  const writes: unknown[] = [];
  const tx = {
    organizationMember: { async findFirst() { return { role: "admin" }; } },
    projectOrganizationAdoption: {
      async findFirst() { return { id: "adoption", tenantId: tenant, organizationId: org, projectId, status: "pending", requestedByIdentityUserId: user }; },
      async updateMany(args: unknown) { writes.push(["adoption", args]); return { count: 1 }; }
    },
    project: { async updateMany(args: unknown) { writes.push(["project", args]); return { count: 1 }; } },
    organizationAuditEvent: { async create(args: unknown) { writes.push(["audit", args]); } }
  };
  const prisma = { $transaction: async (callback: (tx: any) => Promise<unknown>) => callback(tx) } as unknown as PrismaClient;
  const service = new PrismaProjectAdoptionService(prisma);
  const base = { tenantId: tenant, organizationId: org, projectId, identityUserId: user, idempotencyKey: "unused", adoptionId: "adoption" };
  await service.decide({ ...base, decision: "reject" });
  assert.equal(writes.some((entry) => (entry as unknown[])[0] === "project"), false);
});

test("adoption API derives local identity from verified issuer/subject and legacy tenant from authenticated context", async () => {
  const principals: unknown[] = [];
  let requested: unknown;
  const identityResolver = {
    async resolve(principal: unknown, allow: boolean) {
      principals.push([principal, allow]);
      return { id: user, status: "active" };
    }
  } as unknown as IdentityResolver;
  const authorization = { async authorize() { return { role: "viewer", permission: "organization:integrations" }; } };
  const adoptionService = {
    async request(input: unknown) { requested = input; return { adoption: { id: "44444444-4444-4444-8444-444444444444", status: "pending" }, replayed: false }; },
    async decide() { throw new Error("unused"); }
  };
  const routes = new OrganizationAuthorizationApiRoutes(identityResolver, authorization as never, adoptionService as never, {
    expectedIssuer: "https://issuer.example/tenant/v2.0", allowFirstUseProvisioning: false
  });
  const response: { status?: number; body?: unknown } = {};
  const context = {
    method: "POST", pathname: `/api/v1/organizations/${org}/project-adoptions`,
    identity: { userId: "verified-subject", tenantId: tenant, roles: ["viewer"] },
    req: { headers: { "idempotency-key": "request-1" } },
    async parseJsonBody() { return { projectId }; },
    sendJson(status: number, body: unknown) { response.status = status; response.body = body; }
  } as unknown as AuthenticatedRouteContext;
  assert.equal(await routes.handle(context), true);
  assert.deepEqual(principals, [[{ issuer: "https://issuer.example/tenant/v2.0", subject: "verified-subject" }, false]]);
  assert.deepEqual(requested, { tenantId: tenant, organizationId: org, projectId, identityUserId: user, idempotencyKey: "request-1" });
  assert.equal(response.status, 202);
  assert.deepEqual(response.body, { adoption: { id: "44444444-4444-4444-8444-444444444444", status: "pending", projectId }, replayed: false });
});
