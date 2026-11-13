# Milestone 2B — Organization Ownership and Legacy Project Adoption Design

**Status:** Design proposal incorporating the approved Milestone 2B decisions. No implementation is claimed.

This document describes how CloudPilot can move resource authorization from the legacy `Tenant` boundary to the SaaS `Organization` boundary while preserving Phase 06–08 behavior during an additive transition.

## Decision summary

### Approved for this design

- Organization is the primary authorization boundary for SaaS resources.
- Each Project has one current Organization owner after adoption; an Organization may own many Projects.
- A Tenant may supply Projects to multiple Organizations, and an Organization may contain Projects originating from multiple Tenants. Assignment is per Project, never inferred tenant-wide.
- Keep existing `tenantId` fields and relations during migration as legacy provenance and compatibility context.
- Organization roles and permissions come from active database membership, not JWT role claims.
- Initial adoption uses one-person dual authorization: the same authenticated person must have verified legacy Tenant admin authority and active owner/admin membership in the target Organization.
- Use additive expand → backfill/adopt → validate → switch → contract changes.
- Do not link users by email, perform automatic bulk adoption, introduce RLS prematurely, or implement frontend organization switching in this milestone.
- Preserve the modular monolith and leave Phases 01–05 unchanged.

### Deferred

- PostgreSQL RLS and connection-pool context.
- Frontend organization selection.
- Removing legacy Tenant/User records or resource `tenantId` columns.
- Organization invitations, billing, and broad membership administration.
- Automatic or bulk adoption.

### Unresolved blockers before rollout

1. The current production Entra adapter is single-tenant. A project is eligible for legacy-admin adoption only when its `tenantId` equals the verified Entra `tid` represented by the authenticated context. The repository does not establish that every legacy Tenant row uses this identity convention.
2. The verifier accepts the signed `admin` role claim and maps it to broad Phase 06 permissions, but it cannot establish how the Entra app role was assigned. The app registration and assignment policy must be independently verified to ensure only intended administrators receive `admin`.
3. The code does not query the legacy `User` table for tenant membership or role. If adoption must support Tenant IDs independent of the verified provider `tid`, or requires database-backed legacy admin authority, the existing flow is insufficient; that requires a separately approved authorization design rather than an invented fallback.
4. The policy for cancelling already queued jobs when the initiating user loses membership must be implemented consistently across scan and remediation states. This design specifies the initial behavior below.

## 1. Current authorization facts and legacy Tenant authority

The current Entra claims adapter in `phase-06/src/auth/jwt-verifier.ts` validates the configured issuer/audience, v2 token version, user token type, configured `tid`, allowed `azp`, non-empty `sub`, and recognized `roles`. It maps `tid` to `AuthenticatedIdentity.tenantId`, `sub` to `userId`, and carries signed roles into the legacy context. `phase-08/src/main.ts` configures a single `OIDC_TENANT_ID`. `phase-06/src/rbac/guard.ts` grants legacy permissions when a listed role has the permission; `admin` receives the broad Phase 06 permissions.

`phase-06/src/api/server.ts` derives `tenantId` from the verified identity and tenant-scopes project and child-resource routes. It does not resolve the legacy `User` row to authorize those routes. Therefore, the existing flow can establish legacy Tenant authority for adoption only under these explicit conditions:

1. The token passes the existing production verifier.
2. Its verified tenant context is the project’s exact `tenantId` (`project.tenantId === identity.tenantId === configured OIDC_TENANT_ID`).
3. The signed role claim contains `admin`, and the deployment’s Entra app-role assignment policy has been verified to grant that role only to approved legacy Tenant administrators.
4. The same principal resolves through the exact configured `(issuer, sub)` mapping to an active `IdentityUser`.
5. That local user has an active `owner` or `admin` membership in the destination Organization.

