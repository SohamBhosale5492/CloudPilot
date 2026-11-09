-- Phase 3: Dedicated system recovery lease for automated restart-safe recovery.
-- Separate from the human reconciliation lease (reconciliation_lease_hash / reconciliation_lease_until).
-- System recovery is READ-ONLY against GitHub and must never acquire reconciliation authority.

ALTER TABLE "remediation_executions"
  ADD COLUMN "recovery_lease_hash"  CHAR(64)      DEFAULT NULL,
  ADD COLUMN "recovery_lease_until" TIMESTAMP(3)  DEFAULT NULL,
  ADD COLUMN "recovery_lease_owner" VARCHAR(200)  DEFAULT NULL;

ALTER TABLE "remediation_executions"
  ADD CONSTRAINT "ck_remediation_executions_recovery_lease" CHECK (
    ("recovery_lease_hash" IS NULL AND "recovery_lease_until" IS NULL AND "recovery_lease_owner" IS NULL)
    OR ("recovery_lease_hash" IS NOT NULL AND "recovery_lease_until" IS NOT NULL AND "recovery_lease_owner" IS NOT NULL
        AND "recovery_lease_hash" ~ '^[0-9a-f]{64}$' AND btrim("recovery_lease_owner") <> '')
  );

CREATE INDEX "idx_remediation_executions_recovery_lease_expiry"
  ON "remediation_executions"("recovery_lease_until")
  WHERE "recovery_lease_until" IS NOT NULL;
