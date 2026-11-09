-- Add per-claim fencing for Phase 06 scans. Existing rows remain compatible;
-- new claims receive a token atomically from the worker claim operation.
ALTER TABLE "scans"
  ADD COLUMN "lease_token" UUID;