The same request principal must satisfy both the legacy and SaaS checks. The app must not compare emails, infer identity from `Tenant.id`, or accept a browser-supplied actor or role. If any condition is false or cannot be verified, adoption is denied. In particular, do not reinterpret an arbitrary database Tenant ID as an Entra tenant ID.

This is a bounded bridge for the current single-tenant legacy path, not proof of multi-tenant legacy authorization. Before enabling adoption, operators must verify the external Entra role assignment configuration and confirm the eligible Project/Tenant identity convention without changing data.

## 2. Target schema and ownership

### 2.1 Project

Add `Project.organizationId UUID NULL` and a restrictive FK to `Organization.id` during expand. Keep the existing `tenantId`, Tenant FK, names, and tenant-scoped uniqueness. Add a compound unique key `(tenantId, organizationId, id)` for child relationships. A single `organizationId` column enforces at most one current Organization per Project; after the adoption cohort is complete and validated, make it non-null.

`tenantId` remains provenance and compatibility data. It is not part of organization authorization. Do not add a tenant-wide Tenant→Organization authorization mapping: the approved many-to-many origin pattern is represented by project assignments, avoiding ambiguity when one Tenant’s projects belong to different Organizations.

### 2.2 Adoption record

Add a `ProjectOrganizationAdoption` model to preserve request, approval, evidence, and idempotency history. Suggested fields:

| Field | Type / semantics |
|---|---|
| `id` | UUID primary key |
| `tenantId`, `projectId` | Legacy resource identity; composite FK to Project |
| `organizationId` | UUID FK to target Organization |
| `requestedByIdentityUserId` | UUID FK to active local identity |
| `approvedByIdentityUserId` | Nullable UUID FK; required when status is `approved` |
| `status` | `pending`, `approved`, `rejected`, or `revoked`; SQL check constraint |
| `approvedAt` | Nullable timestamp; required for `approved` |
| `provenance` | JSONB evidence/source record; no credentials or tokens |
| `idempotencyKey` | Bounded key supplied for the request |
| `requestHash` | SHA-256 over canonical tenant/project/organization/provenance request |
| `createdAt`, `updatedAt` | Required lifecycle timestamps |

Use `ON DELETE RESTRICT` for Organization, Project, and identity references. Add unique `(requestedByIdentityUserId, idempotencyKey)`. Add a PostgreSQL partial unique index allowing at most one `pending` adoption per Project. The Project row remains the single source of truth for the current Organization; adoption rows are the auditable decision history. A rejected request does not assign the Project. In this initial workflow, revocation applies to a pending request withdrawal; revoking or moving an already-approved assignment is a separate reassignment design and is not exposed here.

