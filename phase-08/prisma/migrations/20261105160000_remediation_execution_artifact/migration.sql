-- Stage 3E.3 A.2: persist the exact rendered remediation artifact separately
-- from the human-readable plan. Historical records remain NULL and untouched.
ALTER TABLE "remediations"
  ADD COLUMN "execution_artifact" JSONB,
  ADD COLUMN "execution_artifact_hash" VARCHAR(64),
  ADD COLUMN "approved_artifact_hash" VARCHAR(64);

ALTER TABLE "remediations"
  ADD CONSTRAINT "ck_remediations_execution_artifact" CHECK (
    (
      "execution_artifact" IS NULL
      AND "execution_artifact_hash" IS NULL
      AND "approved_artifact_hash" IS NULL
      AND ("approval_state" IS NULL OR "approval_state" IN ('pending', 'rejected', 'invalidated'))
    )
    OR
    (
      "execution_artifact" IS NOT NULL
      AND "approval_state" IS NOT NULL
      AND jsonb_typeof("execution_artifact") = 'object'
      AND octet_length("execution_artifact"::text) <= 2097152
      AND "execution_artifact_hash" IS NOT NULL
      AND "execution_artifact_hash" ~ '^[0-9a-f]{64}$'
      AND (
        ("approval_state" = 'approved'
          AND "approved_artifact_hash" IS NOT NULL
          AND "approved_artifact_hash" = "execution_artifact_hash")
        OR ("approval_state" IN ('pending', 'rejected') AND "approved_artifact_hash" IS NULL)
        OR ("approval_state" = 'invalidated'
          AND ("approved_artifact_hash" IS NULL OR "approved_artifact_hash" = "execution_artifact_hash"))
      )
    )
  );

-- The approval-foundation CHECK used `github_repository_id > 0`, which can
-- evaluate to NULL and therefore pass CHECK. Keep historical rows NULL while
-- explicitly requiring an ID for every proposal state.
ALTER TABLE "remediations"
  ADD CONSTRAINT "ck_remediations_approval_repository_id" CHECK (
    "approval_state" IS NULL OR "github_repository_id" IS NOT NULL
  );

CREATE FUNCTION prevent_remediation_execution_artifact_replacement()
RETURNS trigger LANGUAGE plpgsql AS $$
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
$$;

CREATE TRIGGER "trg_remediations_execution_artifact_immutable"
  BEFORE UPDATE OR DELETE ON "remediations"
  FOR EACH ROW EXECUTE FUNCTION prevent_remediation_execution_artifact_replacement();
