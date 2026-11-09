-- Add organization-scoped GitHub App metadata. No credentials or raw webhook bodies are stored.

-- Existing audit rows remain user-authored. New system-originated audit rows use
-- actor_type='system' and a constrained system_actor_id instead of a fake user.
ALTER TABLE "organization_audit_events"
  ADD COLUMN "actor_type" VARCHAR(16) NOT NULL DEFAULT 'user',
  ADD COLUMN "system_actor_id" VARCHAR(64);
ALTER TABLE "organization_audit_events"
  ALTER COLUMN "actor_user_id" DROP NOT NULL;
ALTER TABLE "organization_audit_events"
  ADD CONSTRAINT "ck_org_audit_actor_representation" CHECK (
    ("actor_type" = 'user' AND "actor_user_id" IS NOT NULL AND "system_actor_id" IS NULL)
    OR
    ("actor_type" = 'system' AND "actor_user_id" IS NULL
      AND "system_actor_id" IS NOT NULL
      AND "system_actor_id" = btrim("system_actor_id")
      AND "system_actor_id" ~ '^[a-z][a-z0-9_.:-]{0,63}$')
  );
CREATE INDEX "idx_org_audit_actor_type_created"
  ON "organization_audit_events"("organization_id", "actor_type", "created_at" DESC);

CREATE TABLE "organization_github_installations" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "github_installation_id" BIGINT NOT NULL,
  "github_account_id" BIGINT NOT NULL,
  "github_account_login" VARCHAR(100) NOT NULL,
  "github_account_type" VARCHAR(32) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'active',
  "verified_permissions" JSONB NOT NULL,
  "connected_by_identity_user_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "disconnected_at" TIMESTAMP(3),
  CONSTRAINT "organization_github_installations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uq_github_installations_github_id" UNIQUE ("github_installation_id"),
  CONSTRAINT "uq_github_installations_org_id" UNIQUE ("organization_id", "id"),
  CONSTRAINT "ck_github_installations_positive_ids" CHECK ("github_installation_id" > 0 AND "github_account_id" > 0),
  CONSTRAINT "ck_github_installations_metadata" CHECK (
    char_length(btrim("github_account_login")) > 0
    AND char_length(btrim("github_account_type")) > 0
    AND jsonb_typeof("verified_permissions") = 'object'
  ),
  CONSTRAINT "ck_github_installations_status" CHECK (
    ("status" IN ('active', 'suspended') AND "disconnected_at" IS NULL)
    OR ("status" IN ('revoked', 'disconnected') AND "disconnected_at" IS NOT NULL)
  ),
  CONSTRAINT "organization_github_installations_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "organization_github_installations_connected_by_fkey"
    FOREIGN KEY ("connected_by_identity_user_id") REFERENCES "identity_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "idx_github_installations_org_status"
  ON "organization_github_installations"("organization_id", "status");
CREATE INDEX "idx_github_installations_connected_by"
  ON "organization_github_installations"("connected_by_identity_user_id");

