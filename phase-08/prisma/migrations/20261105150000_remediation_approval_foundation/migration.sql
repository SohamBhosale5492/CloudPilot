-- Stage 3E.3 Stage A: additive, fail-closed proposal identity and approval.
-- Historical remediation rows remain NULL in these new fields; no requester or
-- approval information is inferred or backfilled.

ALTER TABLE "remediations"
  ADD COLUMN "requested_by_identity_user_id" UUID,
  ADD COLUMN "repository_binding_id" UUID,
  ADD COLUMN "github_repository_id" BIGINT,
  ADD COLUMN "plan_hash" VARCHAR(64),
  ADD COLUMN "plan_snapshot" JSONB,
  ADD COLUMN "approval_state" VARCHAR(16),
  ADD COLUMN "approved_by_identity_user_id" UUID,
  ADD COLUMN "approved_at" TIMESTAMP(3),
  ADD COLUMN "rejected_by_identity_user_id" UUID,
  ADD COLUMN "rejected_at" TIMESTAMP(3),
  ADD COLUMN "invalidated_by_identity_user_id" UUID,
  ADD COLUMN "invalidated_at" TIMESTAMP(3);

-- The referenced composite key makes a proposal's binding, tenant, organization,
-- project and immutable GitHub repository ID agree at the database boundary.
CREATE UNIQUE INDEX "uq_project_github_repo_remediation_ref"
  ON "project_github_repositories"(
    "tenant_id", "organization_id", "project_id", "id", "github_repository_id"
  );

ALTER TABLE "remediations"
  ADD CONSTRAINT "remediations_requester_fkey"
    FOREIGN KEY ("requested_by_identity_user_id") REFERENCES "identity_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "remediations_approver_fkey"
    FOREIGN KEY ("approved_by_identity_user_id") REFERENCES "identity_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "remediations_rejector_fkey"
    FOREIGN KEY ("rejected_by_identity_user_id") REFERENCES "identity_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "remediations_invalidator_fkey"
    FOREIGN KEY ("invalidated_by_identity_user_id") REFERENCES "identity_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "remediations_repository_binding_fkey"
    FOREIGN KEY (
      "tenant_id", "organization_id", "project_id", "repository_binding_id", "github_repository_id"
    ) REFERENCES "project_github_repositories"(
      "tenant_id", "organization_id", "project_id", "id", "github_repository_id"
    ) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_remediations_approval_state" CHECK ("approval_state" IS NULL OR "approval_state" IN ('pending', 'approved', 'rejected', 'invalidated')),
  ADD CONSTRAINT "ck_remediations_proposal_context" CHECK (
      ("approval_state" IS NULL
        AND "requested_by_identity_user_id" IS NULL
        AND "repository_binding_id" IS NULL
        AND "github_repository_id" IS NULL
        AND "plan_hash" IS NULL
        AND "plan_snapshot" IS NULL
        AND "approved_by_identity_user_id" IS NULL AND "approved_at" IS NULL
        AND "rejected_by_identity_user_id" IS NULL AND "rejected_at" IS NULL
        AND "invalidated_by_identity_user_id" IS NULL AND "invalidated_at" IS NULL)
      OR
      ("approval_state" IS NOT NULL
        AND "organization_id" IS NOT NULL
        AND "requested_by_identity_user_id" IS NOT NULL
        AND "repository_binding_id" IS NOT NULL
        AND "github_repository_id" > 0
        AND "plan_hash" IS NOT NULL AND "plan_hash" ~ '^[0-9a-f]{64}$'
        AND "plan_snapshot" IS NOT NULL AND jsonb_typeof("plan_snapshot") = 'object'
        AND octet_length("plan_snapshot"::text) <= 65536)
    ),
  ADD CONSTRAINT "ck_remediations_approval_timestamps" CHECK (
      "approval_state" IS NULL
      OR ("approval_state" = 'pending'
        AND "approved_by_identity_user_id" IS NULL AND "approved_at" IS NULL
        AND "rejected_by_identity_user_id" IS NULL AND "rejected_at" IS NULL
        AND "invalidated_by_identity_user_id" IS NULL AND "invalidated_at" IS NULL)
      OR ("approval_state" = 'approved'
        AND "approved_by_identity_user_id" IS NOT NULL AND "approved_at" IS NOT NULL
        AND "rejected_by_identity_user_id" IS NULL AND "rejected_at" IS NULL
        AND "invalidated_by_identity_user_id" IS NULL AND "invalidated_at" IS NULL)
      OR ("approval_state" = 'rejected'
        AND "approved_by_identity_user_id" IS NULL AND "approved_at" IS NULL
        AND "rejected_by_identity_user_id" IS NOT NULL AND "rejected_at" IS NOT NULL
        AND "invalidated_by_identity_user_id" IS NULL AND "invalidated_at" IS NULL)
      OR ("approval_state" = 'invalidated'
        AND "rejected_by_identity_user_id" IS NULL AND "rejected_at" IS NULL
        AND "invalidated_by_identity_user_id" IS NOT NULL AND "invalidated_at" IS NOT NULL
        AND (("approved_by_identity_user_id" IS NULL AND "approved_at" IS NULL)
          OR ("approved_by_identity_user_id" IS NOT NULL AND "approved_at" IS NOT NULL)))
    );

CREATE INDEX "idx_remediations_approval_inbox"
  ON "remediations"("organization_id", "approval_state", "created_at" DESC);
CREATE INDEX "idx_remediations_requested_by"
  ON "remediations"("requested_by_identity_user_id", "created_at" DESC);
CREATE INDEX "idx_remediations_repository_binding"
  ON "remediations"("repository_binding_id");
