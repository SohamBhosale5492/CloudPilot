import { Prisma, PrismaClient, IdentityUser } from "@prisma/client";
import { validateExternalIdentity, VerifiedExternalIdentity } from "./external-identity.js";

export class IdentityResolutionError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "IdentityResolutionError";
  }
}

export interface IdentityResolver {
  resolve(identity: VerifiedExternalIdentity, allowProvisioning: boolean): Promise<IdentityUser>;
}

function isExternalIdentityUniqueConflict(error: unknown): boolean {
  if (!error || typeof error !== "object" || !(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = error.meta?.target;
  if (Array.isArray(target)) return target.includes("issuer") && target.includes("subject");
  return typeof target === "string" && target.includes("uq_external_identities_issuer_subject");
}

export class PrismaIdentityResolver implements IdentityResolver {
  constructor(private readonly prisma: PrismaClient, private readonly now: () => Date = () => new Date()) {}

  async resolve(identity: VerifiedExternalIdentity, allowProvisioning: boolean): Promise<IdentityUser> {
    validateExternalIdentity(identity);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.externalIdentity.findUnique({
          where: { issuer_subject: { issuer: identity.issuer, subject: identity.subject } },
          include: { user: true }
        });
        if (existing) return this.touchAndReturn(tx, existing.user, existing.id);

        if (!allowProvisioning) {
          throw new IdentityResolutionError(403, "This identity is not provisioned for CloudPilot.");
        }

        const now = this.now();
        const user = await tx.identityUser.create({ data: { status: "active", lastAuthenticatedAt: now } });
        await tx.externalIdentity.create({
          data: {
            issuer: identity.issuer,
            subject: identity.subject,
            userId: user.id,
            lastAuthenticatedAt: now
          }
        });
        return user;
      });
    } catch (error) {
      if (error instanceof IdentityResolutionError) throw error;
      if (!isExternalIdentityUniqueConflict(error)) throw error;

      // A losing transaction has rolled back its newly-created user. Re-read only
      // the exact external identity that won the unique constraint.
      const winner = await this.prisma.externalIdentity.findUnique({
        where: { issuer_subject: { issuer: identity.issuer, subject: identity.subject } },
        include: { user: true }
      });
      if (!winner) throw error;
      if (winner.user.status !== "active") throw new IdentityResolutionError(403, "CloudPilot account is suspended.");
      const now = this.now();
      await this.prisma.$transaction(async (tx) => {
        await tx.identityUser.update({ where: { id: winner.user.id }, data: { lastAuthenticatedAt: now } });
        await tx.externalIdentity.update({ where: { id: winner.id }, data: { lastAuthenticatedAt: now } });
      });
      return { ...winner.user, lastAuthenticatedAt: now };
    }
  }

  private async touchAndReturn(
    tx: Prisma.TransactionClient,
    user: IdentityUser,
    externalIdentityId: string
  ): Promise<IdentityUser> {
    if (user.status !== "active") throw new IdentityResolutionError(403, "CloudPilot account is suspended.");
    const now = this.now();
    await tx.identityUser.update({ where: { id: user.id }, data: { lastAuthenticatedAt: now } });
    await tx.externalIdentity.update({ where: { id: externalIdentityId }, data: { lastAuthenticatedAt: now } });
    return { ...user, lastAuthenticatedAt: now };
  }
}
