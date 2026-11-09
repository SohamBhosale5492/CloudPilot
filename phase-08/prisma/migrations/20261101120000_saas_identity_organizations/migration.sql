-- Add CloudPilot-owned identities and organizations without changing legacy tenants or users.
CREATE TABLE "identity_users" (
    "id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "display_name" TEXT,
    "email" TEXT,
    "email_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_authenticated_at" TIMESTAMP(3),
    CONSTRAINT "identity_users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_identity_users_status" CHECK ("status" IN ('active', 'suspended'))
);

CREATE INDEX "idx_identity_users_status_created"
  ON "identity_users"("status", "created_at" DESC);

CREATE TABLE "external_identities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_authenticated_at" TIMESTAMP(3),
    CONSTRAINT "external_identities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_external_identities_issuer_subject_size" CHECK (
      octet_length("issuer") BETWEEN 1 AND 512 AND octet_length("subject") BETWEEN 1 AND 512
    ),
    CONSTRAINT "uq_external_identities_issuer_subject" UNIQUE ("issuer", "subject"),
    CONSTRAINT "fk_external_identities_user" FOREIGN KEY ("user_id")
      REFERENCES "identity_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "idx_external_identities_user" ON "external_identities"("user_id");

CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by_user_id" UUID NOT NULL,
    "creation_idempotency_key" VARCHAR(128) NOT NULL,
    "creation_request_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_organizations_status" CHECK ("status" IN ('active', 'suspended')),
    CONSTRAINT "ck_organizations_display_name" CHECK (
      "display_name" = btrim("display_name") AND char_length("display_name") BETWEEN 1 AND 120
      AND "display_name" = normalize("display_name", NFC)
    ),
    CONSTRAINT "ck_organizations_idempotency_key" CHECK (
      char_length("creation_idempotency_key") BETWEEN 1 AND 128
      AND "creation_idempotency_key" = btrim("creation_idempotency_key")
      AND "creation_idempotency_key" ~ '^[A-Za-z0-9._:-]+$'
    ),
    CONSTRAINT "ck_organizations_request_hash" CHECK ("creation_request_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "uq_organizations_creator_idempotency" UNIQUE ("created_by_user_id", "creation_idempotency_key"),
    CONSTRAINT "fk_organizations_creator" FOREIGN KEY ("created_by_user_id")
      REFERENCES "identity_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "idx_organizations_status_created"
  ON "organizations"("status", "created_at" DESC, "id" DESC);

CREATE TABLE "organization_members" (
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    CONSTRAINT "pk_organization_members" PRIMARY KEY ("organization_id", "user_id"),
    CONSTRAINT "ck_organization_members_role" CHECK ("role" IN ('owner', 'admin', 'operator', 'viewer')),
    CONSTRAINT "ck_organization_members_status" CHECK ("status" IN ('active', 'suspended', 'revoked')),
    CONSTRAINT "ck_organization_members_revoked_at" CHECK (
      ("status" = 'revoked' AND "revoked_at" IS NOT NULL)
      OR ("status" <> 'revoked' AND "revoked_at" IS NULL)
    ),
    CONSTRAINT "fk_organization_members_organization" FOREIGN KEY ("organization_id")
      REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "fk_organization_members_user" FOREIGN KEY ("user_id")
      REFERENCES "identity_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "fk_organization_members_creator" FOREIGN KEY ("created_by_user_id")
      REFERENCES "identity_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "idx_org_members_user_status" ON "organization_members"("user_id", "status", "organization_id");
CREATE INDEX "idx_org_members_org_role" ON "organization_members"("organization_id", "status", "role", "user_id");

CREATE TABLE "organization_audit_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organization_audit_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_org_audit_organization" FOREIGN KEY ("organization_id")
      REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "fk_org_audit_actor" FOREIGN KEY ("actor_user_id")
      REFERENCES "identity_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

ALTER TABLE "organization_audit_events"
  ADD CONSTRAINT "ck_org_audit_action_target" CHECK (
    char_length("action") BETWEEN 1 AND 128 AND "action" = btrim("action")
    AND char_length("target_type") BETWEEN 1 AND 128 AND "target_type" = btrim("target_type")
    AND char_length("target_id") BETWEEN 1 AND 256
  ),
  ADD CONSTRAINT "ck_org_audit_metadata_object" CHECK (jsonb_typeof("metadata") = 'object');

CREATE INDEX "idx_org_audit_org_created"
  ON "organization_audit_events"("organization_id", "created_at" DESC, "id" DESC);
CREATE INDEX "idx_org_audit_target"
  ON "organization_audit_events"("organization_id", "target_type", "target_id");
