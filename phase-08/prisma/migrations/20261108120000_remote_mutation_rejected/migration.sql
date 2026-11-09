-- Add a durable terminal outcome for a mutation that GitHub definitively rejected.
-- Existing journal rows are preserved; this is an additive allowlist extension.
ALTER TABLE "remediation_execution_events"
  DROP CONSTRAINT "ck_remediation_execution_events_type";

ALTER TABLE "remediation_execution_events"
  ADD CONSTRAINT "ck_remediation_execution_events_type" CHECK ("event_type" IN (
    'execution_started', 'request_intent', 'remote_result_verified', 'remote_mutation_rejected',
    'execution_failed', 'execution_completed', 'manual_review_required', 'reconciliation_started',
    'reconciliation_resolved'
  ));

ALTER TABLE "remediation_execution_events"
  ADD CONSTRAINT "ck_remediation_execution_events_rejection" CHECK (
    "event_type" <> 'remote_mutation_rejected' OR (
      "stage" IN ('blob', 'tree', 'commit', 'branch', 'pull_request', 'pull_request_close')
      AND "operation_key" IS NOT NULL
      AND "request_hash" IS NOT NULL
      AND "error_code" = 'rate_limited'
      AND "remote_resource_type" = 'github_mutation'
      AND "metadata" ? 'rejection'
      AND jsonb_typeof("metadata"->'rejection') = 'string'
      AND "metadata"->>'rejection' IN ('primary_rate_limit', 'secondary_rate_limit')
      AND "metadata" ? 'requestFingerprint'
      AND "metadata"->>'requestFingerprint' ~ '^[0-9a-f]{64}$'
      AND (
        NOT ("metadata" ? 'retryAfterMs') OR
        (jsonb_typeof("metadata"->'retryAfterMs') = 'number'
          AND "metadata"->>'retryAfterMs' ~ '^(0|[1-9][0-9]{0,4}|60000)$'
          AND ("metadata"->>'retryAfterMs')::bigint <= 60000)
      )
    )
  );

-- Keep SQL persistence allowlists aligned with the safe application codes.
-- These additions permit the rejection event's bounded rate-limit code and
-- the existing recovery-lease failure code without altering historical rows.
ALTER TABLE "remediation_executions"
  DROP CONSTRAINT "ck_remediation_executions_failure";

ALTER TABLE "remediation_executions"
  ADD CONSTRAINT "ck_remediation_executions_failure" CHECK (
    ("failure_stage" IS NULL OR "failure_stage" IN ('execution', 'blob', 'tree', 'commit', 'branch', 'pull_request', 'pull_request_close', 'reconciliation'))
    AND ("failure_code" IS NULL OR "failure_code" IN (
      'ambiguous_blob_write', 'ambiguous_branch_creation', 'ambiguous_commit_write', 'ambiguous_pull_request_creation',
      'ambiguous_remote_operation', 'ambiguous_tree_write', 'authorization_unavailable', 'base_mismatch_draft_closed',
      'base_moved_before_pull_request', 'base_moved_draft_close_failed', 'base_moved_draft_closed', 'base_moved_existing_draft',
      'base_ref_moved', 'branch_conflict', 'cancelled', 'capability_unavailable', 'claim_not_authorized', 'execution_conflict',
      'execution_failed', 'github_read_failed', 'github_request_failed', 'github_write_rejected', 'intent_conflict',
      'invalid_claim', 'invalid_input', 'invalid_response', 'invalid_transition', 'invalid_token', 'invalid_trust_input',
      'lease_guard_unavailable', 'lease_lost', 'lease_lost_after_write', 'network_failure', 'not_found',
      'post_write_verification_failed', 'pull_request_conflict', 'pull_request_verification_failed', 'rate_limited',
      'reconciliation_not_authorized', 'source_state_mismatch', 'timeout', 'unverified_write_result', 'upstream_failure',
      'writer_unavailable', 'publisher_unavailable', 'recovery_lease_unavailable'
    ))
  );

ALTER TABLE "remediation_execution_events"
  DROP CONSTRAINT "ck_remediation_execution_events_error_code";

ALTER TABLE "remediation_execution_events"
  ADD CONSTRAINT "ck_remediation_execution_events_error_code" CHECK (
    "error_code" IS NULL OR "error_code" IN (
      'ambiguous_blob_write', 'ambiguous_branch_creation', 'ambiguous_commit_write', 'ambiguous_pull_request_creation',
      'ambiguous_remote_operation', 'ambiguous_tree_write', 'authorization_unavailable', 'base_mismatch_draft_closed',
      'base_moved_before_pull_request', 'base_moved_draft_close_failed', 'base_moved_draft_closed', 'base_moved_existing_draft',
      'base_ref_moved', 'branch_conflict', 'cancelled', 'capability_unavailable', 'claim_not_authorized', 'execution_conflict',
      'execution_failed', 'github_read_failed', 'github_request_failed', 'github_write_rejected', 'intent_conflict',
      'invalid_claim', 'invalid_input', 'invalid_response', 'invalid_transition', 'invalid_token', 'invalid_trust_input',
      'lease_guard_unavailable', 'lease_lost', 'lease_lost_after_write', 'network_failure', 'not_found',
      'post_write_verification_failed', 'pull_request_conflict', 'pull_request_verification_failed', 'rate_limited',
      'reconciliation_not_authorized', 'source_state_mismatch', 'timeout', 'unverified_write_result', 'upstream_failure',
      'writer_unavailable', 'publisher_unavailable', 'recovery_lease_unavailable'
    )
  );
