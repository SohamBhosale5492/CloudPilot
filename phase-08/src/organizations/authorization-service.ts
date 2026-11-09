import type { Prisma, PrismaClient } from "@prisma/client";
import { hasOrganizationPermission, type OrganizationPermission, type OrganizationRole } from "./permissions.js";

export interface OrganizationAuthorizationResult {
  role: OrganizationRole;
  permission: OrganizationPermission;
}

/** Database-backed membership/permission lookup; JWT role claims are never consulted. */
export class PrismaOrganizationAuthorizationService {
  constructor(private readonly prisma: PrismaClient) {}

  async authorize(identityUserId: string, organizationId: string, permission: OrganizationPermission): Promise<OrganizationAuthorizationResult | null> {
    return this.authorizeUsing(this.prisma, identityUserId, organizationId, permission);
  }

  /** Reuses the same membership/role policy inside a caller-owned transaction. */
  authorizeInTransaction(
    tx: Pick<Prisma.TransactionClient, "organizationMember">,
    identityUserId: string,
    organizationId: string,
    permission: OrganizationPermission
  ): Promise<OrganizationAuthorizationResult | null> {
    return this.authorizeUsing(tx, identityUserId, organizationId, permission);
  }

  private async authorizeUsing(
    client: Pick<Prisma.TransactionClient, "organizationMember">,
    identityUserId: string,
    organizationId: string,
    permission: OrganizationPermission
  ): Promise<OrganizationAuthorizationResult | null> {
    const membership = await client.organizationMember.findFirst({
      where: {
        organizationId,
        userId: identityUserId,
        status: "active",
        user: { is: { status: "active" } },
        organization: { is: { status: "active" } }
      },
      select: { role: true }
    });
    if (!membership || !hasOrganizationPermission(membership.role, permission)) return null;
    return { role: membership.role as OrganizationRole, permission };
  }
}
