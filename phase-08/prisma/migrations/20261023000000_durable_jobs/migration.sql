-- AlterTable scans
ALTER TABLE "scans" ADD COLUMN "worker_id" TEXT;
ALTER TABLE "scans" ADD COLUMN "claimed_at" TIMESTAMP(3);
ALTER TABLE "scans" ADD COLUMN "heartbeat_at" TIMESTAMP(3);
ALTER TABLE "scans" ADD COLUMN "lease_expires_at" TIMESTAMP(3);
ALTER TABLE "scans" ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "scans" ADD COLUMN "max_attempts" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "scans" ADD COLUMN "model_override" JSONB;

-- AlterTable findings
ALTER TABLE "findings" ADD COLUMN "attempt_number" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex: Partial index for pending jobs queue
CREATE INDEX "idx_scans_queue_pending" ON "scans"("created_at" ASC) WHERE status = 'pending';

-- CreateIndex: Partial index for expired lease recovery
CREATE INDEX "idx_scans_lease_expired" ON "scans"("lease_expires_at" ASC) WHERE status = 'running';

-- CreateIndex: Finding attempt index
CREATE INDEX "idx_findings_scan_attempt" ON "findings"("tenant_id", "scan_id", "attempt_number");
