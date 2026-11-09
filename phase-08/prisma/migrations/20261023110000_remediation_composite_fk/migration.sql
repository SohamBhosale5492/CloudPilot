-- Phase 07: Enforce composite tenant integrity for findings and remediations
-- 1. Ensure findings has @@unique([tenantId, id]) to allow composite foreign key reference
CREATE UNIQUE INDEX IF NOT EXISTS "findings_tenant_id_id_key" ON "findings"("tenant_id", "id");

-- 2. Ensure remediations has @@unique([tenantId, id])
CREATE UNIQUE INDEX IF NOT EXISTS "remediations_tenant_id_id_key" ON "remediations"("tenant_id", "id");

-- 3. Replace single-column foreign key with composite foreign key (tenant_id, finding_id) -> findings(tenant_id, id)
ALTER TABLE "remediations" DROP CONSTRAINT IF EXISTS "remediations_finding_id_fkey";

ALTER TABLE "remediations" ADD CONSTRAINT "remediations_tenant_id_finding_id_fkey"
    FOREIGN KEY ("tenant_id", "finding_id") REFERENCES "findings"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
