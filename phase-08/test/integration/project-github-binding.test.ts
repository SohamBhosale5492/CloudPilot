import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { ProjectGitHubBindingError, ProjectGitHubBindingService } from "../../src/organizations/project-github-binding-service.js";
import { parsePhase08AcceptanceDatabase } from "./acceptance-database.js";

const acceptanceDatabase = parsePhase08AcceptanceDatabase(process.env.CLOUDPILOT_PHASE08_ACCEPTANCE_TEST_DATABASE_URL);
const DATABASE_NAME = acceptanceDatabase?.database ?? "cloudpilot_phase08_test";
const DATABASE_USER = acceptanceDatabase?.username ?? "cloudpilot_phase08_test";
const DATABASE_PORT = acceptanceDatabase?.port ?? "56432";
const CONTAINER_POSTGRES_PORT = 5432;
const APPROVED_HOSTS = new Set(["127.0.0.1", "localhost"]);
const MIGRATIONS = [
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
  "20261110120000_allow_mutation_rejection_resource_type",
  "20261111120000_runtime_lock_helpers"
] as const;

function requireDedicatedDatabaseUrl(value: string | undefined): string {
  if (acceptanceDatabase) {
    if (value !== undefined && value !== acceptanceDatabase.url) throw new Error("Refusing conflicting database URL configuration.");
    return acceptanceDatabase.url;
  }
  if (!value) throw new Error("CLOUDPILOT_PHASE08_TEST_DATABASE_URL is required; refusing database access.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CLOUDPILOT_PHASE08_TEST_DATABASE_URL is malformed; refusing database access.");
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const hasConnectionOverrides = [...url.searchParams.keys()].some((key) => ["host", "port", "hostaddr"].includes(key.toLowerCase()));
  if (!(["postgres:", "postgresql:"].includes(url.protocol) &&
      APPROVED_HOSTS.has(url.hostname) &&
      url.port === DATABASE_PORT &&
      databaseName === DATABASE_NAME &&
      !url.hash &&
      !hasConnectionOverrides)) {
    throw new Error("Refusing database access outside loopback:56432/cloudpilot_phase08_test.");
  }
  return value;
}

// Validate at module load, before constructing a PrismaClient or issuing any query.
const testDatabaseUrl = requireDedicatedDatabaseUrl(acceptanceDatabase ? undefined : process.env.CLOUDPILOT_PHASE08_TEST_DATABASE_URL);

type OrganizationFixture = {
  tenantId: string;
  userId: string;
  organizationId: string;
  installationRecordId: string;
  githubInstallationId: bigint;
};

type ProjectFixture = OrganizationFixture & { projectId: string };

const fixtureIds = {
  tenants: new Set<string>(),
  users: new Set<string>(),
  organizations: new Set<string>(),
  memberships: new Set<string>(),
  projects: new Set<string>(),
  adoptions: new Set<string>(),
  installations: new Set<string>(),
  bindings: new Set<string>()
};

let repositoryIdSequence = BigInt(Date.now()) * 1_000_000n;
let installationIdSequence = BigInt(Date.now()) * 1_000_000n;
const nextRepositoryId = () => (++repositoryIdSequence).toString();
const nextInstallationId = () => ++installationIdSequence;
const requestHash = () => createHash("sha256").update(randomUUID()).digest("hex");

function isExpectedDatabaseServerAddress(address: string | null): boolean {
  if (!address) return false;
  const pieces = address.trim().split("/");
  if (pieces.length > 2 || !pieces[0]) return false;
  const rawAddress = pieces[0].toLowerCase();
  const isIpv6 = rawAddress.includes(":");
  if (pieces.length === 2 && (!/^\d+$/.test(pieces[1]) || Number(pieces[1]) !== (isIpv6 ? 128 : 32))) return false;
  const normalized = rawAddress.replace(/^::ffff:/, "");
  if (normalized === "::1") return true;
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(normalized)) return false;
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 127 ||
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

