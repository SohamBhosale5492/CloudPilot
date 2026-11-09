-- Phase 07: Remediation table
-- Additive-only migration: adds the remediations table with idempotency key,
-- branch/PR tracking, retry budget, and tenant cascade delete.
-- Safe to apply against existing Phase 06 data with zero data loss.

CREATE TABLE "remediations" (
    "id"               TEXT NOT NULL,
    "tenant_id"        TEXT NOT NULL,
    "project_id"       TEXT NOT NULL,
    "scan_id"          TEXT NOT NULL,
    "finding_id"       TEXT NOT NULL,
    "idempotency_key"  TEXT NOT NULL,
    "status"           TEXT NOT NULL DEFAULT 'pending',
    "branch_name"      TEXT,
    "pr_number"        INTEGER,
    "pr_url"           TEXT,
    "patch_summary"    TEXT,
    "error_message"    TEXT,
    "retries_left"     INTEGER NOT NULL DEFAULT 3,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "remediations_pkey" PRIMARY KEY ("id")
);

-- Unique idempotency key prevents duplicate remediation PRs for the same finding
CREATE UNIQUE INDEX "remediations_idempotency_key_key" ON "remediations"("idempotency_key");

-- Partial index for pending queue polling
CREATE INDEX "idx_remediations_status"        ON "remediations"("status");
CREATE INDEX "idx_remediations_tenant_project" ON "remediations"("tenant_id", "project_id", "created_at" DESC);
CREATE INDEX "idx_remediations_tenant_scan"    ON "remediations"("tenant_id", "scan_id");

-- Foreign keys
ALTER TABLE "remediations" ADD CONSTRAINT "remediations_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "remediations" ADD CONSTRAINT "remediations_tenant_id_project_id_fkey"
    FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "remediations" ADD CONSTRAINT "remediations_tenant_id_scan_id_fkey"
    FOREIGN KEY ("tenant_id", "scan_id") REFERENCES "scans"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "remediations" ADD CONSTRAINT "remediations_finding_id_fkey"
    FOREIGN KEY ("finding_id") REFERENCES "findings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Trigger to auto-update updated_at on row modification
CREATE OR REPLACE FUNCTION update_remediations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER remediations_updated_at_trigger
    BEFORE UPDATE ON "remediations"
    FOR EACH ROW EXECUTE FUNCTION update_remediations_updated_at();
