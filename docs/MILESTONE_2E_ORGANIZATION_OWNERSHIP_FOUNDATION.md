# Milestone 2E — Additive Organization Ownership Foundation

**Status:** Schema and migration prepared for review. The migration has not been applied by this milestone.

## Scope

The canonical Phase 08 Prisma schema adds nullable UUID `organizationId` fields to `Project`, `Scan`, `Finding`, `Remediation`, and project-associated `AuditEvent` records. `OrganizationAuditEvent` gains nullable legacy tenant, project, and adoption correlation fields. `ProjectOrganizationAdoption` records the legacy tenant/project, target organization, requester, optional approver, lifecycle timestamps, idempotency data, provenance, and timestamps.

Existing `Tenant`, `User`, tenant identifiers, relationships, and authorization behavior are retained. No existing resource receives an organization ID, and no `Tenant` is treated as an `Organization`.

## Integrity introduced

- Compound unique keys identify project, scan, and finding tuples containing tenant, organization, and parent resource identifiers.
- Nullable composite foreign keys connect organization-owned scans to their project, findings to their scan, and remediations to the matching project, scan, and finding chain. Legacy rows with NULL organization IDs remain valid under PostgreSQL's default `MATCH SIMPLE` behavior.
- Organization-linked project audit records are constrained to the corresponding project tuple. Adoption references and audit correlations are tenant-, organization-, and project-scoped.
- Adoption rows have status/timestamp, key, request-hash, and provenance checks, a requester/idempotency uniqueness constraint, and a partial unique index allowing at most one pending adoption per project.
- Existing tenant-scoped foreign keys remain in place. No historical migration is changed.

The new partial unique index is intentionally represented in SQL because Prisma's schema syntax does not express its predicate. The lineage verifier checks that this additive migration contains the required ownership/adoption structures and no destructive SQL.

## Compatibility and deferred integrity

The migration adds columns without defaults or backfill, so existing rows read as NULL and retain their current Tenant ownership. New organization-owned tuples receive compound consistency checks. Unadopted legacy tuples remain subject to the pre-existing constraints; this foundation does not prove every historical Scan/Finding/Remediation chain is consistent.

`ProjectOrganizationAdoption` is only a persistence model. There is no adoption endpoint, workflow, automatic tenant mapping, user assignment, backfill, organization-scoped API authorization, or worker ownership switch. No authentication, frontend, GitHub, or database-runtime behavior changes are included.

## Migration and rollback

The migration is chronological and additive. It must be reviewed and applied only through the documented Phase 08 migration deployment procedure after the target database, migration lineage, backup, and rollback plan are verified. It must not be applied automatically at application startup. Do not roll back by dropping the new columns/table after adoption data has been created: review retention and audit implications and use a forward correction plan. This work does not connect to PostgreSQL or apply the migration.

## Validation boundary

Offline schema validation, generated-client checks, lineage verification, typechecks, and unit tests can validate repository consistency. They do not prove live migration compatibility or production data integrity. Dedicated PostgreSQL integration testing and operational approval remain separate prerequisites before migration deployment.
