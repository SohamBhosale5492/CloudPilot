import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaIdentityResolver } from "../../src/identity/identity-resolver.js";
import { PrismaOrganizationService } from "../../src/organizations/organization-service.js";

const testUrl = process.env.CLOUDPILOT_PHASE08_TEST_DATABASE_URL;
const migrationNames = [
  "20261014000000_init",
  "20261023000000_durable_jobs",
  "20261023100000_remediation",
  "20261023110000_remediation_composite_fk",
  "20261030100000_remediation_worker_leases",
  "20261030110000_remediation_lease_token",
  "20261101120000_saas_identity_organizations",
  "20261101130000_phase06_scan_lease_token",
  "20261101140000_organization_project_ownership_foundation",
  "20261105120000_github_integration_persistence",
  "20261105150000_remediation_approval_foundation",
  "20261105160000_remediation_execution_artifact",
  "20261106120000_remediation_execution_persistence",
  "20261107130000_system_recovery_lease",
  "20261108120000_remote_mutation_rejected",
  "20261109120000_remediation_execution_retry",
  "20261110120000_allow_mutation_rejection_resource_type"
];

function assertDedicatedUrl(value: string | undefined): asserts value is string {
  if (!value) throw new Error("CLOUDPILOT_PHASE08_TEST_DATABASE_URL is required for identity integration tests.");
  const url = new URL(value);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!(["postgres:", "postgresql:"].includes(url.protocol)) ||
      !["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
      url.port !== "56432" || databaseName !== "cloudpilot_phase08_test") {
    throw new Error("Identity integration tests require localhost:56432/cloudpilot_phase08_test; refusing database access.");
  }
}