CREATE TABLE "project_github_repositories" (
  "id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "organization_id" UUID NOT NULL,
  "project_id" TEXT NOT NULL,
  "installation_record_id" UUID NOT NULL,
  "github_repository_id" BIGINT NOT NULL,
  "owner_login" VARCHAR(100) NOT NULL,
  "repository_name" VARCHAR(100) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'active',
  "connected_by_identity_user_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "disconnected_at" TIMESTAMP(3),
  CONSTRAINT "project_github_repositories_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ck_project_github_repositories_positive_id" CHECK ("github_repository_id" > 0),
  CONSTRAINT "ck_project_github_repositories_metadata" CHECK (
    char_length(btrim("owner_login")) > 0 AND char_length(btrim("repository_name")) > 0
  ),
  CONSTRAINT "ck_project_github_repositories_status" CHECK (
    ("status" = 'active' AND "disconnected_at" IS NULL)
    OR ("status" IN ('disconnected', 'revoked') AND "disconnected_at" IS NOT NULL)
  ),
  CONSTRAINT "project_github_repositories_project_fkey"
    FOREIGN KEY ("tenant_id", "organization_id", "project_id")
    REFERENCES "projects"("tenant_id", "organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "project_github_repositories_installation_fkey"
    FOREIGN KEY ("organization_id", "installation_record_id")
    REFERENCES "organization_github_installations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "project_github_repositories_connected_by_fkey"
    FOREIGN KEY ("connected_by_identity_user_id") REFERENCES "identity_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "idx_project_github_repos_project_status"
  ON "project_github_repositories"("tenant_id", "organization_id", "project_id", "status");
CREATE INDEX "idx_project_github_repos_org_status"
  ON "project_github_repositories"("organization_id", "status");
CREATE INDEX "idx_project_github_repos_installation"
  ON "project_github_repositories"("installation_record_id");
CREATE INDEX "idx_project_github_repos_repo"
  ON "project_github_repositories"("organization_id", "github_repository_id");
CREATE INDEX "idx_project_github_repos_connected_by"
  ON "project_github_repositories"("connected_by_identity_user_id");
-- Keep disconnected history, while allowing only one current binding per project
-- and preventing the same immutable repository being bound twice in one org.
CREATE UNIQUE INDEX "uq_project_github_repos_active_project"
  ON "project_github_repositories"("tenant_id", "organization_id", "project_id")
  WHERE "status" = 'active';
CREATE UNIQUE INDEX "uq_project_github_repos_active_repo"
  ON "project_github_repositories"("organization_id", "github_repository_id")
  WHERE "status" = 'active';

CREATE TABLE "github_connect_intents" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "initiated_by_identity_user_id" UUID NOT NULL,
  "state_hash" CHAR(64) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "github_connect_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uq_github_connect_intents_state_hash" UNIQUE ("state_hash"),
  CONSTRAINT "ck_github_connect_intents_state_hash" CHECK ("state_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ck_github_connect_intents_expiry" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "github_connect_intents_organization_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "github_connect_intents_user_fkey"
    FOREIGN KEY ("initiated_by_identity_user_id") REFERENCES "identity_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "idx_github_connect_intents_org_expiry"
  ON "github_connect_intents"("organization_id", "expires_at");
CREATE INDEX "idx_github_connect_intents_user_expiry"
  ON "github_connect_intents"("initiated_by_identity_user_id", "expires_at");
CREATE INDEX "idx_github_connect_intents_expiry"
  ON "github_connect_intents"("expires_at");

CREATE TABLE "github_webhook_deliveries" (
  "id" UUID NOT NULL,
  "github_delivery_id" VARCHAR(128) NOT NULL,
  "event_name" VARCHAR(100) NOT NULL,
  "action" VARCHAR(100),
  "github_installation_id" BIGINT,
  "github_repository_id" BIGINT,
  "organization_id" UUID,
  "payload_hash" CHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'received',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP(3),
  "safe_error_code" VARCHAR(64),
  CONSTRAINT "github_webhook_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uq_github_webhook_deliveries_delivery_id" UNIQUE ("github_delivery_id"),
  CONSTRAINT "ck_github_webhook_deliveries_metadata" CHECK (
    char_length(btrim("github_delivery_id")) > 0
    AND char_length(btrim("event_name")) > 0
    AND "payload_hash" ~ '^[0-9a-f]{64}$'
    AND ("github_installation_id" IS NULL OR "github_installation_id" > 0)
    AND ("github_repository_id" IS NULL OR "github_repository_id" > 0)
    AND "attempt_count" >= 0
  ),
  CONSTRAINT "ck_github_webhook_deliveries_status" CHECK (
    "status" IN ('received', 'processing', 'processed', 'ignored', 'failed')
  ),
  CONSTRAINT "ck_github_webhook_deliveries_error_code" CHECK (
    "safe_error_code" IS NULL OR "safe_error_code" ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  CONSTRAINT "ck_github_webhook_deliveries_processed_at" CHECK (
    ("status" IN ('processed', 'ignored') AND "processed_at" IS NOT NULL)
    OR ("status" NOT IN ('processed', 'ignored') AND "processed_at" IS NULL)
  ),
  CONSTRAINT "github_webhook_deliveries_organization_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "idx_github_webhook_install_received"
  ON "github_webhook_deliveries"("github_installation_id", "received_at" DESC);
CREATE INDEX "idx_github_webhook_repo_received"
  ON "github_webhook_deliveries"("github_repository_id", "received_at" DESC);
CREATE INDEX "idx_github_webhook_org_received"
  ON "github_webhook_deliveries"("organization_id", "received_at" DESC);
CREATE INDEX "idx_github_webhook_status_received"
  ON "github_webhook_deliveries"("status", "received_at");
CREATE INDEX "idx_github_webhook_received"
  ON "github_webhook_deliveries"("received_at");
