-- Run only in a database dedicated to CloudPilot, as a DBA/migration owner.
-- This script does not create roles, set passwords, transfer ownership, or
-- change PUBLIC privileges. Confirm the role has no inherited memberships
-- before applying; the checks below fail closed when it does.
BEGIN;
DO $cloudpilot$
DECLARE
  runtime_oid oid;
  role_super boolean;
  role_createdb boolean;
  role_createrole boolean;
  role_replication boolean;
  role_bypassrls boolean;
  role_inherit boolean;
BEGIN
  SELECT oid, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit
    INTO runtime_oid, role_super, role_createdb, role_createrole, role_replication, role_bypassrls, role_inherit
  FROM pg_catalog.pg_roles WHERE rolname = 'cloudpilot_runtime';
  IF runtime_oid IS NULL THEN RAISE EXCEPTION 'cloudpilot_runtime role must be provisioned first'; END IF;
  IF role_super OR role_createdb OR role_createrole OR role_replication OR role_bypassrls OR role_inherit THEN
    RAISE EXCEPTION 'cloudpilot_runtime has prohibited role attributes';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = runtime_oid) THEN
    RAISE EXCEPTION 'cloudpilot_runtime must not inherit any role memberships';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'cloudpilot_migrator') THEN
    RAISE EXCEPTION 'cloudpilot_migrator role must be provisioned first';
  END IF;
END;
$cloudpilot$;

