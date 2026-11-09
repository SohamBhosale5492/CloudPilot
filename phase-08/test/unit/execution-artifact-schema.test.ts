import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertExecutionArtifactImmutabilityTrigger,
  type ExecutionArtifactTriggerCatalogRow
} from "../../src/db/execution-artifact-integrity.js";

const artifactMigrationPath = "prisma/migrations/20261105160000_remediation_execution_artifact/migration.sql";
const approvalMigrationPath = "prisma/migrations/20261105150000_remediation_approval_foundation/migration.sql";
const triggerBody = `CREATE OR REPLACE FUNCTION public.prevent_remediation_execution_artifact_replacement()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP NOT IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'unsupported remediation execution artifact operation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."execution_artifact" IS NOT NULL THEN
      RAISE EXCEPTION 'remediation execution artifact is immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."execution_artifact" IS NOT NULL AND
     (NEW."execution_artifact" IS DISTINCT FROM OLD."execution_artifact" OR
      NEW."execution_artifact_hash" IS DISTINCT FROM OLD."execution_artifact_hash") THEN
    RAISE EXCEPTION 'remediation execution artifact is immutable';
  END IF;
  RETURN NEW;
END;
$function$;`;

function row(overrides: Partial<ExecutionArtifactTriggerCatalogRow> = {}): ExecutionArtifactTriggerCatalogRow {
  return {
    trigger_name: "trg_remediations_execution_artifact_immutable", enabled: "O", trigger_type: 27,
    is_internal: false, table_schema: "public", table_name: "remediations", function_schema: "public",
    function_name: "prevent_remediation_execution_artifact_replacement", function_language: "plpgsql",
    security_definer: false, trigger_when: null, is_constraint_trigger: false,
    trigger_definition: "CREATE TRIGGER trg_remediations_execution_artifact_immutable BEFORE UPDATE OR DELETE ON public.remediations FOR EACH ROW EXECUTE FUNCTION public.prevent_remediation_execution_artifact_replacement()",
    function_definition: triggerBody, ...overrides
  };
}

test("startup catalog verifier accepts the enabled UPDATE immutability trigger and ignores unrelated triggers", () => {
  assert.doesNotThrow(() => assertExecutionArtifactImmutabilityTrigger([
    row({ trigger_name: "unrelated_trigger", table_schema: "other_schema", table_name: "other_table" }),
    row({ enabled: "A" })
  ]));
});

test("startup catalog verifier rejects missing, disabled, or wrongly attached triggers", () => {
  assert.throws(() => assertExecutionArtifactImmutabilityTrigger([]), /immutability trigger is missing or invalid/);
  assert.throws(() => assertExecutionArtifactImmutabilityTrigger([row({ enabled: "D" })]), /immutability trigger is missing or invalid/);
  assert.throws(() => assertExecutionArtifactImmutabilityTrigger([row({ table_name: "findings" })]), /immutability trigger is missing or invalid/);
});

test("startup catalog verifier requires a BEFORE ROW UPDATE OR DELETE trigger without conditions", () => {
  assert.throws(() => assertExecutionArtifactImmutabilityTrigger([row({ trigger_type: 19 })]), /immutability trigger is missing or invalid/);
  assert.throws(() => assertExecutionArtifactImmutabilityTrigger([row({ trigger_when: "true" })]), /immutability trigger is missing or invalid/);
  assert.throws(() => assertExecutionArtifactImmutabilityTrigger([row({
    trigger_definition: "CREATE TRIGGER trg_remediations_execution_artifact_immutable AFTER UPDATE OR DELETE ON public.remediations FOR EACH ROW EXECUTE FUNCTION public.prevent_remediation_execution_artifact_replacement()"
  })]), /immutability trigger is missing or invalid/);
  assert.throws(() => assertExecutionArtifactImmutabilityTrigger([row({
    trigger_definition: "CREATE TRIGGER trg_remediations_execution_artifact_immutable BEFORE UPDATE ON public.remediations FOR EACH ROW EXECUTE FUNCTION public.no_op()"
  })]), /immutability trigger is missing or invalid/);
  assert.throws(() => assertExecutionArtifactImmutabilityTrigger([row({ function_schema: "other_schema" })]), /immutability trigger is missing or invalid/);
});

test("startup catalog verifier rejects a missing, altered, or no-op trigger function", () => {
  assert.throws(() => assertExecutionArtifactImmutabilityTrigger([row({ function_definition: null })]), /immutability trigger is missing or invalid/);
  assert.throws(() => assertExecutionArtifactImmutabilityTrigger([row({ function_name: "different_function" })]), /immutability trigger is missing or invalid/);
  assert.throws(() => assertExecutionArtifactImmutabilityTrigger([row({ function_definition: triggerBody.replace(/IF OLD[\s\S]*?END IF;/, "NULL; -- weakened no-op") })]), /immutability trigger is missing or invalid/);
  assert.throws(() => assertExecutionArtifactImmutabilityTrigger([row({ security_definer: true })]), /immutability trigger is missing or invalid/);
});

