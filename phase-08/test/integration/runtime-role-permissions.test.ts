import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { requireIntegrationDatabaseUrl } from "../../../test-support/integration-database.js";

const runtimeUrlValue = process.env.CLOUDPILOT_RUNTIME_ROLE_TEST_DATABASE_URL;
const migrationUrlValue = process.env.CLOUDPILOT_MIGRATION_ROLE_TEST_DATABASE_URL;
const runtimeAcceptanceEnabled = process.env.CLOUDPILOT_RUN_RUNTIME_ROLE_ACCEPTANCE === "true";
const EXPECTED_DB = "cloudpilot_runtime_role_test";
const EXPECTED_HOST_PORT = "56440";
const EXPECTED_MIGRATIONS = 18;

function validatedTarget(value: string | undefined, role: "cloudpilot_runtime" | "cloudpilot_migrator"): URL {
  const variable = role === "cloudpilot_runtime" ? "CLOUDPILOT_RUNTIME_ROLE_TEST_DATABASE_URL" : "CLOUDPILOT_MIGRATION_ROLE_TEST_DATABASE_URL";
  return new URL(requireIntegrationDatabaseUrl(value, variable, role));
}

test("PostgreSQL runtime role is restricted while migration role remains isolated", {
  skip: !runtimeAcceptanceEnabled ? "requires explicit CLOUDPILOT_RUN_RUNTIME_ROLE_ACCEPTANCE=true; this test invokes Prisma migrate deploy" :
    (!runtimeUrlValue || !migrationUrlValue ? "requires separate runtime and migration-role URLs" : false)
}, async () => {
  const runtimeUrl = validatedTarget(runtimeUrlValue, "cloudpilot_runtime").toString();
  const migrationUrl = validatedTarget(migrationUrlValue, "cloudpilot_migrator").toString();
  const packageDir = process.cwd();
  const runtime = new PrismaClient({ datasources: { db: { url: runtimeUrl } } });
  const migrator = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
  try {
    const runtimeIdentity = await runtime.$queryRaw<Array<{ database: string; role: string; serverPort: number }>>`
      SELECT current_database() AS database, current_user AS role, inet_server_port() AS "serverPort"
    `;
    const migrationIdentity = await migrator.$queryRaw<Array<{ database: string; role: string; serverPort: number }>>`
      SELECT current_database() AS database, current_user AS role, inet_server_port() AS "serverPort"
    `;
    assert.deepEqual(runtimeIdentity[0], { database: EXPECTED_DB, role: "cloudpilot_runtime", serverPort: 5432 });
    assert.deepEqual(migrationIdentity[0], { database: EXPECTED_DB, role: "cloudpilot_migrator", serverPort: 5432 });

    const history = await migrator.$queryRaw<Array<{ migration_name: string; checksum: string;
      finished_at: Date | null; rolled_back_at: Date | null }>>`
      SELECT migration_name, checksum, finished_at, rolled_back_at
      FROM public._prisma_migrations
      ORDER BY started_at
    `;
    assert.equal(history.length, EXPECTED_MIGRATIONS, "dedicated database must have the complete 18-migration history");
    assert.ok(history.every((entry) => entry.finished_at !== null && entry.rolled_back_at === null),
      "migration history must contain only successful migrations");
    const migrationRoot = path.join(packageDir, "prisma", "migrations");
    const migrationNames = (await readdir(migrationRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    assert.equal(migrationNames.length, EXPECTED_MIGRATIONS);
    for (let index = 0; index < migrationNames.length; index += 1) {
      const canonicalSql = await readFile(path.join(migrationRoot, migrationNames[index]!, "migration.sql"), "utf8");
      assert.equal(history[index]?.migration_name, migrationNames[index]);
      assert.equal(history[index]?.checksum, createHash("sha256").update(canonicalSql, "utf8").digest("hex"));
    }
    const freshness = await migrator.$queryRaw<Array<{ remediations: bigint; executions: bigint; events: bigint }>>`
      SELECT (SELECT count(*) FROM public.remediations) AS remediations,
        (SELECT count(*) FROM public.remediation_executions) AS executions,
        (SELECT count(*) FROM public.remediation_execution_events) AS events
    `;
    assert.deepEqual(freshness[0], { remediations: 0n, executions: 0n, events: 0n },
      "runtime-role privilege database must be fresh and isolated");

    const roleState = await runtime.$queryRaw<Array<{ safe: boolean; memberships: bigint; publicCreate: boolean; dbCreate: boolean }>>`
      SELECT NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit) AS safe,
        (SELECT count(*) FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS memberships,
        has_schema_privilege(current_user, 'public', 'CREATE') AS "publicCreate",
        has_database_privilege(current_user, current_database(), 'CREATE') AS "dbCreate"
      FROM pg_catalog.pg_roles r WHERE r.rolname = current_user
    `;
    assert.deepEqual(roleState[0], { safe: true, memberships: 0n, publicCreate: false, dbCreate: false });

    const permissions = await runtime.$queryRaw<Array<Record<string, boolean>>>`
      SELECT
        has_table_privilege(current_user, 'public.projects', 'INSERT') AS project_insert,
        has_table_privilege(current_user, 'public.projects', 'DELETE') AS project_delete,
        has_table_privilege(current_user, 'public.findings', 'DELETE') AS finding_delete,
        has_table_privilege(current_user, 'public.findings', 'UPDATE') AS finding_update,
        has_table_privilege(current_user, 'public.organizations', 'UPDATE') AS organization_update,
        has_table_privilege(current_user, 'public.organization_members', 'UPDATE') AS member_update,
        has_table_privilege(current_user, 'public.organization_github_installations', 'UPDATE') AS installation_update,
        has_table_privilege(current_user, 'public.remediation_execution_events', 'SELECT') AS event_select,
        has_table_privilege(current_user, 'public.remediation_execution_events', 'INSERT') AS event_insert,
        has_table_privilege(current_user, 'public.remediation_execution_events', 'UPDATE') AS event_update,
        has_table_privilege(current_user, 'public.remediation_execution_events', 'DELETE') AS event_delete,
        has_table_privilege(current_user, 'public.remediation_execution_events', 'TRUNCATE') AS event_truncate,
        has_table_privilege(current_user, 'public.audit_events', 'SELECT') AS audit_select,
        has_table_privilege(current_user, 'public.audit_events', 'INSERT') AS audit_insert,
        has_table_privilege(current_user, 'public.audit_events', 'UPDATE') AS audit_update,
        has_table_privilege(current_user, 'public.audit_events', 'DELETE') AS audit_delete,
        has_table_privilege(current_user, 'public.audit_events', 'TRUNCATE') AS audit_truncate,
        has_table_privilege(current_user, 'public.organization_audit_events', 'INSERT') AS org_audit_insert,
        has_table_privilege(current_user, 'public.organization_audit_events', 'SELECT') AS org_audit_select,
        has_column_privilege(current_user, 'public.organization_audit_events', 'id', 'SELECT') AS org_audit_id_select,
        has_column_privilege(current_user, 'public.organization_audit_events', 'metadata', 'SELECT') AS org_audit_metadata_select,
        NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_attribute AS a
          WHERE a.attrelid = 'public.organization_audit_events'::regclass
            AND a.attnum > 0 AND NOT a.attisdropped AND a.attname <> 'id'
            AND has_column_privilege(current_user, 'public.organization_audit_events', a.attname::text, 'SELECT')
        ) AS org_audit_other_columns_denied,
        has_table_privilege(current_user, 'public.organization_audit_events', 'UPDATE') AS org_audit_update,
        has_table_privilege(current_user, 'public.organization_audit_events', 'DELETE') AS org_audit_delete,
        has_table_privilege(current_user, 'public.organization_audit_events', 'TRUNCATE') AS org_audit_truncate,
        has_table_privilege(current_user, 'public.tenants', 'SELECT') AS tenant_select,
        has_table_privilege(current_user, 'public.users', 'SELECT') AS legacy_user_select,
        has_table_privilege(current_user, 'public.github_webhook_deliveries', 'SELECT') AS webhook_select,
        has_table_privilege(current_user, 'public._prisma_migrations', 'SELECT') AS migration_select,
        has_table_privilege(current_user, 'public._prisma_migrations', 'INSERT') AS migration_insert,
        has_table_privilege(current_user, 'public._prisma_migrations', 'UPDATE') AS migration_update,
        has_table_privilege(current_user, 'public._prisma_migrations', 'DELETE') AS migration_delete,
        has_table_privilege(current_user, 'public._prisma_migrations', 'TRUNCATE') AS migration_truncate
    `;
    const p = permissions[0]!;
    for (const key of ["finding_update", "organization_update", "member_update", "installation_update", "event_update", "event_delete", "event_truncate",
      "audit_update", "audit_delete", "audit_truncate", "org_audit_select", "org_audit_metadata_select", "org_audit_update", "org_audit_delete", "org_audit_truncate",
      "tenant_select", "legacy_user_select", "webhook_select", "migration_select", "migration_insert", "migration_update",
      "migration_delete", "migration_truncate"]) assert.equal(p[key], false, `${key} must be denied`);
    assert.equal(p.org_audit_other_columns_denied, true, "only the organization audit event ID column may be selected");
    for (const key of ["event_select", "event_insert", "audit_select", "audit_insert", "org_audit_insert", "org_audit_id_select"]) assert.equal(p[key], true, `${key} must be allowed`);
    assert.equal(p.project_delete, true, "authorized project deletion remains supported");
    assert.equal(p.project_insert, true, "Phase 06 project creation remains supported");
    assert.equal(p.finding_delete, true, "scan retry can remove partial findings");

    const helpers = await runtime.$queryRaw<Array<{ function_name: string; arguments: string; security_definer: boolean; owner_name: string;
      configuration: string[] | null; executable: boolean; public_execute: boolean }>>`
      SELECT p.proname AS function_name, p.prosecdef AS security_definer, owner.rolname AS owner_name,
        pg_catalog.oidvectortypes(p.proargtypes) AS arguments,
        p.proconfig AS configuration, has_function_privilege(current_user, p.oid, 'EXECUTE') AS executable,
        EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,
          pg_catalog.acldefault('f', p.proowner))) acl WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_execute
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_roles owner ON owner.oid = p.proowner
      WHERE n.nspname = 'public' AND p.proname LIKE 'cloudpilot_lock_%'
    `;
    assert.equal(helpers.length, 5);
    const expectedHelperArguments: Record<string, string> = {
      cloudpilot_lock_active_organization: "uuid",
      cloudpilot_lock_active_member: "uuid, uuid",
      cloudpilot_lock_active_actor_for_update: "uuid, uuid",
      cloudpilot_lock_scoped_finding: "text, text, text, text",
      cloudpilot_lock_active_binding_installation: "text, uuid, text, uuid, uuid, bigint"
    };
    for (const helper of helpers) {
      assert.equal(helper.security_definer, true);
      assert.equal(helper.owner_name, "cloudpilot_migrator");
      assert.equal(helper.configuration?.includes("search_path=pg_catalog"), true);
      assert.equal(helper.executable, true);
      assert.equal(helper.public_execute, false);
      assert.equal(helper.arguments, expectedHelperArguments[helper.function_name], `${helper.function_name} signature must be exact`);
    }

    assert.equal((await runtime.$queryRaw<Array<{ locked: boolean }>>`
      SELECT public.cloudpilot_lock_active_organization(${randomUUID()}::uuid) AS locked
    `)[0]?.locked, false);
    assert.equal((await runtime.$queryRaw<Array<{ role: string | null }>>`
      SELECT public.cloudpilot_lock_active_member(${randomUUID()}::uuid, ${randomUUID()}::uuid) AS role
    `)[0]?.role, null);
    assert.equal((await runtime.$queryRaw<Array<{ role: string | null }>>`
      SELECT public.cloudpilot_lock_active_actor_for_update(${randomUUID()}::uuid, ${randomUUID()}::uuid) AS role
    `)[0]?.role, null);
    assert.equal((await runtime.$queryRaw<Array<{ locked: boolean }>>`
      SELECT public.cloudpilot_lock_scoped_finding('missing-tenant', 'missing-project', 'missing-scan', 'missing-finding') AS locked
    `)[0]?.locked, false);
    assert.equal((await runtime.$queryRaw<Array<{ locked: boolean }>>`
      SELECT public.cloudpilot_lock_active_binding_installation('missing-tenant', ${randomUUID()}::uuid,
        'missing-project', ${randomUUID()}::uuid, ${randomUUID()}::uuid, 1::bigint) AS locked
    `)[0]?.locked, false);

    // The migration target is already fully migrated, so this is a no-op deploy
    // under migration credentials. The runtime-credential attempt must fail.
    const prismaCli = path.join(packageDir, "node_modules", "prisma", "build", "index.js");
    const deploySucceeded = (url: string): boolean => {
      try {
        execFileSync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", "prisma/schema.prisma"], {
          cwd: packageDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
          env: { ...process.env, DATABASE_URL: url, MIGRATION_DATABASE_URL: url }
        });
        return true;
      } catch { return false; }
    };
    assert.equal(deploySucceeded(migrationUrl), true,
      "migration credentials should reach the canonical migration status; subprocess details are suppressed");
    assert.equal(deploySucceeded(runtimeUrl), false,
      "runtime credentials must not read or apply Prisma migration state; subprocess details are suppressed");

    // UPDATE/DELETE predicates match no records; TRUNCATE and DDL attempts are
    // enclosed in savepoints and rolled back even if a grant is accidentally broad.
    await runtime.$transaction(async (tx) => {
      const rejected = async (statement: string, label: string) => {
        await tx.$executeRawUnsafe("SAVEPOINT cloudpilot_privilege_probe");
        let denied = false;
        try { await tx.$executeRawUnsafe(statement); } catch { denied = true; }
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT cloudpilot_privilege_probe");
        await tx.$executeRawUnsafe("RELEASE SAVEPOINT cloudpilot_privilege_probe");
        assert.equal(denied, true, `${label} must be denied`);
      };
      await rejected("UPDATE public.findings SET id = id WHERE false", "finding UPDATE");
      await rejected("UPDATE public.organizations SET status = status WHERE false", "organization UPDATE");
      await rejected("UPDATE public.organization_members SET status = status WHERE false", "membership UPDATE");
      await rejected("UPDATE public.organization_github_installations SET status = status WHERE false", "installation UPDATE");
      await rejected("UPDATE public.remediation_execution_events SET event_type = event_type WHERE false", "event UPDATE");
      await rejected("DELETE FROM public.remediation_execution_events WHERE false", "event DELETE");
      await rejected("TRUNCATE TABLE public.remediation_execution_events", "event TRUNCATE");
      await rejected("UPDATE public.audit_events SET action = action WHERE false", "audit UPDATE");
      await rejected("DELETE FROM public.audit_events WHERE false", "audit DELETE");
      await rejected("TRUNCATE TABLE public.audit_events", "audit TRUNCATE");
      await rejected("UPDATE public.organization_audit_events SET action = action WHERE false", "organization audit UPDATE");
      await rejected("DELETE FROM public.organization_audit_events WHERE false", "organization audit DELETE");
      await rejected("TRUNCATE TABLE public.organization_audit_events", "organization audit TRUNCATE");
      await rejected("ALTER TABLE public.remediations ADD COLUMN codex_runtime_probe integer", "runtime ALTER TABLE");
      await rejected("ALTER TABLE public.remediation_execution_events DISABLE TRIGGER ALL", "runtime trigger administration");
    });
  } finally {
    await Promise.all([runtime.$disconnect(), migrator.$disconnect()]);
  }
});
