-- Stage 3E.2.10.5E: durable state and append-only journal for artifact-only execution.
-- Historical remediation rows and immutable artifacts are not modified or backfilled.

CREATE UNIQUE INDEX "uq_remediations_execution_scope"
  ON "remediations"("tenant_id", "organization_id", "project_id", "id");
CREATE UNIQUE INDEX "uq_project_github_repo_installation_ref"
  ON "project_github_repositories"("tenant_id", "organization_id", "project_id", "id", "github_repository_id", "installation_record_id");

CREATE TABLE "remediation_executions" (
  "id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" TEXT NOT NULL,
  "remediation_id" TEXT NOT NULL,
  "repository_binding_id" UUID NOT NULL,
  "installation_record_id" UUID NOT NULL,
  "github_repository_id" BIGINT NOT NULL,
  "artifact_hash" VARCHAR(64) NOT NULL,
  "base_ref" VARCHAR(255) NOT NULL,
  "base_commit_sha" VARCHAR(40) NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'queued',
  "stage" VARCHAR(32),
  "attempt_number" INTEGER NOT NULL DEFAULT 1,
  "version" BIGINT NOT NULL DEFAULT 0,
  "lease_owner" VARCHAR(200),
  "lease_token_hash" CHAR(64),
  "lease_expires_at" TIMESTAMP(3),
  "commit_sha" VARCHAR(40),
  "branch_name" VARCHAR(255),
  "branch_verified_at" TIMESTAMP(3),
  "pull_request_number" INTEGER,
  "pull_request_url" VARCHAR(2048),
  "pull_request_verified_at" TIMESTAMP(3),
  "failure_stage" VARCHAR(32),
  "failure_code" VARCHAR(64),
  "started_at" TIMESTAMP(3),
  "commit_verified_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "manual_review_at" TIMESTAMP(3),
  "reconciliation_status" VARCHAR(24) NOT NULL DEFAULT 'not_required',
  "reconciliation_started_at" TIMESTAMP(3),
  "reconciled_at" TIMESTAMP(3),
  "reconciliation_outcome" VARCHAR(32),
  "reconciliation_actor_id" UUID,
  "reconciliation_lease_hash" CHAR(64),
  "reconciliation_lease_until" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "remediation_executions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "remediation_executions_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "remediation_executions_organization_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "remediation_executions_project_fkey"
    FOREIGN KEY ("tenant_id", "organization_id", "project_id")
    REFERENCES "projects"("tenant_id", "organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "remediation_executions_remediation_fkey"
    FOREIGN KEY ("tenant_id", "organization_id", "project_id", "remediation_id")
    REFERENCES "remediations"("tenant_id", "organization_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "remediation_executions_binding_fkey"
    FOREIGN KEY ("tenant_id", "organization_id", "project_id", "repository_binding_id", "github_repository_id", "installation_record_id")
    REFERENCES "project_github_repositories"("tenant_id", "organization_id", "project_id", "id", "github_repository_id", "installation_record_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "remediation_executions_installation_fkey"
    FOREIGN KEY ("organization_id", "installation_record_id")
    REFERENCES "organization_github_installations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "remediation_executions_reconcile_actor_fkey"
    FOREIGN KEY ("reconciliation_actor_id") REFERENCES "identity_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ck_remediation_executions_status" CHECK ("status" IN (
    'queued', 'execution_started', 'commit_verified', 'branch_verified', 'draft_pr_verified', 'completed',
    'failed', 'manual_review_required', 'reconciliation_in_progress', 'reconciliation_resolved'
  )),
  CONSTRAINT "ck_remediation_executions_stage" CHECK ("stage" IS NULL OR "stage" IN (
    'execution', 'blob', 'tree', 'commit', 'branch', 'pull_request', 'pull_request_close', 'reconciliation'
  )),
  CONSTRAINT "ck_remediation_executions_failure" CHECK (
    ("failure_stage" IS NULL OR "failure_stage" IN ('execution', 'blob', 'tree', 'commit', 'branch', 'pull_request', 'pull_request_close', 'reconciliation'))
    AND ("failure_code" IS NULL OR "failure_code" IN (
      'ambiguous_blob_write', 'ambiguous_branch_creation', 'ambiguous_commit_write', 'ambiguous_pull_request_creation',
      'ambiguous_remote_operation', 'ambiguous_tree_write', 'authorization_unavailable', 'base_mismatch_draft_closed',
      'base_moved_before_pull_request', 'base_moved_draft_close_failed', 'base_moved_draft_closed', 'base_moved_existing_draft',
      'base_ref_moved', 'branch_conflict', 'cancelled', 'capability_unavailable', 'claim_not_authorized', 'execution_conflict',
      'execution_failed', 'github_read_failed', 'github_request_failed', 'github_write_rejected', 'intent_conflict',
      'invalid_claim', 'invalid_input', 'invalid_response', 'invalid_transition', 'invalid_token', 'invalid_trust_input',
      'lease_guard_unavailable', 'lease_lost', 'lease_lost_after_write', 'network_failure', 'not_found',
      'post_write_verification_failed', 'pull_request_conflict', 'pull_request_verification_failed', 'reconciliation_not_authorized',
      'source_state_mismatch', 'timeout', 'unverified_write_result', 'upstream_failure', 'writer_unavailable', 'publisher_unavailable'
    ))
  ),
  CONSTRAINT "ck_remediation_executions_branch" CHECK (
    "branch_name" IS NULL OR "branch_name" ~ '^cloudpilot/remediation/[0-9a-f]{40}$'
  ),
  CONSTRAINT "ck_remediation_executions_reconciliation" CHECK (
    "reconciliation_status" IN ('not_required', 'required', 'in_progress', 'resolved')
    AND (("reconciliation_status" = 'not_required' AND "reconciliation_started_at" IS NULL AND "reconciled_at" IS NULL
          AND "reconciliation_outcome" IS NULL AND "reconciliation_actor_id" IS NULL
          AND "reconciliation_lease_hash" IS NULL AND "reconciliation_lease_until" IS NULL)
      OR ("reconciliation_status" = 'required' AND "reconciled_at" IS NULL AND "reconciliation_outcome" IS NULL
          AND "reconciliation_lease_hash" IS NULL AND "reconciliation_lease_until" IS NULL)
      OR ("reconciliation_status" = 'in_progress' AND "reconciliation_started_at" IS NOT NULL
          AND "reconciliation_actor_id" IS NOT NULL AND "reconciliation_lease_hash" ~ '^[0-9a-f]{64}$'
          AND "reconciliation_lease_until" IS NOT NULL AND "reconciled_at" IS NULL)
      OR ("reconciliation_status" = 'resolved' AND "reconciliation_started_at" IS NOT NULL
          AND "reconciled_at" IS NOT NULL AND "reconciliation_outcome" IN ('completed', 'failed', 'manual_review_required')
          AND "reconciliation_actor_id" IS NOT NULL AND "reconciliation_lease_hash" IS NULL
          AND "reconciliation_lease_until" IS NULL))
  ),
  CONSTRAINT "ck_remediation_executions_identity" CHECK (
    "github_repository_id" > 0 AND "attempt_number" > 0 AND "version" >= 0
    AND "artifact_hash" ~ '^[0-9a-f]{64}$'
    AND "base_commit_sha" ~ '^[0-9a-f]{40}$'
    AND length("base_ref") BETWEEN 1 AND 255 AND btrim("base_ref") = "base_ref"
  ),
  CONSTRAINT "ck_remediation_executions_lease" CHECK (
    ("lease_owner" IS NULL AND "lease_token_hash" IS NULL AND "lease_expires_at" IS NULL)
    OR ("lease_owner" IS NOT NULL AND "lease_token_hash" IS NOT NULL AND "lease_expires_at" IS NOT NULL
        AND btrim("lease_owner") <> ''
        AND "lease_token_hash" ~ '^[0-9a-f]{64}$' AND "lease_expires_at" IS NOT NULL)
  ),
  CONSTRAINT "ck_remediation_executions_reconciliation_lease" CHECK (
    ("reconciliation_lease_hash" IS NULL AND "reconciliation_lease_until" IS NULL)
    OR ("reconciliation_lease_hash" IS NOT NULL AND "reconciliation_lease_until" IS NOT NULL
        AND "reconciliation_lease_hash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "ck_remediation_executions_pr_pair" CHECK (
    ("pull_request_number" IS NULL AND "pull_request_url" IS NULL)
    OR ("pull_request_number" IS NOT NULL AND "pull_request_url" IS NOT NULL AND "pull_request_number" > 0
        AND "pull_request_url" ~ '^https://github\.com/[^/]+/[^/]+/pull/[1-9][0-9]*$')
  ),
  CONSTRAINT "ck_remediation_executions_verified_state" CHECK (
    ("status" NOT IN ('commit_verified', 'branch_verified', 'draft_pr_verified', 'completed')
      OR ("commit_sha" IS NOT NULL AND "commit_verified_at" IS NOT NULL AND "commit_sha" ~ '^[0-9a-f]{40}$'))
    AND ("status" NOT IN ('branch_verified', 'draft_pr_verified', 'completed')
      OR ("branch_name" IS NOT NULL AND "branch_verified_at" IS NOT NULL))
    AND ("status" NOT IN ('draft_pr_verified', 'completed')
      OR ("pull_request_number" IS NOT NULL AND "pull_request_url" IS NOT NULL
          AND "pull_request_verified_at" IS NOT NULL))
    AND ("status" <> 'completed' OR ("completed_at" IS NOT NULL AND "lease_owner" IS NULL
          AND "reconciliation_status" IN ('not_required', 'resolved')))
    AND ("status" <> 'manual_review_required' OR ("manual_review_at" IS NOT NULL
          AND "reconciliation_status" IN ('required', 'in_progress', 'resolved')))
    AND ("status" <> 'reconciliation_in_progress' OR "reconciliation_status" = 'in_progress')
    AND ("status" <> 'reconciliation_resolved' OR "reconciliation_status" = 'resolved')
  )
);

CREATE UNIQUE INDEX "uq_remediation_executions_proposal"
  ON "remediation_executions"("tenant_id", "organization_id", "project_id", "remediation_id");
CREATE UNIQUE INDEX "uq_remediation_executions_scope_ref"
  ON "remediation_executions"("tenant_id", "organization_id", "project_id", "remediation_id", "id");
CREATE UNIQUE INDEX "uq_remediation_executions_github_pr"
  ON "remediation_executions"("github_repository_id", "pull_request_number");
CREATE INDEX "idx_remediation_executions_status_updated"
  ON "remediation_executions"("status", "updated_at");
CREATE INDEX "idx_remediation_executions_org_status"
  ON "remediation_executions"("organization_id", "status", "updated_at");
CREATE INDEX "idx_remediation_executions_lease_expiry"
  ON "remediation_executions"("lease_expires_at");

CREATE TABLE "remediation_execution_events" (
  "id" UUID NOT NULL,
  "execution_id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" TEXT NOT NULL,
  "remediation_id" TEXT NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "sequence_number" INTEGER NOT NULL,
  "event_type" VARCHAR(48) NOT NULL,
  "stage" VARCHAR(32) NOT NULL,
  "operation_key" VARCHAR(128),
  "request_hash" CHAR(64),
  "remote_resource_type" VARCHAR(32),
  "remote_resource_id" VARCHAR(128),
  "commit_sha" VARCHAR(40),
  "branch_name" VARCHAR(255),
  "pull_request_number" INTEGER,
  "pull_request_url" VARCHAR(2048),
  "error_code" VARCHAR(64),
  "actor_type" VARCHAR(16) NOT NULL DEFAULT 'system',
  "actor_user_id" UUID,
  "system_actor_id" VARCHAR(64),
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "remediation_execution_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "remediation_execution_events_execution_fkey"
    FOREIGN KEY ("tenant_id", "organization_id", "project_id", "remediation_id", "execution_id")
    REFERENCES "remediation_executions"("tenant_id", "organization_id", "project_id", "remediation_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "remediation_execution_events_actor_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "identity_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "remediation_execution_events_actor_org_fkey"
    FOREIGN KEY ("organization_id", "actor_user_id") REFERENCES "organization_members"("organization_id", "user_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ck_remediation_execution_events_sequence" CHECK ("attempt_number" > 0 AND "sequence_number" > 0),
  CONSTRAINT "ck_remediation_execution_events_type" CHECK ("event_type" IN (
    'execution_started', 'request_intent', 'remote_result_verified', 'execution_failed',
    'execution_completed', 'manual_review_required', 'reconciliation_started', 'reconciliation_resolved'
  )),
  CONSTRAINT "ck_remediation_execution_events_stage" CHECK ("stage" IN (
    'execution', 'blob', 'tree', 'commit', 'branch', 'pull_request', 'pull_request_close', 'reconciliation'
  )),
  CONSTRAINT "ck_remediation_execution_events_request_hash" CHECK (
    "request_hash" IS NULL OR "request_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "ck_remediation_execution_events_operation" CHECK (
    "operation_key" IS NULL OR "operation_key" ~ '^[A-Za-z0-9._:-]{1,128}$'
  ),
  CONSTRAINT "ck_remediation_execution_events_error_code" CHECK (
    "error_code" IS NULL OR "error_code" IN (
      'ambiguous_blob_write', 'ambiguous_branch_creation', 'ambiguous_commit_write', 'ambiguous_pull_request_creation',
      'ambiguous_remote_operation', 'ambiguous_tree_write', 'authorization_unavailable', 'base_mismatch_draft_closed',
      'base_moved_before_pull_request', 'base_moved_draft_close_failed', 'base_moved_draft_closed', 'base_moved_existing_draft',
      'base_ref_moved', 'branch_conflict', 'cancelled', 'capability_unavailable', 'claim_not_authorized', 'execution_conflict',
      'execution_failed', 'github_read_failed', 'github_request_failed', 'github_write_rejected', 'intent_conflict',
      'invalid_claim', 'invalid_input', 'invalid_response', 'invalid_transition', 'invalid_token', 'invalid_trust_input',
      'lease_guard_unavailable', 'lease_lost', 'lease_lost_after_write', 'network_failure', 'not_found',
      'post_write_verification_failed', 'pull_request_conflict', 'pull_request_verification_failed', 'reconciliation_not_authorized',
      'source_state_mismatch', 'timeout', 'unverified_write_result', 'upstream_failure', 'writer_unavailable', 'publisher_unavailable'
    )
  ),
  CONSTRAINT "ck_remediation_execution_events_remote_type" CHECK (
    "remote_resource_type" IS NULL OR "remote_resource_type" IN ('blob', 'tree', 'commit', 'branch', 'pull_request', 'pull_request_close')
  ),
  CONSTRAINT "ck_remediation_execution_events_metadata" CHECK (
    jsonb_typeof("metadata") = 'object' AND octet_length("metadata"::text) <= 16384
  ),
  CONSTRAINT "ck_remediation_execution_events_actor" CHECK (
    ("actor_type" = 'user' AND "actor_user_id" IS NOT NULL AND "system_actor_id" IS NULL)
    OR ("actor_type" = 'system' AND "actor_user_id" IS NULL AND "system_actor_id" IS NOT NULL
        AND "system_actor_id" = btrim("system_actor_id")
        AND "system_actor_id" ~ '^[a-z][a-z0-9_.:-]{0,63}$')
  ),
  CONSTRAINT "ck_remediation_execution_events_pr_pair" CHECK (
    ("pull_request_number" IS NULL AND "pull_request_url" IS NULL)
    OR ("pull_request_number" IS NOT NULL AND "pull_request_url" IS NOT NULL AND "pull_request_number" > 0
        AND "pull_request_url" ~ '^https://github\.com/[^/]+/[^/]+/pull/[1-9][0-9]*$')
  ),
  CONSTRAINT "ck_remediation_execution_events_commit_sha" CHECK (
    "commit_sha" IS NULL OR "commit_sha" ~ '^[0-9a-f]{40}$'
  )
);

CREATE UNIQUE INDEX "uq_remediation_execution_events_sequence"
  ON "remediation_execution_events"("execution_id", "attempt_number", "sequence_number");
CREATE UNIQUE INDEX "uq_remediation_execution_events_operation"
  ON "remediation_execution_events"("execution_id", "attempt_number", "operation_key", "event_type");
CREATE INDEX "idx_remediation_execution_events_scope_time"
  ON "remediation_execution_events"("tenant_id", "organization_id", "project_id", "remediation_id", "created_at");

CREATE FUNCTION prevent_remediation_execution_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'remediation execution events are append-only';
END;
$$;

CREATE TRIGGER "trg_remediation_execution_events_append_only"
  BEFORE UPDATE OR DELETE ON "remediation_execution_events"
  FOR EACH ROW EXECUTE FUNCTION prevent_remediation_execution_event_mutation();

CREATE TRIGGER "trg_remediation_execution_events_no_truncate"
  BEFORE TRUNCATE ON "remediation_execution_events"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_remediation_execution_event_mutation();

-- Runtime role must not own these tables and must have no UPDATE, DELETE, TRUNCATE,
-- ALTER, or trigger-management privileges. The row/statement triggers are defense in depth.
