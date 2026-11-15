import { createHash } from "node:crypto";
import { Prisma, PrismaClient, IdentityUser, Organization, OrganizationMember } from "@prisma/client";

export class OrganizationServiceError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "OrganizationServiceError";
  }
}

export interface OrganizationCreateInput {
  creatorUserId: string;
  idempotencyKey: string;
  displayName: string;
}

export interface OrganizationCreateResult {
  organization: Organization;
  membership: OrganizationMember;
  replayed: boolean;
}

export interface OrganizationCursor {
  createdAt: Date;
  id: string;
}

export interface OrganizationListItem {
  id: string;
  displayName: string;
  status: string;
  createdAt: Date;
  role: string;
}

export interface OrganizationPage {
  items: OrganizationListItem[];
  nextCursor?: OrganizationCursor;
  hasMore: boolean;
}

export function normalizeOrganizationName(value: unknown): string {
  if (typeof value !== "string") throw new OrganizationServiceError(400, "displayName must be a string.");
  const normalized = value.normalize("NFC").trim();
  if (!normalized || [...normalized].length > 120 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new OrganizationServiceError(400, "displayName must contain 1 to 120 printable characters.");
  }
  return normalized;
}

export function validateOrganizationIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new OrganizationServiceError(400, "A valid Idempotency-Key header is required.");
  }
  return value;
}

export function organizationRequestHash(displayName: string): string {
  return createHash("sha256").update(JSON.stringify({ displayName }), "utf8").digest("hex");
}

function isOrganizationIdempotencyConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  const target = error.meta?.target;
  if (Array.isArray(target)) return target.includes("created_by_user_id") && target.includes("creation_idempotency_key");
  return typeof target === "string" && target.includes("uq_organizations_creator_idempotency");
}

export class PrismaOrganizationService {
  constructor(private readonly prisma: PrismaClient) {}

  async getProfile(userId: string): Promise<IdentityUser | null> {
    return this.prisma.identityUser.findFirst({ where: { id: userId, status: "active" } });
  }

  async create(input: OrganizationCreateInput, perUserLimit: number): Promise<OrganizationCreateResult> {
    const displayName = normalizeOrganizationName(input.displayName);
    const requestHash = organizationRequestHash(displayName);
    const idempotencyKey = validateOrganizationIdempotencyKey(input.idempotencyKey);

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialize per-creator count/idempotency decisions across app instances.
        const lockedUsers = await tx.$queryRaw<Array<{ id: string; status: string }>>`
          SELECT id, status FROM identity_users WHERE id = ${input.creatorUserId}::uuid FOR UPDATE
        `;
        if (!lockedUsers[0] || lockedUsers[0].status !== "active") {
          throw new OrganizationServiceError(403, "An active CloudPilot identity is required.");
        }

        const existing = await tx.organization.findUnique({
          where: { createdByUserId_creationIdempotencyKey: {
            createdByUserId: input.creatorUserId,
            creationIdempotencyKey: idempotencyKey
          } },
          include: { memberships: { where: { userId: input.creatorUserId }, take: 1 } }
        });
        if (existing) {
          if (existing.creationRequestHash !== requestHash) {
            throw new OrganizationServiceError(409, "Idempotency-Key was already used with a different request.");
          }
          const membership = existing.memberships[0];
          if (!membership || membership.role !== "owner" || membership.status !== "active") {
            throw new Error("Organization idempotency record has no active initial owner membership.");
          }
          return { organization: existing, membership, replayed: true };
        }

        const count = await tx.organization.count({ where: { createdByUserId: input.creatorUserId } });
        if (count >= perUserLimit) throw new OrganizationServiceError(429, "Organization creation limit reached.");

        const organization = await tx.organization.create({
          data: {
            displayName,
            status: "active",
            createdByUserId: input.creatorUserId,
            creationIdempotencyKey: idempotencyKey,
            creationRequestHash: requestHash
          }
        });
        const membership = await tx.organizationMember.create({
          data: {
            organizationId: organization.id,
            userId: input.creatorUserId,
            role: "owner",
            status: "active",
            createdByUserId: input.creatorUserId
          }
        });

        await tx.organizationAuditEvent.create({
          data: {
            organizationId: organization.id,
            actorUserId: input.creatorUserId,
            action: "ORGANIZATION_CREATED",
            targetType: "organization",
            targetId: organization.id,
            metadata: { displayName } as Prisma.InputJsonValue
          },
          select: { id: true }
        });
        await tx.organizationAuditEvent.create({
          data: {
            organizationId: organization.id,
            actorUserId: input.creatorUserId,
            action: "OWNER_MEMBERSHIP_CREATED",
            targetType: "organization_member",
            targetId: `${organization.id}:${input.creatorUserId}`,
            metadata: { role: "owner", userId: input.creatorUserId } as Prisma.InputJsonValue
          },
          select: { id: true }
        });
        return { organization, membership, replayed: false };
      });
    } catch (error) {
      if (error instanceof OrganizationServiceError) throw error;
      if (!isOrganizationIdempotencyConflict(error)) throw error;
      const existing = await this.prisma.organization.findUnique({
        where: { createdByUserId_creationIdempotencyKey: {
          createdByUserId: input.creatorUserId,
          creationIdempotencyKey: idempotencyKey
        } },
        include: { memberships: { where: { userId: input.creatorUserId }, take: 1 } }
      });
      if (!existing) throw error;
      if (existing.creationRequestHash !== requestHash) {
        throw new OrganizationServiceError(409, "Idempotency-Key was already used with a different request.");
      }
      const membership = existing.memberships[0];
      if (!membership || membership.role !== "owner" || membership.status !== "active") {
        throw new Error("Organization idempotency record has no active initial owner membership.");
      }
      return { organization: existing, membership, replayed: true };
    }
  }

  async listForUser(userId: string, limit: number, cursor?: OrganizationCursor): Promise<OrganizationPage> {
    const records = await this.prisma.organization.findMany({
      where: {
        status: "active",
        memberships: { some: { userId, status: "active", user: { is: { status: "active" } } } },
        ...(cursor ? { OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } }
        ] } : {})
      },
      take: limit + 1,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: {
        memberships: {
          where: { userId, status: "active", user: { is: { status: "active" } } },
          select: { role: true }, take: 1
        }
      }
    });
    const hasMore = records.length > limit;
    const page = hasMore ? records.slice(0, limit) : records;
    const items = page.map((record) => ({
      id: record.id,
      displayName: record.displayName,
      status: record.status,
      createdAt: record.createdAt,
      role: record.memberships[0]?.role ?? ""
    }));
    const last = page.at(-1);
    return {
      items,
      hasMore,
      ...(hasMore && last ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {})
    };
  }
}
