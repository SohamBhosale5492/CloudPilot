export interface ExecutionArtifactTriggerCatalogRow {
  trigger_name: string | null;
  enabled: string | null;
  trigger_type: number | null;
  is_internal: boolean | null;
  table_schema: string | null;
  table_name: string | null;
  function_schema: string | null;
  function_name: string | null;
  function_language: string | null;
  security_definer: boolean | null;
  trigger_when: string | null;
  is_constraint_trigger: boolean | null;
  trigger_definition: string | null;
  function_definition: string | null;
}

const TRIGGER_NAME = "trg_remediations_execution_artifact_immutable";
const FUNCTION_NAME = "prevent_remediation_execution_artifact_replacement";
const EXPECTED_TRIGGER_TYPE = 27; // BEFORE + FOR EACH ROW + UPDATE + DELETE.
const EXPECTED_FUNCTION_BODY = "beginiftg_opnotin('update','delete')thenraiseexception'unsupportedremediationexecutionartifactoperation';endif;iftg_op='delete'thenifold.execution_artifactisnotnullthenraiseexception'remediationexecutionartifactisimmutable';endif;returnold;endif;iftg_op='update'andold.execution_artifactisnotnulland(new.execution_artifactisdistinctfromold.execution_artifactornew.execution_artifact_hashisdistinctfromold.execution_artifact_hash)thenraiseexception'remediationexecutionartifactisimmutable';endif;returnnew;end;";

function normalizedFunctionBody(definition: string): string | null {
  const body = definition.match(/\bAS\s+(\$[A-Za-z_0-9]*\$)([\s\S]*?)\1/i)?.[2];
  if (body === undefined) return null;
  return body.replace(/--[^\r\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ")
    .toLowerCase().replaceAll('"', "").replace(/\s+/g, "");
}

/**
 * Fail-closed validation of pg_catalog metadata returned during host startup.
 * Whitespace and identifier quoting are normalized; trigger operations,
 * attachment, function identity and the exact immutability body are checked.
 */
export function assertExecutionArtifactImmutabilityTrigger(rows: readonly ExecutionArtifactTriggerCatalogRow[]): void {
  const named = rows.filter((row) => row.trigger_name === TRIGGER_NAME);
  const attached = named.filter((row) => row.table_schema === "public" && row.table_name === "remediations");
  if (attached.length !== 1) throw new Error("Required remediation artifact immutability trigger is missing or invalid.");
  const row = attached[0];
  const definition = row.trigger_definition?.replaceAll('"', "").toLowerCase().replace(/\s+/g, "");
  const hasExpectedAttachment = !!definition && /before(?:updateordelete|deleteorupdate)on(?:public\.)?remediationsforeachrow/.test(definition);
  const hasExpectedFunction = !!definition && new RegExp(`executefunction(?:public\\.)?${FUNCTION_NAME}\\(\\)`).test(definition);
  if ((row.enabled !== "O" && row.enabled !== "A") ||
      row.trigger_type !== EXPECTED_TRIGGER_TYPE || row.is_internal !== false ||
      row.function_schema !== "public" || row.function_name !== FUNCTION_NAME ||
      row.function_language !== "plpgsql" || row.security_definer !== false ||
      row.trigger_when !== null || row.is_constraint_trigger !== false ||
      !hasExpectedAttachment || !hasExpectedFunction || !row.function_definition ||
      normalizedFunctionBody(row.function_definition) !== EXPECTED_FUNCTION_BODY) {
    throw new Error("Required remediation artifact immutability trigger is missing or invalid.");
  }
}