async function assertDatabaseIdentity(prisma: PrismaClient): Promise<void> {
  const identity = await prisma.$queryRaw<Array<{
    database: string;
    user: string;
    server_address: string | null;
    server_port: number;
  }>>`
    SELECT current_database() AS database,
           current_user AS user,
           inet_server_addr()::text AS server_address,
           inet_server_port() AS server_port
  `;
  assert.equal(identity[0]?.database, DATABASE_NAME, "refuse access outside the dedicated database");
  assert.equal(identity[0]?.user, DATABASE_USER, "refuse access with an unexpected database user");
  assert.ok(isExpectedDatabaseServerAddress(identity[0]?.server_address ?? null), "refuse an unexpected PostgreSQL server address");
  assert.equal(identity[0]?.server_port, CONTAINER_POSTGRES_PORT, "the dedicated container must expose PostgreSQL on its internal port");
}

async function verifyDatabasePreflight(prisma: PrismaClient): Promise<void> {
  await assertDatabaseIdentity(prisma);

  const migrations = await prisma.$queryRaw<Array<{
    migration_name: string;
    checksum: string;
    finished_at: Date | null;
    rolled_back_at: Date | null;
  }>>`
    SELECT migration_name, checksum, finished_at, rolled_back_at
    FROM "_prisma_migrations"
    ORDER BY migration_name
  `;
  assert.deepEqual(migrations.map((row) => row.migration_name), [...MIGRATIONS], "canonical migration history must be current");
  assert.ok(migrations.every((row) => row.finished_at !== null && row.rolled_back_at === null), "all migrations must be finished and not rolled back");
  for (const name of MIGRATIONS) {
    const sql = await readFile(resolve("prisma", "migrations", name, "migration.sql"));
    assert.equal(
      migrations.find((row) => row.migration_name === name)?.checksum,
      createHash("sha256").update(sql).digest("hex"),
      `canonical migration checksum mismatch for ${name}`
    );
  }

  const requiredTables = [
    "tenants", "identity_users", "organizations", "organization_members", "projects",
    "project_organization_adoptions", "organization_audit_events", "organization_github_installations",
    "project_github_repositories", "github_connect_intents", "github_webhook_deliveries"
  ];
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
  `;
  const tableNames = new Set(tables.map((row) => row.table_name));
  for (const name of requiredTables) assert.ok(tableNames.has(name), `required table ${name} is missing`);

  const indexes = await prisma.$queryRaw<Array<{
    name: string;
    is_unique: boolean;
    columns: string[];
    predicate: string | null;
  }>>`
    SELECT index_class.relname AS name,
           index_data.indisunique AS is_unique,
           ARRAY(
             SELECT attribute.attname
             FROM unnest(index_data.indkey) WITH ORDINALITY AS index_key(attnum, ordinality)
             JOIN pg_attribute AS attribute
               ON attribute.attrelid = index_data.indrelid AND attribute.attnum = index_key.attnum
             ORDER BY index_key.ordinality
           ) AS columns,
           pg_get_expr(index_data.indpred, index_data.indrelid) AS predicate
    FROM pg_index AS index_data
    JOIN pg_class AS index_class ON index_class.oid = index_data.indexrelid
    JOIN pg_class AS table_class ON table_class.oid = index_data.indrelid
    JOIN pg_namespace AS namespace ON namespace.oid = table_class.relnamespace
    WHERE namespace.nspname = current_schema()
      AND table_class.relname = 'project_github_repositories'
      AND index_class.relname IN (
        'uq_project_github_repos_active_project',
        'uq_project_github_repos_active_repo'
      )
  `;
  const normalizedPredicate = (value: string | null) =>
    value?.toLowerCase().replace(/::text/g, "").replace(/[()\s"]/g, "") ?? null;
  const projectIndex = indexes.find((index) => index.name === "uq_project_github_repos_active_project");
  const repositoryIndex = indexes.find((index) => index.name === "uq_project_github_repos_active_repo");
  assert.ok(projectIndex, "active-project partial unique index is missing");
  assert.ok(repositoryIndex, "active-repository partial unique index is missing");
  assert.equal(projectIndex.is_unique, true);
  assert.deepEqual(projectIndex.columns, ["tenant_id", "organization_id", "project_id"]);
  assert.equal(normalizedPredicate(projectIndex.predicate), "status='active'");
  assert.equal(repositoryIndex.is_unique, true);
  assert.deepEqual(repositoryIndex.columns, ["organization_id", "github_repository_id"]);
  assert.equal(normalizedPredicate(repositoryIndex.predicate), "status='active'");
}

async function createOrganizationFixture(prisma: PrismaClient, label: string): Promise<OrganizationFixture> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const organizationId = randomUUID();
  const installationRecordId = randomUUID();
  const githubInstallationId = nextInstallationId();
  fixtureIds.tenants.add(tenantId);
  fixtureIds.users.add(userId);
  fixtureIds.organizations.add(organizationId);
  fixtureIds.memberships.add(`${organizationId}:${userId}`);
  fixtureIds.installations.add(installationRecordId);

  await prisma.tenant.create({ data: { id: tenantId, name: `binding-fixture-${tenantId}` } });
  await prisma.identityUser.create({ data: { id: userId, status: "active" } });
  await prisma.organization.create({ data: {
    id: organizationId,
    displayName: `Binding fixture ${label}`,
    status: "active",
    createdByUserId: userId,
    creationIdempotencyKey: `binding-${randomUUID()}`,
    creationRequestHash: requestHash()
  } });
  await prisma.organizationMember.create({ data: {
    organizationId, userId, role: "owner", status: "active", createdByUserId: userId
  } });
  await prisma.organizationGitHubInstallation.create({ data: {
    id: installationRecordId,
    organizationId,
    githubInstallationId,
    githubAccountId: githubInstallationId + 1n,
    githubAccountLogin: `fixture-${label}`.slice(0, 100),
    githubAccountType: "Organization",
    status: "active",
    verifiedPermissions: { metadata: "read" },
    connectedByIdentityUserId: userId
  } });
  return { tenantId, userId, organizationId, installationRecordId, githubInstallationId };
}

async function createAdoptedProject(prisma: PrismaClient, organization: OrganizationFixture, label: string): Promise<ProjectFixture> {
  const projectId = randomUUID();
  const adoptionId = randomUUID();
  fixtureIds.projects.add(projectId);
  fixtureIds.adoptions.add(adoptionId);
  await prisma.project.create({ data: {
    id: projectId,
    tenantId: organization.tenantId,
    organizationId: organization.organizationId,
    name: `binding-${label}-${projectId}`
  } });
  await prisma.projectOrganizationAdoption.create({ data: {
    id: adoptionId,
    tenantId: organization.tenantId,
    projectId,
    organizationId: organization.organizationId,
    requestedByIdentityUserId: organization.userId,
    approvedByIdentityUserId: organization.userId,
    status: "approved",
    approvedAt: new Date(),
    idempotencyKey: `binding-${randomUUID()}`,
    requestHash: requestHash(),
    provenance: { source: "synthetic-fixture" }
  } });
  return { ...organization, projectId };
}

function bindingInput(fixture: ProjectFixture, repositoryId: string) {
  return {
    identityUserId: fixture.userId,
    tenantId: fixture.tenantId,
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    installationRecordId: fixture.installationRecordId,
    repositoryId
  };
}

function bindingRowData(fixture: ProjectFixture, repositoryId: string, id = randomUUID()) {
  fixtureIds.bindings.add(id);
  return {
    id,
    tenantId: fixture.tenantId,
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    installationRecordId: fixture.installationRecordId,
    githubRepositoryId: BigInt(repositoryId),
    ownerLogin: "verified-fixture-owner",
    repositoryName: `fixture-${repositoryId}`.slice(0, 100),
    status: "active",
    connectedByIdentityUserId: fixture.userId
  };
}

function createBarrier(participants: number, timeoutMs = 10_000) {
  let arrivals = 0;
  let released = false;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const timer = setTimeout(() => {
    if (released) return;
    released = true;
    reject(new Error("Timed out waiting for competing repository verifications."));
  }, timeoutMs);
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    resolve();
  };
  return {
    get arrivals() { return arrivals; },
    async arrive() {
      arrivals++;
      if (arrivals === participants) release();
      await promise;
    },
    release
  };
}

function fakeGitHubClient(afterVerify?: (repositoryId: string) => Promise<void>) {
  return {
    async verifyRepository(installationId: string, repositoryId: string) {
      assert.ok(/^\d+$/.test(installationId));
      if (!/^\d{1,19}$/.test(repositoryId)) return null;
      const verified = {
        id: repositoryId,
        owner: "verified-fixture-owner",
        name: `fixture-${repositoryId}`.slice(0, 100),
        fullName: `verified-fixture-owner/fixture-${repositoryId}`,
        private: true,
        defaultBranch: "main",
        archived: false,
        disabled: false
      };
      await afterVerify?.(repositoryId);
      return verified;
    }
  };
}

function databaseFailingAuditInsert(prisma: PrismaClient): PrismaClient {
  const failingAuditDelegate = (tx: Prisma.TransactionClient) => new Proxy(tx, {
    get(target, property) {
      if (property === "organizationAuditEvent") {
        const delegate = Reflect.get(target, property, target) as object;
        return new Proxy(delegate, {
          get(auditTarget, method) {
            if (method === "create") {
              return (args: Prisma.OrganizationAuditEventCreateArgs) => {
                const invalidActor = randomUUID();
                return Reflect.get(auditTarget, method, auditTarget).call(auditTarget, {
                  ...args,
                  data: { ...args.data, actorUserId: invalidActor }
                });
              };
            }
            return Reflect.get(auditTarget, method, auditTarget);
          }
        });
      }
      return Reflect.get(target, property, target);
    }
  }) as Prisma.TransactionClient;

  type TransactionOptionsForTest = {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
  };
  return new Proxy(prisma, {
    get(target, property) {
      if (property === "$transaction") {
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: TransactionOptionsForTest) =>
          target.$transaction((tx) => callback(failingAuditDelegate(tx)), options);
      }
      return Reflect.get(target, property, target);
    }
  }) as PrismaClient;
}

async function cleanupFixtures(prisma: PrismaClient): Promise<void> {
  await assertDatabaseIdentity(prisma);

  const bindingIds = [...fixtureIds.bindings];
  const organizationIds = [...fixtureIds.organizations];
  const auditEventIds = bindingIds.length && organizationIds.length
    ? (await prisma.organizationAuditEvent.findMany({
        where: {
          organizationId: { in: organizationIds },
          targetType: "project_github_repository",
          targetId: { in: bindingIds }
        },
        select: { id: true }
      })).map((event) => event.id)
    : [];
  const memberships = [...fixtureIds.memberships].map((key) => {
    const [organizationId, userId] = key.split(":");
    return { organizationId, userId };
  });

  await prisma.$transaction(async (tx) => {
    if (auditEventIds.length) await tx.organizationAuditEvent.deleteMany({ where: { id: { in: auditEventIds } } });
    if (bindingIds.length) await tx.projectGitHubRepository.deleteMany({ where: { id: { in: bindingIds } } });
    if (fixtureIds.adoptions.size) await tx.projectOrganizationAdoption.deleteMany({ where: { id: { in: [...fixtureIds.adoptions] } } });
    if (fixtureIds.installations.size) await tx.organizationGitHubInstallation.deleteMany({ where: { id: { in: [...fixtureIds.installations] } } });
    if (memberships.length) await tx.organizationMember.deleteMany({ where: { OR: memberships } });
    if (fixtureIds.projects.size) await tx.project.deleteMany({ where: { id: { in: [...fixtureIds.projects] } } });
    if (organizationIds.length) await tx.organization.deleteMany({ where: { id: { in: organizationIds } } });
    if (fixtureIds.tenants.size) await tx.tenant.deleteMany({ where: { id: { in: [...fixtureIds.tenants] } } });
    if (fixtureIds.users.size) await tx.identityUser.deleteMany({ where: { id: { in: [...fixtureIds.users] } } });
  });
}

test("PostgreSQL enforces GitHub project-repository binding invariants and transactional lifecycle", async (t) => {
  const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  await prisma.$connect();
  try {
    await verifyDatabasePreflight(prisma);
  } catch (error) {
    await prisma.$disconnect();
    throw error;
  }

  t.after(async () => {
    try {
      await cleanupFixtures(prisma);
    } finally {
      await prisma.$disconnect();
    }
  });

  const github = fakeGitHubClient();
  const service = new ProjectGitHubBindingService(prisma, github as never);
  const organizationA = await createOrganizationFixture(prisma, "alpha");
  const organizationB = await createOrganizationFixture(prisma, "beta");
  const successfulProject = await createAdoptedProject(prisma, organizationA, "successful");
  const auditFailureProject = await createAdoptedProject(prisma, organizationA, "audit-failure");
  const repositoryCollisionProject = await createAdoptedProject(prisma, organizationA, "repository-collision");
  const concurrentProject = await createAdoptedProject(prisma, organizationA, "concurrent");
  const replacementProject = await createAdoptedProject(prisma, organizationA, "replacement");
  const crossOrganizationProject = await createAdoptedProject(prisma, organizationB, "cross-organization");

  await t.test("successful binding persists exact repository identity and linked organization audit", async () => {
    const repositoryId = nextRepositoryId();
    const binding = await service.bind(bindingInput(successfulProject, repositoryId));
    fixtureIds.bindings.add(binding.id);
    assert.equal(binding.tenantId, successfulProject.tenantId);
    assert.equal(binding.organizationId, successfulProject.organizationId);
    assert.equal(binding.projectId, successfulProject.projectId);
    assert.equal(binding.installationRecordId, successfulProject.installationRecordId);
    assert.equal(binding.githubRepositoryId, BigInt(repositoryId));

    const persisted = await prisma.projectGitHubRepository.findUniqueOrThrow({ where: { id: binding.id } });
    assert.equal(persisted.status, "active");
    assert.equal(persisted.githubRepositoryId.toString(), repositoryId);
    const audit = await prisma.organizationAuditEvent.findFirstOrThrow({
      where: { organizationId: successfulProject.organizationId, targetType: "project_github_repository", targetId: binding.id, action: "GITHUB_REPOSITORY_BOUND" }
    });
    assert.equal(audit.tenantId, successfulProject.tenantId);
    assert.equal(audit.projectId, successfulProject.projectId);
    assert.equal(audit.actorUserId, successfulProject.userId);
    assert.equal(audit.actorType, "user");
  });

  await t.test("a real foreign-key failure during audit insertion rolls back the binding transaction", async () => {
    const repositoryId = nextRepositoryId();
    const failingService = new ProjectGitHubBindingService(databaseFailingAuditInsert(prisma), github as never);
    await assert.rejects(
      failingService.bind(bindingInput(auditFailureProject, repositoryId)),
      (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003"
    );
    assert.equal(await prisma.projectGitHubRepository.count({ where: { tenantId: auditFailureProject.tenantId, organizationId: auditFailureProject.organizationId, projectId: auditFailureProject.projectId } }), 0);
    assert.equal(await prisma.organizationAuditEvent.count({ where: { organizationId: auditFailureProject.organizationId, projectId: auditFailureProject.projectId, action: "GITHUB_REPOSITORY_BOUND" } }), 0);
  });

  await t.test("PostgreSQL rejects a second active binding for one project and service maps it to conflict", async () => {
    const duplicateData = bindingRowData(successfulProject, nextRepositoryId());
    await assert.rejects(
      prisma.projectGitHubRepository.create({ data: duplicateData }),
      (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
    );
    await assert.rejects(
      service.bind(bindingInput(successfulProject, nextRepositoryId())),
      (error: unknown) => error instanceof ProjectGitHubBindingError && error.code === "conflict"
    );
    assert.equal(await prisma.projectGitHubRepository.count({ where: { tenantId: successfulProject.tenantId, organizationId: successfulProject.organizationId, projectId: successfulProject.projectId, status: "active" } }), 1);
    assert.equal(await prisma.organizationAuditEvent.count({ where: { organizationId: successfulProject.organizationId, projectId: successfulProject.projectId, action: "GITHUB_REPOSITORY_BOUND" } }), 1);
  });

  await t.test("PostgreSQL rejects an active repository duplicate within one organization", async () => {
    const existing = await prisma.projectGitHubRepository.findFirstOrThrow({ where: { projectId: successfulProject.projectId, status: "active" } });
    await assert.rejects(
      prisma.projectGitHubRepository.create({ data: bindingRowData(repositoryCollisionProject, existing.githubRepositoryId.toString()) }),
      (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
    );
    await assert.rejects(
      service.bind(bindingInput(repositoryCollisionProject, existing.githubRepositoryId.toString())),
      (error: unknown) => error instanceof ProjectGitHubBindingError && error.code === "conflict"
    );
    assert.equal(await prisma.projectGitHubRepository.count({ where: { organizationId: organizationA.organizationId, githubRepositoryId: existing.githubRepositoryId, status: "active" } }), 1);
  });

  await t.test("the same immutable repository ID can be bound in a different organization", async () => {
    const existing = await prisma.projectGitHubRepository.findFirstOrThrow({ where: { projectId: successfulProject.projectId, status: "active" } });
    const binding = await service.bind(bindingInput(crossOrganizationProject, existing.githubRepositoryId.toString()));
    fixtureIds.bindings.add(binding.id);
    assert.equal(binding.organizationId, organizationB.organizationId);
    assert.equal(binding.githubRepositoryId, existing.githubRepositoryId);
    assert.equal(await prisma.projectGitHubRepository.count({ where: { githubRepositoryId: existing.githubRepositoryId, status: "active" } }), 2);
  });

  await t.test("concurrent binding attempts leave one active row and one linked audit", async () => {
    const repositoryIds = [nextRepositoryId(), nextRepositoryId()];
    const competingIds = new Set(repositoryIds);
    const verifiedIds = new Set<string>();
    const barrier = createBarrier(2);
    const synchronizedService = new ProjectGitHubBindingService(prisma, fakeGitHubClient(async (repositoryId) => {
      if (!competingIds.has(repositoryId)) return;
      verifiedIds.add(repositoryId);
      await barrier.arrive();
    }) as never);
    let results: PromiseSettledResult<Awaited<ReturnType<typeof service.bind>>>[];
    try {
      const attempts = repositoryIds.map((repositoryId) =>
        synchronizedService.bind(bindingInput(concurrentProject, repositoryId)).catch((error: unknown) => {
          barrier.release();
          throw error;
        })
      );
      results = await Promise.allSettled(attempts);
    } finally {
      barrier.release();
    }
    assert.equal(barrier.arrivals, 2, "both requests verified their repository before either entered the binding transaction");
    assert.deepEqual(verifiedIds, competingIds);
    const successful = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.bind>>> => result.status === "fulfilled");
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(successful.length, 1);
    assert.equal(failed.length, 1);
    fixtureIds.bindings.add(successful[0].value.id);
    assert.ok(failed[0].reason instanceof ProjectGitHubBindingError && failed[0].reason.code === "conflict");
    const active = await prisma.projectGitHubRepository.findMany({ where: { projectId: concurrentProject.projectId, status: "active" } });
    assert.equal(active.length, 1);
    const events = await prisma.organizationAuditEvent.findMany({ where: { projectId: concurrentProject.projectId, action: "GITHUB_REPOSITORY_BOUND" } });
    assert.equal(events.length, 1);
    assert.equal(events[0].targetId, active[0].id, "every successful binding has exactly its matching audit event");
  });

  await t.test("soft disconnect preserves history and permits a replacement active binding", async () => {
    const originalRepositoryId = nextRepositoryId();
    const original = await service.bind(bindingInput(replacementProject, originalRepositoryId));
    fixtureIds.bindings.add(original.id);
    const disconnected = await service.disconnect({
      identityUserId: replacementProject.userId,
      tenantId: replacementProject.tenantId,
      organizationId: replacementProject.organizationId,
      projectId: replacementProject.projectId
    });
    assert.equal(disconnected.status, "disconnected");
    const history = await prisma.projectGitHubRepository.findUniqueOrThrow({ where: { id: original.id } });
    assert.equal(history.status, "disconnected");
    assert.ok(history.disconnectedAt instanceof Date);

    const replacement = await service.bind(bindingInput(replacementProject, nextRepositoryId()));
    fixtureIds.bindings.add(replacement.id);
    assert.equal((await prisma.projectGitHubRepository.findUniqueOrThrow({ where: { id: original.id } })).status, "disconnected");
    assert.equal((await prisma.projectGitHubRepository.findUniqueOrThrow({ where: { id: replacement.id } })).status, "active");
    assert.equal(await prisma.projectGitHubRepository.count({ where: { projectId: replacementProject.projectId, status: "active" } }), 1);
    assert.equal(await prisma.projectGitHubRepository.count({ where: { projectId: replacementProject.projectId } }), 2);
  });
});
