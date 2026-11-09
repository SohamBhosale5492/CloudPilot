import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { hasOrganizationPermission } from "./permissions.js";

export class ProjectAdoptionError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); this.name = "ProjectAdoptionError"; }
}

export interface AdoptionInput {
  tenantId: string;
  organizationId: string;
  projectId: string;
  identityUserId: string;
  idempotencyKey: string;
}

function validateKey(key: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new ProjectAdoptionError(400, "A valid Idempotency-Key header is required.");
}

function requestHash(input: AdoptionInput): string {
  return createHash("sha256").update(JSON.stringify({ tenantId: input.tenantId, organizationId: input.organizationId, projectId: input.projectId })).digest("hex");
}

function adoptionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034");
}

export class PrismaProjectAdoptionService {
  constructor(private readonly prisma: PrismaClient) {}

  async request(input: AdoptionInput): Promise<{ adoption: unknown; replayed: boolean }> {
    validateKey(input.idempotencyKey);
    const hash = requestHash(input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.requireIntegrationManager(tx, input.identityUserId, input.organizationId);
        const prior = await tx.projectOrganizationAdoption.findUnique({
          where: { requestedByIdentityUserId_idempotencyKey: {
            requestedByIdentityUserId: input.identityUserId,
            idempotencyKey: input.idempotencyKey
          } }
        });
        if (prior) {
          if (prior.requestHash !== hash || prior.organizationId !== input.organizationId || prior.projectId !== input.projectId || prior.tenantId !== input.tenantId) {
            throw new ProjectAdoptionError(409, "Idempotency-Key was already used with a different adoption request.");
          }
          return { adoption: prior, replayed: true };
        }

        const project = await tx.project.findFirst({
          where: { id: input.projectId, tenantId: input.tenantId },
          select: { id: true, organizationId: true }
        });
        if (!project) throw new ProjectAdoptionError(404, "Project not found.");
        if (project.organizationId !== null) throw new ProjectAdoptionError(409, "Project already belongs to an organization.");

        const adoption = await tx.projectOrganizationAdoption.create({ data: {
          tenantId: input.tenantId,
          projectId: input.projectId,
          organizationId: input.organizationId,
          requestedByIdentityUserId: input.identityUserId,
          idempotencyKey: input.idempotencyKey,
          requestHash: hash,
          provenance: { source: "authenticated-organization-project-adoption", tenantVerifiedByApi: true } as Prisma.InputJsonValue
        } });
        await tx.organizationAuditEvent.create({ data: {
          organizationId: input.organizationId,
          tenantId: input.tenantId,
          projectId: input.projectId,
          adoptionId: adoption.id,
          actorUserId: input.identityUserId,
          action: "PROJECT_ADOPTION_REQUESTED",
          targetType: "project_organization_adoption",
          targetId: adoption.id,
          metadata: { projectId: input.projectId, status: "pending" } as Prisma.InputJsonValue
        } });
        return { adoption, replayed: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof ProjectAdoptionError || !adoptionConflict(error)) throw error;
      const existing = await this.prisma.projectOrganizationAdoption.findUnique({
        where: { requestedByIdentityUserId_idempotencyKey: {
          requestedByIdentityUserId: input.identityUserId, idempotencyKey: input.idempotencyKey
        } }
      });
      if (existing) {
        if (existing.requestHash !== hash || existing.organizationId !== input.organizationId || existing.projectId !== input.projectId || existing.tenantId !== input.tenantId) {
          throw new ProjectAdoptionError(409, "Idempotency-Key was already used with a different adoption request.");
        }
        return { adoption: existing, replayed: true };
      }
      throw new ProjectAdoptionError(409, "A project adoption is already pending or changed concurrently.");
    }
  }

  async decide(input: AdoptionInput & { adoptionId: string; decision: "approve" | "reject" }): Promise<unknown> {
    try {
      return await this.prisma.$transaction(async (tx) => {
      await this.requireIntegrationManager(tx, input.identityUserId, input.organizationId);
      const adoption = await tx.projectOrganizationAdoption.findFirst({
        where: { id: input.adoptionId, tenantId: input.tenantId, organizationId: input.organizationId, projectId: input.projectId }
      });
      if (!adoption) throw new ProjectAdoptionError(404, "Project adoption not found.");
      if (adoption.status !== "pending") throw new ProjectAdoptionError(409, "Project adoption is no longer pending.");
      const now = new Date();
      const updatedAdoption = await tx.projectOrganizationAdoption.updateMany({
        where: { id: adoption.id, tenantId: input.tenantId, organizationId: input.organizationId, status: "pending" },
        data: input.decision === "approve"
          ? { status: "approved", approvedByIdentityUserId: input.identityUserId, approvedAt: now }
          : { status: "rejected", rejectedAt: now }
      });
      if (updatedAdoption.count !== 1) throw new ProjectAdoptionError(409, "Project adoption changed concurrently.");

      if (input.decision === "approve") {
        const adopted = await tx.project.updateMany({
          where: { id: input.projectId, tenantId: input.tenantId, organizationId: null },
          data: { organizationId: input.organizationId }
        });
        if (adopted.count !== 1) throw new ProjectAdoptionError(409, "Project ownership changed before approval.");
      }
      await tx.organizationAuditEvent.create({ data: {
        organizationId: input.organizationId,
        tenantId: input.tenantId,
        projectId: input.projectId,
        adoptionId: adoption.id,
        actorUserId: input.identityUserId,
        action: input.decision === "approve" ? "PROJECT_ADOPTION_APPROVED" : "PROJECT_ADOPTION_REJECTED",
        targetType: "project_organization_adoption",
        targetId: adoption.id,
        metadata: { projectId: input.projectId, status: input.decision === "approve" ? "approved" : "rejected" } as Prisma.InputJsonValue
      } });
      return { id: adoption.id, status: input.decision === "approve" ? "approved" : "rejected" };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof ProjectAdoptionError) throw error;
      if (adoptionConflict(error)) throw new ProjectAdoptionError(409, "Project adoption changed concurrently.");
      throw error;
    }
  }

  private async requireIntegrationManager(tx: Prisma.TransactionClient, userId: string, organizationId: string): Promise<void> {
    const membership = await tx.organizationMember.findFirst({
      where: {
        organizationId, userId, status: "active",
        user: { is: { status: "active" } },
        organization: { is: { status: "active" } }
      }, select: { role: true }
    });
    if (!membership || !hasOrganizationPermission(membership.role, "organization:integrations:manage")) {
      throw new ProjectAdoptionError(403, "Forbidden: organization integration management permission is required.");
    }
  }
}
