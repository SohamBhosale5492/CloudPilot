-- Narrow SECURITY DEFINER helpers preserve existing row locks while the
-- application role has no UPDATE privilege on authorization-only tables.
-- The migration executor becomes function owner; runtime grants are provisioned
-- separately after the cloudpilot_runtime role exists.

CREATE FUNCTION public.cloudpilot_lock_active_organization(p_organization_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $cloudpilot$
DECLARE
  v_id uuid;
BEGIN
  SELECT o.id INTO v_id
  FROM public.organizations AS o
  WHERE o.id = p_organization_id AND o.status = 'active'
  FOR SHARE OF o;
  RETURN v_id IS NOT NULL;
END;
$cloudpilot$;

CREATE FUNCTION public.cloudpilot_lock_active_member(p_organization_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $cloudpilot$
DECLARE
  v_role text;
BEGIN
  SELECT m.role INTO v_role
  FROM public.organization_members AS m
  JOIN public.identity_users AS u ON u.id = m.user_id
  WHERE m.organization_id = p_organization_id AND m.user_id = p_user_id
    AND m.status = 'active' AND u.status = 'active'
  FOR SHARE OF m, u;
  RETURN v_role;
END;
$cloudpilot$;

CREATE FUNCTION public.cloudpilot_lock_active_actor_for_update(p_organization_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $cloudpilot$
DECLARE
  v_role text;
BEGIN
  SELECT m.role INTO v_role
  FROM public.organizations AS o
  JOIN public.organization_members AS m ON m.organization_id = o.id
  JOIN public.identity_users AS u ON u.id = m.user_id
  WHERE o.id = p_organization_id AND o.status = 'active'
    AND m.user_id = p_user_id AND m.status = 'active' AND u.status = 'active'
  FOR UPDATE OF o, m, u;
  RETURN v_role;
END;
$cloudpilot$;

CREATE FUNCTION public.cloudpilot_lock_scoped_finding(
  p_tenant_id text, p_project_id text, p_scan_id text, p_finding_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $cloudpilot$
DECLARE
  v_id text;
BEGIN
  SELECT f.id INTO v_id
  FROM public.findings AS f
  WHERE f.tenant_id = p_tenant_id AND f.project_id = p_project_id
    AND f.scan_id = p_scan_id AND f.id = p_finding_id
  FOR SHARE OF f;
  RETURN v_id IS NOT NULL;
END;
$cloudpilot$;

CREATE FUNCTION public.cloudpilot_lock_active_binding_installation(
  p_tenant_id text, p_organization_id uuid, p_project_id text,
  p_binding_id uuid, p_installation_id uuid, p_github_repository_id bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $cloudpilot$
DECLARE
  v_binding_id uuid;
BEGIN
  SELECT b.id INTO v_binding_id
  FROM public.project_github_repositories AS b
  JOIN public.organization_github_installations AS i
    ON i.id = b.installation_record_id AND i.organization_id = b.organization_id
  WHERE b.id = p_binding_id AND b.tenant_id = p_tenant_id
    AND b.organization_id = p_organization_id AND b.project_id = p_project_id
    AND b.installation_record_id = p_installation_id
    AND b.github_repository_id = p_github_repository_id
    AND b.status = 'active' AND i.status = 'active'
  FOR SHARE OF b, i;
  RETURN v_binding_id IS NOT NULL;
END;
$cloudpilot$;

REVOKE ALL ON FUNCTION public.cloudpilot_lock_active_organization(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cloudpilot_lock_active_member(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cloudpilot_lock_active_actor_for_update(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cloudpilot_lock_scoped_finding(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cloudpilot_lock_active_binding_installation(text, uuid, text, uuid, uuid, bigint) FROM PUBLIC;