The schema should include SQL CHECK constraints for status, non-empty bounded key, and consistency between status and approval fields. Prisma 5.22 does not model PostgreSQL CHECK constraints in its schema language; retain these as reviewed migration SQL and verify them explicitly. Prisma can represent compound unique keys and relations over ordered compound keys, but any migration-only checks or indexes must remain part of the canonical lineage and consistency checks. [Prisma compound relations](https://www.prisma.io/docs/orm/v6/prisma-schema/data-model/relations), [unsupported database features](https://www.prisma.io/docs/orm/v6/prisma-schema/data-model/unsupported-database-features).

### 2.3 Project → Scan → Finding → Remediation integrity

The current schema has an important gap: Finding’s `projectId` is not part of its Scan relation, and Remediation separately references Project, Scan, and Finding without proving that all three refer to the same chain. Add nullable `organizationId` to Scan, Finding, and Remediation during expand. Then add these referenced unique keys:

- Project: `(tenantId, organizationId, id)`
- Scan: `(tenantId, organizationId, projectId, id)`
- Finding: `(tenantId, organizationId, projectId, scanId, id)`

Add composite foreign keys:

- Scan → Project: `(tenantId, organizationId, projectId)`.
- Finding → Scan: `(tenantId, organizationId, projectId, scanId)`.
- Remediation → Project, Scan, and Finding using the full corresponding tuples, including `projectId` and `scanId`.

Keep existing Tenant-scoped FKs and cascade behavior where it is intentional. Organization deletion must be restricted while Projects refer to it. During the nullable transition, PostgreSQL composite FKs with a null organization component do not prove the organization part; validate adopted rows, then make organization ownership non-null for switched records. Before adding the tightened keys, run read-only mismatch checks and repair any existing inconsistencies through reviewed, auditable decisions.

These compound relations are expressible as Prisma relations when the referenced field tuple is backed by a primary/unique key. CHECK constraints and any migration-only integrity objects remain raw SQL and require explicit consistency tests. The runtime must not rely on ORM relation navigation as a substitute for database constraints.

### 2.4 Audit associations

For Project adoption, write both:

- A legacy `AuditEvent` with the actual `tenantId`, project, actor, and adoption action.
- An `OrganizationAuditEvent` with the actual Organization, actor, Project, and adoption action.

Add the minimum nullable typed association fields needed to correlate them to `ProjectOrganizationAdoption` (common `adoptionId`) and to the Project’s `(tenantId, organizationId, projectId)` tuple. Keep old `AuditEvent.actorId` and `resourceId` for compatibility; add an optional `actorIdentityUserId` FK for the local identity. Do not fabricate a Tenant ID for organization-only events. Existing organization-only events continue to use only `OrganizationAuditEvent`.

Write the adoption status change, `Project.organizationId`, both audit rows, and idempotency result in one PostgreSQL transaction. Database FKs ensure each audit row points to the same adoption and the same Project/Organization/Tenant tuple. The transaction ensures either both audit records and the assignment commit, or none do. Do not store tokens, secrets, or unnecessary identity claims in metadata.

## 3. Adoption API and transaction design

Keep current legacy routes unchanged. Add adoption routes as a separate authenticated extension, for example:

- `POST /api/v1/legacy-tenants/:tenantId/projects/:projectId/organization-adoptions` — create/replay a pending adoption request.
- `POST /api/v1/legacy-tenants/:tenantId/projects/:projectId/organization-adoptions/:adoptionId/approve` — approve the pending request.
- `POST .../:adoptionId/reject` — reject it.
- `POST .../:adoptionId/revoke` — withdraw a pending request.

The explicit Tenant/project path is a selector only. The handler must load the Project using the verified Tenant context and return 404 on a mismatch. Request and decision require the signed legacy `admin` permission **and** active local Organization `owner` or `admin` membership for the target Organization. On approval, re-evaluate both authorities; the approver may be the requester, and no second person is required. The same verified issuer/subject must resolve to the same `IdentityUser` used for the membership check.

### Approval transaction

1. Begin a PostgreSQL transaction.
2. Lock the Project row `FOR UPDATE`; verify its `tenantId`, current `organizationId`, and expected status.
3. Lock/read the Organization and the caller’s membership; require active Organization and active `owner`/`admin` membership. Validate the legacy tenant from the already verified request context equals the Project’s `tenantId`, and require `admin` from the signed role claim.
4. Lock/load the adoption row; verify it belongs to this Project and Organization, is pending, and has the expected request hash.
5. If already approved for an identical request, return the recorded result without new audit rows. If the key is reused with a different canonical request, return HTTP 409. If another adoption already owns the Project, reject the competing request; do not silently reassign.
6. Update `Project.organizationId`, adoption status, approver and approval timestamp.
7. Insert the Tenant-side and Organization-side audit events with the same `adoptionId`.
8. Commit; only then return the approved assignment.

The project lock serializes competing idempotency keys for one Project. The membership/Organization read must be serialized against membership revocation and organization suspension (lock those rows in the same transaction or use a transaction isolation strategy with retry on serialization conflict). Database unique constraints remain authoritative; on a unique race, reread the winning adoption and compare request hashes. Never create duplicate audit events on replay.

Use the existing permission behavior only for the legacy check. Do not silently combine legacy JWT roles with organization roles for general resource access. The dual check is specific to the adoption operation and must be visible in code and audit metadata.

## 4. Worker authorization, state, and GitHub reconciliation

### Common rules

Persist `organizationId`, `projectId`, `tenantId`, and the initiating `IdentityUserId` in each new scan/remediation job. On load and immediately before an external operation, verify the Organization is active, the Project still belongs to it, all related resource tuples match, and required integration ownership is valid. Use database membership for the initiating user’s operation permission; do not use JWT roles later inside a worker.

Membership revocation policy:

- Before any external request: if the Organization is inactive, Project ownership changed, or the initiating user is no longer an active member with the required permission, stop and mark the job `cancelled` with a non-retryable authorization reason. Add an explicit terminal `cancelled` state (and migration/API handling); do not overload `failed` or `closed`.
- After an external request may have reached GitHub or timed out ambiguously: do not retry creation blindly. Reconcile all PR states first. If no PR exists and authorization is no longer valid, cancel without creating. If an open PR exists, do no further write and move the job to `manual_review` with the PR reference. If it is merged, persist the already-completed state. A closed unmerged PR remains manual review. Add explicit state/API handling where the current status model cannot represent `manual_review`.
- An in-flight GitHub request cannot be transactionally rolled back. Abort it where supported, fence database writes, then reconcile on the next authorized worker attempt. Reconciliation must never create another branch/PR for the same deterministic remediation identity.

Whether an inactive user should block a job after it has already created a PR is a policy edge case: the safe default in this design is no further GitHub write and manual review, not automatic closure or merge.

GitHub access must be resolved from an active Organization-owned GitHub App installation and its short-lived credential reference. Verify the project’s HTTPS repository URL is within that installation’s authorized repositories before execution. The current global `GITHUB_TOKEN` connector is a compatibility implementation, not the SaaS target. Preserve old tenant-based idempotency keys for existing remediations and reconcile old and new identities during transition to avoid duplicate PRs.

### Phase 06 scan fencing

Add nullable UUID `leaseToken` to Scan during expand. Every successful claim generates a fresh UUID, even when the same worker process/ID reclaims the same Scan. Heartbeat, completion, failure, and reaper writes must match scan ID, tenant ID, organization ID, project ID, `running` status, the exact token, and an unexpired lease evaluated with PostgreSQL time.

The reaper locks expired rows with `FOR UPDATE SKIP LOCKED` and conditionally changes a row only if the selected token remains current and the lease is still expired. Claiming a requeued Scan replaces the token. Findings publication and the transition to `completed` occur in one transaction guarded by the current token. A stale worker cannot delete or replace findings, mark failure, or append a completion audit event after reclaim. Audit writes for terminal scan state should be in the same transaction as the corresponding state/finding write.

The required regression test uses one stable `workerId`: worker A claims token A, its lease expires, the reaper requeues, and the same worker ID claims token B. Worker A then attempts heartbeat, failure, completion, finding replacement, and audit append. Every operation must be rejected; worker B’s result must remain intact.

### Phase 08 remediation fencing

Keep the existing fresh UUID token, database-time lease, conditional renewal/completion/failure/reaper writes. Add Organization and full Project/Scan/Finding tuple checks to claim/load/write predicates. Store the initiating local user ID with the job. Before GitHub writes, revalidate user membership/permission, Organization status, Project ownership, and integration. On retries after ambiguous calls, reconcile open, merged, and closed PR states before any create operation. Do not allow stale workers to persist job or audit results.

## 5. Migration and rollback sequence

### Expand

1. Add nullable organization ownership to Project and child/job rows; add the adoption record and nullable audit correlation/ownership fields.
2. Add the Phase 06 Scan `leaseToken` column and deploy token-aware code before relying on it.
3. Detect current Project/Scan/Finding/Remediation tuple inconsistencies before tightening constraints.
4. Add compound unique keys and composite FKs as additive migrations. Retain Tenant FKs, fields, and legacy APIs.
5. Keep organization resource routes feature-disabled until membership authorization and worker context are complete.

### Backfill/adopt

1. Do not bulk assign or derive an Organization from tenant ID, email, JWT subject, creator, or historical actor string.
2. Require the exact dual authorization defined above for each Project.
3. Record provenance and adoption request idempotency. One adoption approval assigns one Project to one Organization.
4. Propagate the approved Organization from Project to Scan, Finding, and Remediation; never populate children from a tenant-wide guess.
5. Associate project audit events only where the adopted Project proves the association. Leave organization-only and ambiguous historical events without fabricated Tenant/Organization links.

### Validate

Require for the cutover cohort:

- Every Project has exactly one active Organization.
- Every Scan matches its Project’s tenant, organization, and ID.
- Every Finding matches its Scan’s project and organization.
- Every Remediation matches its Project, Scan, and Finding tuple.
- Every organization-associated project audit event matches that tuple.
- No duplicate pending adoption exists; all approved adoption records have approver and timestamp.
- Active membership and required owner/admin authorization work for a user with different roles in two Organizations.
- Same-worker-ID stale scan tests and remediation regression tests pass.

Illustrative read-only validation queries, to be reviewed and run only during implementation against an explicitly approved database:

```sql
SELECT s.id FROM scans s
JOIN projects p ON p.id = s.project_id AND p.tenant_id = s.tenant_id
WHERE s.organization_id IS DISTINCT FROM p.organization_id;

SELECT f.id FROM findings f
JOIN scans s ON s.id = f.scan_id AND s.tenant_id = f.tenant_id
WHERE f.project_id IS DISTINCT FROM s.project_id
   OR f.organization_id IS DISTINCT FROM s.organization_id;

SELECT r.id FROM remediations r
JOIN findings f ON f.id = r.finding_id AND f.tenant_id = r.tenant_id
JOIN projects p ON p.id = r.project_id AND p.tenant_id = r.tenant_id
WHERE r.project_id IS DISTINCT FROM f.project_id
   OR r.scan_id IS DISTINCT FROM f.scan_id
   OR r.organization_id IS DISTINCT FROM f.organization_id
   OR r.organization_id IS DISTINCT FROM p.organization_id;
```

### Switch

Migrate one route family at a time to explicit Organization-scoped paths and DB membership authorization. Keep legacy routes on their current verified Tenant/token-role flow. Carry organization context through jobs, audit, idempotency, and organization-specific GitHub integration selection. A feature flag may route new traffic, but it must not grant access based on either authorization model as a fallback.

### Contract

Only after all API, worker, audit, export, migration, and operational callers use Organization authorization may legacy resource authorization be retired. Keeping `tenantId` as provenance may remain useful even after access control switches; dropping it is a separate decision and migration. Preserve Tenant/User records and adoption/audit provenance unless a separately reviewed data-lifecycle plan authorizes deletion.

### Rollback

- Before switch, disable adoption and organization routes; keep additive columns/history and legacy paths intact.
- Do not erase approved ownership during rollback. Correct a bad assignment only through a separately authorized, audited operation.
- If dual-read checks disagree, fail closed on organization routes and keep legacy compatibility routes available.
- After organization-only writes, application rollback alone may be insufficient; use forward repair or a reviewed reverse migration. Do not reset/rebaseline databases.
- After contract, recovery requires backup/restore or forward migration; retain a verified export of adoption provenance.

## 6. Security and integration test matrix

| Test group | Required assertions |
|---|---|
| Legacy authority | Missing admin; operator/viewer; wrong `tid`; Tenant ID not equal to `tid`; bad issuer; unprovisioned identity; restricted Entra admin assignment verified as deployment prerequisite |
| Same-person dual authorization | Same exact issuer/subject resolves to active IdentityUser and active destination owner/admin; legacy admin without membership denied; member without legacy admin denied; no email linking |
| Adoption lifecycle | Pending, approve, reject, pending withdrawal/revoke; approved assignment cannot be reassigned through adoption endpoint; correct actor and provenance |
| Idempotency/concurrency | Same key/payload replays; same key/different payload conflicts; concurrent same key creates one record and one audit pair; competing keys for one Project serialize; approved Project cannot be assigned to a second Organization |
| Audit atomicity | Both audit records share adoption ID and correct Tenant/Organization/Project; failure inserting either audit row rolls back Project and adoption update; organization-only action does not fabricate Tenant ID |
| Organization API | One user with distinct roles in two Organizations; cross-org list/get/write/cursor denial; spoofed, inactive Organization and revoked membership denied; token role does not override membership |
| Relational integrity | Cross-project Scan/Finding/Remediation combinations rejected by DB; Organization mismatch rejected; legacy Tenant constraints continue to hold |
| Scan worker | Fresh token per claim; same worker ID reclaim; DB-time expiry; stale heartbeat/failure/completion/publication/audit rejected; successful findings and completion atomic |
| Remediation worker | Wrong/suspended Organization; revoked requester; inactive integration; repository not authorized; retry retains owner; ambiguous timeout reconciles PRs; stale token cannot update job/audit |
| Compatibility | Existing Phase 06 Tenant API behavior; Phase 07 executor and idempotency; Phase 08 worker/API lease and retry regressions; old rows remain unchanged until explicitly adopted |

## 7. Implementation milestones

1. **2B.1 — Compatibility proof and integrity precheck:** confirm the legacy `Tenant.id`/Entra `tid` convention and app-role assignment policy; inventory tuple mismatches using read-only checks. No adoption until this gate passes.
2. **2B.2 — Additive ownership schema:** add nullable Project/child organization fields, adoption/audit correlation records, compound keys/FKs, and scan lease token. Preserve every legacy relation.
3. **2B.3 — Adoption service:** implement request/replay, dual-authorized approve/reject/withdraw, project row locking, one-current-assignment invariant, and atomic paired audit writes.
4. **2B.4 — Organization authorization context:** add authenticated organization route context, active membership resolution, role-derived permission checks, and organization-scoped project/resource repositories. Keep existing legacy routes explicit and unchanged.
5. **2B.5 — Worker conversion:** carry organization and initiating-user context into scan/remediation jobs; implement same-worker scan fencing, membership/organization checks, cancellation/manual-review behavior, and per-Organization GitHub installation selection.
6. **2B.6 — Controlled adoption and validation:** adopt projects individually, propagate ownership to children, run reconciliation/negative tests, and switch route families behind a fail-closed rollout gate.
7. **2B.7 — Contract review:** consider removing legacy authorization paths or columns only after measured caller inventory, rollback rehearsal, and owner approval. Tenant/User deletion is not implied.

## 8. Exact current-code blocker and readiness

The existing verified Entra flow **can** establish legacy authority only for the configured single Entra tenant when `Project.tenantId` exactly equals verified `tid`, the signed token contains `admin`, and the external app-role assignment policy is verified. It maps the same validated `sub` and configured issuer to the SaaS `IdentityUser`; exact membership then proves destination Organization authority.

The implementation does **not** provide database-backed legacy Tenant membership authorization, support arbitrary Tenant IDs unrelated to the configured `tid`, or prove Entra app-role assignment policy. Those are concrete scope limits, not grounds to invent a new identity fallback. If any existing Project fails the tenant-ID equality condition, or if the deployment cannot prove the `admin` role assignment is restricted, project adoption is blocked until a separate authorization transition is approved.

The design is ready for implementation planning, but adoption is not ready to enable until Milestone 2B.1 verifies those two deployment/data prerequisites. No source, schema, migration, database, environment, or Git history changes were made for this document.
