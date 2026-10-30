/**
 * AuditRepository — append-only audit event persistence for Phase 07.
 * Uses the Phase 06/07 PostgreSQL audit_events table.
 */

import { PrismaClient, AuditEvent, Prisma } from "@prisma/client";

export interface RecordAuditInput {
  tenantId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  projectId?: string;
  metadata?: unknown;
}

export class AuditRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Appends an audit event. Audit records are strictly append-only.
   */
  async record(input: RecordAuditInput): Promise<AuditEvent> {
    return this.prisma.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorId: input.actorId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        projectId: input.projectId ?? null,
        metadataJson: (input.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull
      }
    });
  }
}