REVOKE ALL ON SCHEMA public FROM cloudpilot_runtime;
GRANT USAGE ON SCHEMA public TO cloudpilot_runtime;
REVOKE CREATE ON SCHEMA public FROM cloudpilot_runtime;
DO $cloudpilot$
BEGIN
  IF has_schema_privilege('cloudpilot_runtime', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'cloudpilot_runtime still inherits CREATE on public; remove the scoped PUBLIC grant only after DBA confirms this is a dedicated CloudPilot database';
  END IF;
END;
$cloudpilot$;

REVOKE ALL PRIVILEGES ON TABLE
  public.tenants, public.users, public.projects, public.scans, public.findings,
  public.audit_events, public.remediations, public.identity_users, public.external_identities,
  public.organizations, public.organization_members, public.organization_audit_events,
  public.project_organization_adoptions, public.organization_github_installations,
  public.project_github_repositories, public.remediation_executions,
  public.remediation_execution_events, public.github_connect_intents,
  public.github_webhook_deliveries
FROM cloudpilot_runtime;
-- Prisma migration metadata is deployment-only, including on databases where
-- an older/manual grant may already exist.
REVOKE ALL PRIVILEGES ON TABLE public._prisma_migrations FROM cloudpilot_runtime;

GRANT SELECT ON TABLE
  public.projects, public.scans, public.findings, public.audit_events, public.remediations,
  public.identity_users, public.external_identities, public.organizations,
  public.organization_members, public.project_organization_adoptions,
  public.organization_github_installations, public.project_github_repositories,
  public.remediation_executions, public.remediation_execution_events,
  public.github_connect_intents
TO cloudpilot_runtime;

GRANT INSERT ON TABLE
  public.projects, public.scans, public.findings, public.audit_events, public.remediations,
  public.identity_users, public.external_identities, public.organizations,
  public.organization_members, public.organization_audit_events,
  public.project_organization_adoptions, public.organization_github_installations,
  public.project_github_repositories, public.remediation_executions,
  public.remediation_execution_events, public.github_connect_intents
TO cloudpilot_runtime;

-- Phase 06 supports explicit project deletion and removes partial scan findings
-- before retrying a scan. No other application table requires runtime DELETE.
GRANT DELETE ON TABLE public.projects, public.findings TO cloudpilot_runtime;

GRANT UPDATE (name, organization_id, repository_url, expected_model, target_config, updated_at)
  ON public.projects TO cloudpilot_runtime;
GRANT UPDATE (status, started_at, completed_at, error, triggered_by_id, worker_id, lease_token,
  claimed_at, heartbeat_at, lease_expires_at, attempt_count, max_attempts, model_override)
  ON public.scans TO cloudpilot_runtime;
GRANT UPDATE (requested_by_identity_user_id, repository_binding_id, github_repository_id,
  plan_hash, plan_snapshot, execution_artifact, execution_artifact_hash, approved_artifact_hash,
  approval_state, approved_by_identity_user_id, approved_at, rejected_by_identity_user_id,
  rejected_at, invalidated_by_identity_user_id, invalidated_at, status, branch_name, pr_number,
  pr_url, patch_summary, error_message, retries_left, worker_id, lease_token, claimed_at,
  heartbeat_at, lease_expires_at, next_attempt_at, updated_at)
  ON public.remediations TO cloudpilot_runtime;
GRANT UPDATE (last_authenticated_at, updated_at) ON public.identity_users TO cloudpilot_runtime;
GRANT UPDATE (last_authenticated_at) ON public.external_identities TO cloudpilot_runtime;
GRANT UPDATE (status, approved_by_identity_user_id, approved_at, rejected_at, revoked_at, updated_at)
  ON public.project_organization_adoptions TO cloudpilot_runtime;
GRANT UPDATE (status, disconnected_at, updated_at) ON public.project_github_repositories TO cloudpilot_runtime;
GRANT UPDATE (consumed_at) ON public.github_connect_intents TO cloudpilot_runtime;
GRANT UPDATE (status, stage, attempt_number, version, lease_owner, lease_token_hash, lease_expires_at,
  commit_sha, branch_name, branch_verified_at, pull_request_number, pull_request_url,
  pull_request_verified_at, failure_stage, failure_code, retry_eligible_at, started_at,
  commit_verified_at, completed_at, manual_review_at, reconciliation_status,
  reconciliation_started_at, reconciled_at, reconciliation_outcome, reconciliation_actor_id,
  reconciliation_lease_hash, reconciliation_lease_until, recovery_lease_hash,
  recovery_lease_until, recovery_lease_owner, updated_at)
  ON public.remediation_executions TO cloudpilot_runtime;

-- No runtime UPDATE/DELETE/TRUNCATE on these append-only records.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.remediation_execution_events,
  public.audit_events, public.organization_audit_events FROM cloudpilot_runtime;
REVOKE UPDATE ON TABLE public.findings, public.organizations, public.organization_members,
  public.organization_github_installations, public.tenants, public.users,
  public.github_webhook_deliveries FROM cloudpilot_runtime;
REVOKE DELETE, TRUNCATE ON TABLE
  public.scans, public.audit_events, public.remediations,
  public.identity_users, public.external_identities, public.organizations,
  public.organization_members, public.organization_audit_events,
  public.project_organization_adoptions, public.organization_github_installations,
  public.project_github_repositories, public.remediation_executions,
  public.remediation_execution_events, public.github_connect_intents,
  public.github_webhook_deliveries
FROM cloudpilot_runtime;
REVOKE TRUNCATE ON TABLE public.projects, public.findings FROM cloudpilot_runtime;

GRANT EXECUTE ON FUNCTION public.cloudpilot_lock_active_organization(uuid) TO cloudpilot_runtime;
GRANT EXECUTE ON FUNCTION public.cloudpilot_lock_active_member(uuid, uuid) TO cloudpilot_runtime;
GRANT EXECUTE ON FUNCTION public.cloudpilot_lock_active_actor_for_update(uuid, uuid) TO cloudpilot_runtime;
GRANT EXECUTE ON FUNCTION public.cloudpilot_lock_scoped_finding(text, text, text, text) TO cloudpilot_runtime;
GRANT EXECUTE ON FUNCTION public.cloudpilot_lock_active_binding_installation(text, uuid, text, uuid, uuid, bigint) TO cloudpilot_runtime;

-- Apply future-object defaults only to objects created by the deployment role.
ALTER DEFAULT PRIVILEGES FOR ROLE cloudpilot_migrator IN SCHEMA public
  REVOKE ALL ON TABLES FROM cloudpilot_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE cloudpilot_migrator IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

DO $cloudpilot$
BEGIN
  IF has_database_privilege('cloudpilot_runtime', current_database(), 'CREATE') OR
     (SELECT datdba = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'cloudpilot_runtime')
      FROM pg_catalog.pg_database WHERE datname = current_database()) OR
     (SELECT nspowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'cloudpilot_runtime')
      FROM pg_catalog.pg_namespace WHERE nspname = 'public') OR
     EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'cloudpilot_runtime')) OR
     EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'cloudpilot_runtime')) THEN
    RAISE EXCEPTION 'cloudpilot_runtime must not own the database, schema, or application objects or have database CREATE';
  END IF;
  IF has_table_privilege('cloudpilot_runtime', 'public.findings', 'UPDATE') OR
     has_table_privilege('cloudpilot_runtime', 'public.organizations', 'UPDATE') OR
     has_table_privilege('cloudpilot_runtime', 'public.organization_members', 'UPDATE') OR
     has_table_privilege('cloudpilot_runtime', 'public.organization_github_installations', 'UPDATE') OR
     has_table_privilege('cloudpilot_runtime', 'public.findings', 'TRIGGER') OR
     has_table_privilege('cloudpilot_runtime', 'public.organizations', 'TRIGGER') OR
     has_table_privilege('cloudpilot_runtime', 'public.organization_members', 'TRIGGER') OR
     has_table_privilege('cloudpilot_runtime', 'public.organization_github_installations', 'TRIGGER') THEN
    RAISE EXCEPTION 'cloudpilot_runtime has effective UPDATE or TRIGGER privilege on a helper-locked table';
  END IF;
  IF has_table_privilege('cloudpilot_runtime', 'public.remediation_execution_events', 'UPDATE') OR
     has_table_privilege('cloudpilot_runtime', 'public.remediation_execution_events', 'DELETE') OR
     has_table_privilege('cloudpilot_runtime', 'public.remediation_execution_events', 'TRUNCATE') OR
     has_table_privilege('cloudpilot_runtime', 'public.projects', 'TRUNCATE') OR
     has_table_privilege('cloudpilot_runtime', 'public.findings', 'TRUNCATE') OR
     has_table_privilege('cloudpilot_runtime', 'public.audit_events', 'UPDATE') OR
     has_table_privilege('cloudpilot_runtime', 'public.audit_events', 'DELETE') OR
     has_table_privilege('cloudpilot_runtime', 'public.audit_events', 'TRUNCATE') OR
     has_table_privilege('cloudpilot_runtime', 'public.organization_audit_events', 'UPDATE') OR
     has_table_privilege('cloudpilot_runtime', 'public.organization_audit_events', 'DELETE') OR
     has_table_privilege('cloudpilot_runtime', 'public.organization_audit_events', 'TRUNCATE') OR
     has_table_privilege('cloudpilot_runtime', 'public._prisma_migrations', 'SELECT') OR
     has_table_privilege('cloudpilot_runtime', 'public._prisma_migrations', 'INSERT') OR
     has_table_privilege('cloudpilot_runtime', 'public._prisma_migrations', 'UPDATE') OR
     has_table_privilege('cloudpilot_runtime', 'public._prisma_migrations', 'DELETE') OR
     has_table_privilege('cloudpilot_runtime', 'public._prisma_migrations', 'TRUNCATE') OR
     has_table_privilege('cloudpilot_runtime', 'public.tenants', 'SELECT') OR
     has_table_privilege('cloudpilot_runtime', 'public.users', 'SELECT') OR
     has_table_privilege('cloudpilot_runtime', 'public.github_webhook_deliveries', 'SELECT') THEN
    RAISE EXCEPTION 'cloudpilot_runtime has a forbidden mutation privilege on an append-only table';
  END IF;
END;
$cloudpilot$;
COMMIT;
