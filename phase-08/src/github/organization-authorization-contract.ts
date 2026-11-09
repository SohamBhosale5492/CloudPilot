import type { Prisma, PrismaClient } from "@prisma/client";
import { hasOrganizationPermission, type OrganizationPermission } from "../organizations/permissions.js";

/**
 * Opaque compile-time capability returned only by the trusted organization
 * authorization boundary. Browser/API request data must never construct it.
 */
declare const authorizedGitHubRepositoryAccess: unique symbol;

export interface AuthorizedGitHubRepositoryAccess {
  readonly installationId: string;
  /** Immutable GitHub repository database ID, not owner/name or a client selector. */
  readonly repositoryId: string;
  readonly [authorizedGitHubRepositoryAccess]: true;
}

export type OrganizationGitHubPermission = "repository:read" | "repository:remediate";

/**
 * Contract for the persistence-backed authorization implementation. It
 * resolves installation/repository data from trusted bindings and verifies
 * active membership and permission before returning access context.
 *
 * `organizationId` and `projectId` may originate in a route, but are selectors
 * only: implementations must prove ownership and membership from persistence.
 */
export interface TrustedOrganizationGitHubAuthorizationService {
  resolveAuthorizedRepository(input: {
    readonly identityUserId: string;
    /** Verified legacy Entra tid from the authenticated request, never a body field. */
    readonly tenantId: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly permission: OrganizationGitHubPermission;
  }): Promise<AuthorizedGitHubRepositoryAccess>;
}
/**
 * Trusted persistence adapter. A future installation/binding implementation
 * must verify active installation state and return only server-persisted
 * immutable GitHub identifiers. It receives the same transaction as the
 * membership/project/adoption checks to avoid mixing authorization snapshots.
 * The current schema has no such binding, so the host uses a deny-all adapter.
 */
export interface GitHubRepositoryBindingResolver {
  findActiveBinding(tx: Prisma.TransactionClient, input: { organizationId: string; tenantId: string; projectId: string }): Promise<{
    installationId: string;
    repositoryId: string;
  } | null>;
}

export class GitHubRepositoryBindingUnavailableError extends Error {
  constructor() {
    super("No active organization GitHub repository binding is available.");
    this.name = "GitHubRepositoryBindingUnavailableError";
  }
}

/**
 * Checks current database state on every call. Route IDs are selectors only;
 * the org, active membership, tenant-owned project, approved adoption, and
 * active repository binding must all agree before a capability is issued.
 */
export class PrismaTrustedOrganizationGitHubAuthorizationService implements TrustedOrganizationGitHubAuthorizationService {
  constructor(private readonly prisma: PrismaClient, private readonly bindings: GitHubRepositoryBindingResolver) {}

  async resolveAuthorizedRepository(input: {
    readonly identityUserId: string;
    readonly tenantId: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly permission: OrganizationGitHubPermission;
  }): Promise<AuthorizedGitHubRepositoryAccess> {
    const requiredPermission: OrganizationPermission = input.permission === "repository:read"
      ? "organization:integrations"
      : "organization:integrations:manage";
    return this.prisma.$transaction(async (tx) => {
      const membership = await tx.organizationMember.findFirst({
        where: {
          organizationId: input.organizationId,
          userId: input.identityUserId,
          status: "active",
          user: { is: { status: "active" } },
          organization: { is: { status: "active" } }
        },
        select: { role: true }
      });
      if (!membership || !hasOrganizationPermission(membership.role, requiredPermission)) {
        throw new Error("Organization GitHub access is forbidden.");
      }

      const project = await tx.project.findFirst({
        where: { id: input.projectId, tenantId: input.tenantId, organizationId: input.organizationId },
        select: { id: true }
      });
      if (!project) throw new Error("Organization project was not found.");
      const adoption = await tx.projectOrganizationAdoption.findFirst({
        where: {
          tenantId: input.tenantId,
          projectId: input.projectId,
          organizationId: input.organizationId,
          status: "approved"
        },
        select: { id: true }
      });
      if (!adoption) throw new Error("Project adoption is not approved.");

      const binding = await this.bindings.findActiveBinding(tx, {
        organizationId: input.organizationId,
        tenantId: input.tenantId,
        projectId: input.projectId
      });
      if (!binding || !/^\d+$/.test(binding.installationId) || !/^\d+$/.test(binding.repositoryId)) {
        throw new GitHubRepositoryBindingUnavailableError();
      }
      return Object.freeze({
        installationId: binding.installationId,
        repositoryId: binding.repositoryId
      }) as AuthorizedGitHubRepositoryAccess;
    }, { isolationLevel: "Serializable" });
  }
}

/** Safe until the installation/binding persistence stage is implemented. */
export class NoGitHubRepositoryBindingResolver implements GitHubRepositoryBindingResolver {
  async findActiveBinding(): Promise<null> { return null; }
}