test("artifact trigger function blocks both persisted-artifact UPDATE changes and DELETE", () => {
  assert.doesNotThrow(() => assertExecutionArtifactImmutabilityTrigger([row()]));
  assert.throws(() => assertExecutionArtifactImmutabilityTrigger([row({
    function_definition: triggerBody.replace(/IF TG_OP = 'DELETE'[\s\S]*?END IF;/, "NULL;")
  })]), /immutability trigger is missing or invalid/);
});

test("pending migration attaches DELETE protection and fails closed for unsupported operations", async () => {
  const sql = await readFile(artifactMigrationPath, "utf8");
  assert.match(sql, /BEFORE UPDATE OR DELETE ON "remediations"/);
  assert.match(sql, /IF TG_OP NOT IN \('UPDATE', 'DELETE'\) THEN[\s\S]*?RAISE EXCEPTION/);
  assert.match(sql, /IF TG_OP = 'DELETE' THEN[\s\S]*?OLD\."execution_artifact" IS NOT NULL[\s\S]*?RAISE EXCEPTION/);
  assert.match(sql, /IF TG_OP = 'UPDATE'[\s\S]*?OLD\."execution_artifact" IS NOT NULL[\s\S]*?IS DISTINCT FROM/);
});

test("remediation deletion cascades are protected by the artifact trigger", async () => {
  const schema = await readFile("prisma/schema.prisma", "utf8");
  const remediation = schema.match(/model Remediation \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(remediation);
  assert.match(remediation, /tenant\s+Tenant[\s\S]*?onDelete: Cascade/);
  assert.match(remediation, /project\s+Project[\s\S]*?onDelete: Cascade/);
  assert.match(remediation, /scan\s+Scan[\s\S]*?onDelete: Cascade/);
  assert.match(remediation, /finding\s+Finding[\s\S]*?onDelete: Cascade/);
  const sql = await readFile(artifactMigrationPath, "utf8");
  assert.match(sql, /BEFORE UPDATE OR DELETE ON "remediations"/);
  assert.match(sql, /OLD\."execution_artifact" IS NOT NULL[\s\S]*?RAISE EXCEPTION 'remediation execution artifact is immutable'/);
});

test("approved proposals cannot omit the artifact or approved artifact hash", async () => {
  const sql = await readFile(artifactMigrationPath, "utf8");
  assert.match(sql, /"approval_state" = 'approved'[\s\S]*?"approved_artifact_hash" IS NOT NULL[\s\S]*?"approved_artifact_hash" = "execution_artifact_hash"/);
  assert.match(sql, /"execution_artifact" IS NULL[\s\S]*?"approval_state" IS NULL OR "approval_state" IN \('pending', 'rejected', 'invalidated'\)/);
  assert.match(sql, /"execution_artifact" IS NOT NULL[\s\S]*?AND "approval_state" IS NOT NULL/);
});

test("valid pending, rejected, and both invalidation histories retain allowed artifact-hash states", async () => {
  const sql = await readFile(artifactMigrationPath, "utf8");
  assert.match(sql, /"approval_state" IN \('pending', 'rejected'\) AND "approved_artifact_hash" IS NULL/);
  assert.match(sql, /"approval_state" = 'invalidated'[\s\S]*?"approved_artifact_hash" IS NULL OR "approved_artifact_hash" = "execution_artifact_hash"/);
});

test("approval CHECKs require state-specific actor/timestamp metadata and repository identity", async () => {
  const approvalSql = await readFile(approvalMigrationPath, "utf8");
  const artifactSql = await readFile(artifactMigrationPath, "utf8");
  assert.match(approvalSql, /"approval_state" = 'approved'[\s\S]*?"approved_by_identity_user_id" IS NOT NULL AND "approved_at" IS NOT NULL/);
  assert.match(approvalSql, /"approval_state" = 'rejected'[\s\S]*?"rejected_by_identity_user_id" IS NOT NULL AND "rejected_at" IS NOT NULL/);
  assert.match(approvalSql, /"approval_state" = 'invalidated'[\s\S]*?"invalidated_by_identity_user_id" IS NOT NULL AND "invalidated_at" IS NOT NULL/);
  assert.match(artifactSql, /CONSTRAINT "ck_remediations_approval_repository_id" CHECK \(\s*"approval_state" IS NULL OR "github_repository_id" IS NOT NULL\s*\)/);
});
