-- Add nullable organization ownership without backfilling or changing legacy Tenant ownership.
ALTER TABLE "projects" ADD COLUMN "organization_id" UUID;
ALTER TABLE "scans" ADD COLUMN "organization_id" UUID;
ALTER TABLE "findings" ADD COLUMN "organization_id" UUID;
ALTER TABLE "remediations" ADD COLUMN "organization_id" UUID;
ALTER TABLE "audit_events"
  ADD COLUMN "organization_id" UUID,
  ADD COLUMN "actor_identity_user_id" UUID,
  ADD COLUMN "adoption_id" UUID;
ALTER TABLE "organization_audit_events"
  ADD COLUMN "tenant_id" TEXT,
  ADD COLUMN "project_id" TEXT,
  ADD COLUMN "adoption_id" UUID;

-- Composite parent keys bind every adopted child to the same tenant, organization, and project chain.
CREATE UNIQUE INDEX "uq_projects_tenant_org_id" ON "projects"("tenant_id", "organization_id", "id");
CREATE UNIQUE INDEX "uq_scans_tenant_org_project_id" ON "scans"("tenant_id", "organization_id", "project_id", "id");
CREATE UNIQUE INDEX "uq_findings_tenant_org_project_scan_id" ON "findings"("tenant_id", "organization_id", "project_id", "scan_id", "id");

CREATE TABLE "project_organization_adoptions" (
  "id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "organization_id" UUID NOT NULL,
  "requested_by_identity_user_id" UUID NOT NULL,
  "approved_by_identity_user_id" UUID,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "approved_at" TIMESTAMP(3),
  "rejected_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "idempotency_key" VARCHAR(128) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "provenance" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_organization_adoptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ck_project_adoptions_status" CHECK ("status" IN ('pending', 'approved', 'rejected', 'revoked')),
  CONSTRAINT "ck_project_adoptions_idempotency_key" CHECK (
    char_length("idempotency_key") BETWEEN 1 AND 128
    AND "idempotency_key" = btrim("idempotency_key")
    AND "idempotency_key" ~ '^[A-Za-z0-9._:-]+$'
  ),
  CONSTRAINT "ck_project_adoptions_request_hash" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ck_project_adoptions_provenance_object" CHECK (jsonb_typeof("provenance") = 'object'),
  CONSTRAINT "ck_project_adoptions_state_timestamps" CHECK (
    ("status" = 'pending' AND "approved_by_identity_user_id" IS NULL AND "approved_at" IS NULL AND "rejected_at" IS NULL AND "revoked_at" IS NULL)
    OR ("status" = 'approved' AND "approved_by_identity_user_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "rejected_at" IS NULL AND "revoked_at" IS NULL)
    OR ("status" = 'rejected' AND "approved_by_identity_user_id" IS NULL AND "approved_at" IS NULL AND "rejected_at" IS NOT NULL AND "revoked_at" IS NULL)
    OR ("status" = 'revoked' AND "approved_by_identity_user_id" IS NULL AND "approved_at" IS NULL AND "rejected_at" IS NULL AND "revoked_at" IS NOT NULL)
  ),
  CONSTRAINT "uq_project_adoptions_requester_idempotency" UNIQUE ("requested_by_identity_user_id", "idempotency_key"),
  CONSTRAINT "uq_project_adoptions_tenant_org_project_id" UNIQUE ("tenant_id", "organization_id", "project_id", "id"),
  CONSTRAINT "fk_project_adoptions_tenant" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "fk_project_adoptions_project" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "fk_project_adoptions_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "fk_project_adoptions_requester" FOREIGN KEY ("requested_by_identity_user_id") REFERENCES "identity_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "fk_project_adoptions_approver" FOREIGN KEY ("approved_by_identity_user_id") REFERENCES "identity_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "idx_project_adoptions_project_created" ON "project_organization_adoptions"("tenant_id", "project_id", "created_at" DESC);
CREATE INDEX "idx_project_adoptions_org_status_created" ON "project_organization_adoptions"("organization_id", "status", "created_at" DESC);
CREATE UNIQUE INDEX "uq_project_adoptions_one_pending" ON "project_organization_adoptions"("tenant_id", "project_id") WHERE "status" = 'pending';

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "scans"
  ADD CONSTRAINT "scans_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "scans_tenant_id_organization_id_project_id_fkey" FOREIGN KEY ("tenant_id", "organization_id", "project_id") REFERENCES "projects"("tenant_id", "organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "findings"
  ADD CONSTRAINT "findings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "findings_tenant_id_organization_id_project_id_scan_id_fkey" FOREIGN KEY ("tenant_id", "organization_id", "project_id", "scan_id") REFERENCES "scans"("tenant_id", "organization_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "remediations"
  ADD CONSTRAINT "remediations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "remediations_tenant_id_organization_id_project_id_fkey" FOREIGN KEY ("tenant_id", "organization_id", "project_id") REFERENCES "projects"("tenant_id", "organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "remediations_tenant_id_organization_id_project_id_scan_id_fkey" FOREIGN KEY ("tenant_id", "organization_id", "project_id", "scan_id") REFERENCES "scans"("tenant_id", "organization_id", "project_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "remediations_tenant_id_organization_id_project_id_scan_id_finding_id_fkey" FOREIGN KEY ("tenant_id", "organization_id", "project_id", "scan_id", "finding_id") REFERENCES "findings"("tenant_id", "organization_id", "project_id", "scan_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "audit_events_actor_identity_user_id_fkey" FOREIGN KEY ("actor_identity_user_id") REFERENCES "identity_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "audit_events_adoption_id_fkey" FOREIGN KEY ("adoption_id") REFERENCES "project_organization_adoptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "audit_events_tenant_id_organization_id_project_id_fkey" FOREIGN KEY ("tenant_id", "organization_id", "project_id") REFERENCES "projects"("tenant_id", "organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_audit_events_adoption_context" CHECK (
    ("organization_id" IS NULL OR "project_id" IS NOT NULL)
    AND ("adoption_id" IS NULL OR ("organization_id" IS NOT NULL AND "project_id" IS NOT NULL))
  );
ALTER TABLE "organization_audit_events"
  ADD CONSTRAINT "organization_audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "organization_audit_events_adoption_id_fkey" FOREIGN KEY ("adoption_id") REFERENCES "project_organization_adoptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "org_audit_tenant_org_project_fkey" FOREIGN KEY ("tenant_id", "organization_id", "project_id") REFERENCES "projects"("tenant_id", "organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_org_audit_project_context" CHECK (
    ("tenant_id" IS NULL AND "project_id" IS NULL AND "adoption_id" IS NULL)
    OR ("tenant_id" IS NOT NULL AND "project_id" IS NOT NULL)
  );

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_tenant_id_organization_id_project_id_adoption_id_fkey" FOREIGN KEY ("tenant_id", "organization_id", "project_id", "adoption_id") REFERENCES "project_organization_adoptions"("tenant_id", "organization_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organization_audit_events"
  ADD CONSTRAINT "org_audit_tenant_org_project_adoption_fkey" FOREIGN KEY ("tenant_id", "organization_id", "project_id", "adoption_id") REFERENCES "project_organization_adoptions"("tenant_id", "organization_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
