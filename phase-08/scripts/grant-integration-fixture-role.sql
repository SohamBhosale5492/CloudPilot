-- Optional fixture-only grants for Phase 06/07 integration tests.
-- Apply only after schema migrations, as the schema owner, in the isolated
-- cloudpilot_runtime_role_test database. This does not grant to cloudpilot_runtime.
-- Provision cloudpilot_integration_test separately as NOINHERIT, NOSUPERUSER,
-- NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS; set its password out of band.
BEGIN;
DO $cloudpilot$
DECLARE
  fixture_oid oid;
BEGIN
  IF current_database() <> 'cloudpilot_runtime_role_test' THEN
    RAISE EXCEPTION 'Fixture grants are restricted to cloudpilot_runtime_role_test';
  END IF;
  SELECT oid INTO fixture_oid FROM pg_catalog.pg_roles
  WHERE rolname = 'cloudpilot_integration_test' AND NOT rolsuper AND NOT rolcreatedb
    AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit;
  IF fixture_oid IS NULL OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = fixture_oid
  ) THEN
    RAISE EXCEPTION 'A dedicated non-inheriting fixture role must be provisioned first';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
    WHERE m.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'cloudpilot_runtime')
      AND r.rolname = 'cloudpilot_integration_test'
  ) THEN
    RAISE EXCEPTION 'Runtime role must not inherit fixture privileges';
  END IF;
END;
$cloudpilot$;

GRANT CONNECT ON DATABASE cloudpilot_runtime_role_test TO cloudpilot_integration_test;
GRANT USAGE ON SCHEMA public TO cloudpilot_integration_test;
REVOKE CREATE ON SCHEMA public FROM cloudpilot_integration_test;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cloudpilot_integration_test;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cloudpilot_integration_test;

-- Keep execution events append-only for fixture tests. Legacy audit test rows may
-- be deleted only in this disposable database by their owned-tenant teardown.
REVOKE UPDATE, DELETE ON TABLE public.remediation_execution_events FROM cloudpilot_integration_test;
GRANT SELECT, INSERT ON TABLE public.remediation_execution_events TO cloudpilot_integration_test;
REVOKE UPDATE ON TABLE public.audit_events FROM cloudpilot_integration_test;
GRANT SELECT, INSERT, DELETE ON TABLE public.audit_events TO cloudpilot_integration_test;
REVOKE UPDATE ON TABLE public.organization_audit_events FROM cloudpilot_integration_test;
GRANT SELECT, INSERT, DELETE ON TABLE public.organization_audit_events TO cloudpilot_integration_test;
COMMIT;
