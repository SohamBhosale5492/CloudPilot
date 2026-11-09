-- Durable bounded retries for definitive GitHub rate-limit rejections.
-- This migration is additive and is not applied by this change.
ALTER TABLE "remediation_executions"
  ADD COLUMN "retry_eligible_at" TIMESTAMP(3);

ALTER TABLE "remediation_executions"
  ADD CONSTRAINT "ck_remediation_execution_retry_state" CHECK (
    "retry_eligible_at" IS NULL OR (
      "status" = 'failed' AND "failure_code" = 'rate_limited'
      AND "lease_owner" IS NULL AND "lease_token_hash" IS NULL AND "lease_expires_at" IS NULL
      AND "reconciliation_status" = 'not_required' AND "completed_at" IS NULL
    )
  );

CREATE INDEX "idx_remediation_executions_retry_eligible"
  ON "remediation_executions"("retry_eligible_at")
  WHERE "retry_eligible_at" IS NOT NULL;

ALTER TABLE "remediation_execution_events"
  DROP CONSTRAINT "ck_remediation_execution_events_type";

ALTER TABLE "remediation_execution_events"
  ADD CONSTRAINT "ck_remediation_execution_events_type" CHECK ("event_type" IN (
    'execution_started', 'request_intent', 'remote_result_verified', 'remote_mutation_rejected',
    'execution_retry_scheduled', 'execution_failed', 'execution_completed', 'manual_review_required',
    'reconciliation_started', 'reconciliation_resolved'
  ));

ALTER TABLE "remediation_execution_events"
  ADD CONSTRAINT "ck_remediation_execution_events_retry" CHECK (
    "event_type" <> 'execution_retry_scheduled' OR (
      "stage" IN ('blob', 'tree', 'commit', 'branch', 'pull_request', 'pull_request_close')
      AND "operation_key" IS NOT NULL AND "request_hash" IS NOT NULL AND "error_code" = 'rate_limited'
      AND "metadata" ? 'retryOrdinal'
      AND jsonb_typeof("metadata"->'retryOrdinal') = 'number'
      AND ("metadata"->>'retryOrdinal') ~ '^[1-3]$'
      AND "metadata" ? 'retryAfterMs'
      AND jsonb_typeof("metadata"->'retryAfterMs') = 'number'
      AND ("metadata"->>'retryAfterMs') ~ '^(1000|[1-9][0-9]{0,3}|[1-5][0-9]{4}|60000)$'
      AND ("metadata"->>'retryAfterMs')::bigint BETWEEN 1000 AND 60000
      AND "metadata" ? 'retryAt'
      AND jsonb_typeof("metadata"->'retryAt') = 'string'
      AND ("metadata"->>'retryAt') ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    )
  );
