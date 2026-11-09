-- Phase 08: unique fencing token for each remediation lease claim.
ALTER TABLE "remediations"
  ADD COLUMN "lease_token" UUID;
