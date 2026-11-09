-- Align the journal's shared remote-resource type allowlist with the
-- github_mutation sentinel required by remote_mutation_rejected events.
-- Existing event rows and append-only protections remain unchanged.
ALTER TABLE "remediation_execution_events"
  DROP CONSTRAINT "ck_remediation_execution_events_remote_type";

ALTER TABLE "remediation_execution_events"
  ADD CONSTRAINT "ck_remediation_execution_events_remote_type" CHECK (
    "remote_resource_type" IS NULL OR "remote_resource_type" IN (
      'blob', 'tree', 'commit', 'branch', 'pull_request', 'pull_request_close', 'github_mutation'
    )
  );