test("SaaS identity and organization persistence is isolated and transactional", {
  skip: !testUrl ? "requires CLOUDPILOT_PHASE08_TEST_DATABASE_URL for the dedicated Phase 08 database" : false
}, async (t) => {
  assertDedicatedUrl(testUrl);
  const prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
  await prisma.$connect();
  const database = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
  assert.equal(database[0]?.name, "cloudpilot_phase08_test");
  const migrations = await prisma.$queryRaw<Array<{ migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null }>>`
    SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name
  `;
  assert.deepEqual(migrations.map((row) => row.migration_name), migrationNames);
  assert.ok(migrations.every((row) => row.finished_at !== null && row.rolled_back_at === null));
  for (const name of migrationNames) {
    const sql = await readFile(`prisma/migrations/${name}/migration.sql`);
    const recorded = migrations.find((row) => row.migration_name === name)?.checksum;
    assert.equal(recorded, createHash("sha256").update(sql).digest("hex"), `checksum mismatch for ${name}`);
  }

  const identityUserIds = new Set<string>();
  const organizationIds = new Set<string>();
  const legacyTenantIds = new Set<string>();
  const adoptionIds = new Set<string>();
  t.after(async () => {
    const beforeCleanup = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    assert.equal(beforeCleanup[0]?.name, "cloudpilot_phase08_test", "refuse cleanup outside dedicated database");
    await prisma.$transaction(async (tx) => {
      if (organizationIds.size) {
        await tx.organizationAuditEvent.deleteMany({ where: { organizationId: { in: [...organizationIds] } } });
        await tx.organizationMember.deleteMany({ where: { organizationId: { in: [...organizationIds] } } });
      }
      if (adoptionIds.size) {
        await tx.auditEvent.deleteMany({ where: { adoptionId: { in: [...adoptionIds] } } });
        await tx.organizationAuditEvent.deleteMany({ where: { adoptionId: { in: [...adoptionIds] } } });
        await tx.projectOrganizationAdoption.deleteMany({ where: { id: { in: [...adoptionIds] } } });
      }
      if (legacyTenantIds.size) await tx.tenant.deleteMany({ where: { id: { in: [...legacyTenantIds] } } });
      if (organizationIds.size) await tx.organization.deleteMany({ where: { id: { in: [...organizationIds] } } });
      if (identityUserIds.size) {
        await tx.externalIdentity.deleteMany({ where: { userId: { in: [...identityUserIds] } } });
        await tx.organizationMember.deleteMany({ where: { userId: { in: [...identityUserIds] } } });
        await tx.identityUser.deleteMany({ where: { id: { in: [...identityUserIds] } } });
      }
    });
    await prisma.$disconnect();
  });

  const identities = new PrismaIdentityResolver(prisma);
  const organizations = new PrismaOrganizationService(prisma);

  await t.test("concurrent provisioning converges and issuer/subject are both identity dimensions", async () => {
    const issuer = `https://identity.test/${randomUUID()}`;
    const subject = `subject-${randomUUID()}`;
    const winners = await Promise.all(Array.from({ length: 8 }, () => identities.resolve({ issuer, subject }, true)));
    winners.forEach((winner) => identityUserIds.add(winner.id));
    assert.equal(new Set(winners.map((winner) => winner.id)).size, 1);
    assert.equal(await prisma.externalIdentity.count({ where: { issuer, subject } }), 1);

    const sameSubjectOtherIssuer = await identities.resolve({ issuer: `${issuer}/other`, subject }, true);
    identityUserIds.add(sameSubjectOtherIssuer.id);
    assert.notEqual(sameSubjectOtherIssuer.id, winners[0].id);

    const raceIssuer = `${issuer}/race`;
    const raceSubject = `same-${randomUUID()}`;
    const raceWinner = await prisma.identityUser.create({ data: {} });
    identityUserIds.add(raceWinner.id);
    await prisma.externalIdentity.create({ data: { issuer: raceIssuer, subject: raceSubject, userId: raceWinner.id } });
    const losingUserId = randomUUID();
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.identityUser.create({ data: { id: losingUserId } });
      await tx.externalIdentity.create({ data: { issuer: raceIssuer, subject: raceSubject, userId: losingUserId } });
    }), (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002");
    assert.equal(await prisma.identityUser.count({ where: { id: losingUserId } }), 0, "failed identity transaction must not leave an orphan user");

    const sameEmailA = await prisma.identityUser.create({ data: { email: "shared@example.invalid" } });
    const sameEmailB = await prisma.identityUser.create({ data: { email: "shared@example.invalid" } });
    identityUserIds.add(sameEmailA.id);
    identityUserIds.add(sameEmailB.id);
    await prisma.externalIdentity.create({ data: { issuer: `${issuer}/email-a`, subject, userId: sameEmailA.id } });
    await prisma.externalIdentity.create({ data: { issuer: `${issuer}/email-b`, subject, userId: sameEmailB.id } });
    assert.notEqual(sameEmailA.id, sameEmailB.id);
  });

  await t.test("disabled first-use provisioning creates no records and suspended identities are rejected", async () => {
    const disabledIdentity = { issuer: `https://identity.test/${randomUUID()}`, subject: randomUUID() };
    await assert.rejects(identities.resolve(disabledIdentity, false), /not provisioned/);
    assert.equal(await prisma.externalIdentity.count({ where: disabledIdentity }), 0);
    const suspendedUser = await prisma.identityUser.create({ data: { status: "suspended" } });
    identityUserIds.add(suspendedUser.id);
    const suspended = { issuer: `https://identity.test/${randomUUID()}`, subject: randomUUID() };
    await prisma.externalIdentity.create({ data: { ...suspended, userId: suspendedUser.id } });
    await assert.rejects(identities.resolve(suspended, true), /suspended/);
  });

  await t.test("same-key organizations converge, different payload conflicts, distinct keys remain distinct, and audit is atomic", async () => {
    const creator = await prisma.identityUser.create({ data: {} });
    identityUserIds.add(creator.id);
    const key = `create-${randomUUID()}`;
    const concurrent = await Promise.all(Array.from({ length: 6 }, () => organizations.create({
      creatorUserId: creator.id, idempotencyKey: key, displayName: "  Café  Team  "
    }, 5)));
    concurrent.forEach((result) => organizationIds.add(result.organization.id));
    assert.equal(new Set(concurrent.map((result) => result.organization.id)).size, 1);
    assert.ok(concurrent.every((result) => result.membership.role === "owner" && result.membership.status === "active"));
    assert.equal(await prisma.organizationAuditEvent.count({ where: { organizationId: concurrent[0].organization.id } }), 2);
    await assert.rejects(organizations.create({ creatorUserId: creator.id, idempotencyKey: key, displayName: "Different" }, 5), /different request/);

    const distinct = await organizations.create({ creatorUserId: creator.id, idempotencyKey: `other-${randomUUID()}`, displayName: "Other" }, 5);
    organizationIds.add(distinct.organization.id);
    assert.notEqual(distinct.organization.id, concurrent[0].organization.id);
    await assert.rejects(organizations.create({
      creatorUserId: creator.id, idempotencyKey: `over-limit-${randomUUID()}`, displayName: "Over Limit"
    }, 2), /limit reached/);

    const rollbackKey = `rollback-${randomUUID()}`;
    const rollbackHash = createHash("sha256").update(JSON.stringify({ displayName: "Rollback" })).digest("hex");
    const rollbackOrgId = randomUUID();
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.organization.create({ data: {
        id: rollbackOrgId, displayName: "Rollback", status: "active", createdByUserId: creator.id,
        creationIdempotencyKey: rollbackKey, creationRequestHash: rollbackHash
      } });
      await tx.organizationMember.create({ data: {
        organizationId: rollbackOrgId, userId: creator.id, role: "owner", status: "active", createdByUserId: creator.id
      } });
      await tx.organizationAuditEvent.create({
        data: { organizationId: rollbackOrgId, actorUserId: randomUUID(), action: "ORGANIZATION_CREATED", targetType: "organization", targetId: rollbackOrgId, metadata: {} }
      });
    }), (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError);
    assert.equal(await prisma.organization.count({ where: { id: rollbackOrgId } }), 0);
    assert.equal(await prisma.organizationMember.count({ where: { organizationId: rollbackOrgId } }), 0);
    assert.equal(await prisma.organizationAuditEvent.count({ where: { organizationId: rollbackOrgId } }), 0);
  });

  await t.test("organization listing follows per-organization membership and leaves legacy tenant data independent", async () => {
    const member = await prisma.identityUser.create({ data: {} });
    const other = await prisma.identityUser.create({ data: {} });
    identityUserIds.add(member.id);
    identityUserIds.add(other.id);
    const orgA = await organizations.create({ creatorUserId: member.id, idempotencyKey: `a-${randomUUID()}`, displayName: "Org A" }, 5);
    const orgB = await organizations.create({ creatorUserId: other.id, idempotencyKey: `b-${randomUUID()}`, displayName: "Org B" }, 5);
    organizationIds.add(orgA.organization.id);
    organizationIds.add(orgB.organization.id);
    await prisma.organizationMember.create({
      data: { organizationId: orgB.organization.id, userId: member.id, role: "viewer", status: "active", createdByUserId: other.id }
    });
    const page = await organizations.listForUser(member.id, 100);
    assert.deepEqual(new Map(page.items.map((item) => [item.id, item.role])), new Map([
      [orgA.organization.id, "owner"], [orgB.organization.id, "viewer"]
    ]));
    const otherPage = await organizations.listForUser(other.id, 100);
    assert.equal(otherPage.items.some((item) => item.id === orgA.organization.id), false);

    const legacyTenantId = randomUUID();
    legacyTenantIds.add(legacyTenantId);
    await prisma.tenant.create({ data: { id: legacyTenantId, name: "milestone-1c-legacy-fixture" } });
    const project = await prisma.project.create({ data: { tenantId: legacyTenantId, name: `legacy-${randomUUID()}` } });
    assert.equal((await prisma.project.findFirst({ where: { id: project.id, tenantId: legacyTenantId } }))?.id, project.id);
    assert.equal(await prisma.organization.count({ where: { id: legacyTenantId } }), 0);
  });

  await t.test("nullable ownership preserves legacy rows and composite constraints reject cross-organization tuples", async () => {
    const tenantId = randomUUID();
    legacyTenantIds.add(tenantId);
    await prisma.tenant.create({ data: { id: tenantId, name: "milestone-2e-ownership-fixture" } });
    const requester = await prisma.identityUser.create({ data: {} });
    identityUserIds.add(requester.id);
    const orgA = await organizations.create({ creatorUserId: requester.id, idempotencyKey: `own-a-${randomUUID()}`, displayName: "Ownership A" }, 10);
    const orgB = await organizations.create({ creatorUserId: requester.id, idempotencyKey: `own-b-${randomUUID()}`, displayName: "Ownership B" }, 10);
    organizationIds.add(orgA.organization.id);
    organizationIds.add(orgB.organization.id);

    const legacyProject = await prisma.project.create({ data: { tenantId, name: `legacy-${randomUUID()}` } });
    const legacyScan = await prisma.scan.create({ data: { tenantId, projectId: legacyProject.id, status: "completed" } });
    const legacyFinding = await prisma.finding.create({ data: {
      tenantId, projectId: legacyProject.id, scanId: legacyScan.id, requirementId: "req", ruleId: "rule",
      ruleVersion: "1", signal: "metric", outcome: "unknown", expected: "present", observed: "none",
      reason: "legacy fixture", evidenceJson: {}
    } });
    const legacyRemediation = await prisma.remediation.create({ data: {
      tenantId, projectId: legacyProject.id, scanId: legacyScan.id, findingId: legacyFinding.id,
      idempotencyKey: `legacy-${randomUUID()}`, status: "pending"
    } });
    const legacyAudit = await prisma.auditEvent.create({ data: {
      tenantId, projectId: legacyProject.id, actorId: "legacy-test-actor", action: "LEGACY_FIXTURE",
      resourceType: "project", resourceId: legacyProject.id
    } });
    assert.equal(legacyProject.organizationId, null);
    assert.equal(legacyScan.organizationId, null);
    assert.equal(legacyFinding.organizationId, null);
    assert.equal(legacyRemediation.organizationId, null);
    assert.equal(legacyAudit.organizationId, null);

    const adoptedProject = await prisma.project.create({ data: { tenantId, organizationId: orgA.organization.id, name: `org-a-${randomUUID()}` } });
    const adoptedScan = await prisma.scan.create({ data: {
      tenantId, organizationId: orgA.organization.id, projectId: adoptedProject.id, status: "completed"
    } });
    const adoptedFinding = await prisma.finding.create({ data: {
      tenantId, organizationId: orgA.organization.id, projectId: adoptedProject.id, scanId: adoptedScan.id,
      requirementId: "req", ruleId: "rule", ruleVersion: "1", signal: "metric", outcome: "gap",
      expected: "present", observed: "none", reason: "fixture", evidenceJson: {}
    } });

    await assert.rejects(prisma.scan.create({ data: {
      tenantId, organizationId: orgB.organization.id, projectId: adoptedProject.id, status: "completed"
    } }));
    await assert.rejects(prisma.project.create({ data: {
      tenantId, organizationId: randomUUID(), name: `invalid-org-${randomUUID()}`
    } }));
    await assert.rejects(prisma.finding.create({ data: {
      tenantId, organizationId: orgB.organization.id, projectId: adoptedProject.id, scanId: adoptedScan.id,
      requirementId: "req", ruleId: "rule", ruleVersion: "1", signal: "metric", outcome: "gap",
      expected: "present", observed: "none", reason: "mismatch", evidenceJson: {}
    } }));
    await assert.rejects(prisma.remediation.create({ data: {
      tenantId, organizationId: orgB.organization.id, projectId: adoptedProject.id, scanId: adoptedScan.id,
      findingId: adoptedFinding.id, idempotencyKey: `mismatch-${randomUUID()}`, status: "pending"
    } }));

    const adoptionId = randomUUID();
    await prisma.projectOrganizationAdoption.create({ data: {
      id: adoptionId, tenantId, projectId: legacyProject.id, organizationId: orgA.organization.id,
      requestedByIdentityUserId: requester.id, idempotencyKey: `adopt-${randomUUID()}`,
      requestHash: createHash("sha256").update(legacyProject.id).digest("hex"), provenance: { source: "synthetic-fixture" }
    } });
    adoptionIds.add(adoptionId);
    await assert.rejects(prisma.projectOrganizationAdoption.create({ data: {
      id: randomUUID(), tenantId, projectId: legacyProject.id, organizationId: orgB.organization.id,
      requestedByIdentityUserId: requester.id, idempotencyKey: `adopt-${randomUUID()}`,
      requestHash: createHash("sha256").update("second-pending").digest("hex"), provenance: {}
    } }), "only one pending adoption may exist per legacy project");
  });
});
