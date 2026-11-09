-- Phase 08: Worker leases and retry scheduling for durable background remediation
ALTER TABLE "remediations"
  ADD COLUMN "worker_id" TEXT,
  ADD COLUMN "claimed_at" TIMESTAMP(3),
  ADD COLUMN "heartbeat_at" TIMESTAMP(3),
  ADD COLUMN "lease_expires_at" TIMESTAMP(3),
  ADD COLUMN "next_attempt_at" TIMESTAMP(3);

CREATE INDEX "idx_remediations_lease_expires" ON "remediations"("lease_expires_at");
CREATE INDEX "idx_remediations_next_attempt" ON "remediations"("next_attempt_at");
