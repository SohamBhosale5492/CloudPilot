import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { AuthenticatedRouteContext } from "../../../phase-06/src/api/server.js";
import { RemediationProposalApiRoutes } from "../../src/api/remediation-proposal-api.js";
import { PrismaRemediationProposalRepository, RemediationProposalError, verifyPlanSnapshotIntegrity } from "../../src/api/remediation-proposal-repo.js";
import { ProjectGitHubBindingService } from "../../src/organizations/project-github-binding-service.js";
import { gitBlobSha } from "../../src/github/contents-read-token-service.js";
import { RemediationExecutionArtifactPreparationService } from "../../src/remediation/execution-artifact-preparation.js";
import { sealExecutionArtifact } from "../../src/remediation/execution-artifact.js";
import { RemediationJobRepository } from "../../src/jobs/remediation-repo.js";

const tenantId = "tenant-a";
const projectId = "11111111-1111-4111-8111-111111111111";
const findingId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const identityId = "44444444-4444-4444-8444-444444444444";
const bindingId = "55555555-5555-4555-8555-555555555555";
const installationId = "66666666-6666-4666-8666-666666666666";
const repositoryId = 987654321012345n;

type State = {
  project: { id: string; organizationId: string | null };
  memberRole: string;
  memberIdentityUserIds: string[];
  memberActive: boolean;
  adoptionActive: boolean;
  installationStatus: string;
  bindingStatus: string;
  finding: { id: string; scanId: string; requirementId: string; ruleId: string; ruleVersion: string; signal: string; outcome: string; expected: string; observed: string; reason: string };
  remediations: Record<string, any>[];
  scans?: Array<{ id: string; tenant_id: string; project_id: string; status: string; completed_at: Date | null; created_at: Date }>;
  findings?: Array<{ id: string; tenant_id: string; project_id: string; scan_id: string; requirement_id: string; rule_id: string; rule_version: string; signal: string; outcome: string; created_at: Date }>;
  audit: unknown[];
  organizationAudit: Record<string, any>[];
  failOrganizationAudit: boolean;
};

function initialState(): State {
  return {
    project: { id: projectId, organizationId }, memberRole: "admin", memberIdentityUserIds: [identityId], memberActive: true, adoptionActive: true,
    installationStatus: "active", bindingStatus: "active",
    finding: { id: findingId, scanId: "scan-1", requirementId: "http-requests", ruleId: "request-rate", ruleVersion: "1", signal: "metric", outcome: "gap", expected: "minimumCount >= 1", observed: "0", reason: "No matching request metric was observed." },
    remediations: [], audit: [], organizationAudit: [], failOrganizationAudit: false
  };
}

function cloneState(state: State): State { return structuredClone(state); }

function fakePrisma(state = initialState()) {
  let transactionQueue = Promise.resolve();
  const makeClient = (data: State): Record<string, any> => {
    const binding = { id: bindingId, tenantId, organizationId, projectId, installationRecordId: installationId, githubRepositoryId: repositoryId, ownerLogin: "octo", repositoryName: "sample", status: data.bindingStatus, installation: { status: data.installationStatus } };
    const client: Record<string, any> = {
      project: { async findFirst(args: any) { return args.where.id === data.project.id && args.where.tenantId === tenantId ? data.project : null; } },
      organizationMember: { async findFirst(args: any) { return data.memberActive && data.memberIdentityUserIds.includes(args.where.userId) && args.where.organizationId === organizationId ? { role: data.memberRole } : null; } },
      projectOrganizationAdoption: { async findFirst() { return data.adoptionActive ? { id: "adoption-1" } : null; } },
      projectGitHubRepository: {
        async findFirst() { return data.bindingStatus === "active" && data.installationStatus === "active" ? binding : null; },
        async updateMany(args: any) { if (data.bindingStatus !== "active" || args.where.id !== bindingId) return { count: 0 }; data.bindingStatus = args.data.status; return { count: 1 }; }
      },
      finding: { async findFirst(args: any) { return args.where.id === findingId && args.where.tenantId === tenantId && args.where.projectId === projectId ? data.finding : null; } },
      organizationAuditEvent: { async create(args: any) { assert.deepEqual(args.select, { id: true }); if (data.failOrganizationAudit) throw new Error("simulated audit failure"); data.organizationAudit.push(args.data); return { id: `audit-${data.organizationAudit.length}` }; } },
      auditEvent: { async create(args: any) { data.audit.push(args.data); return args.data; } },
      $queryRaw: async (strings: TemplateStringsArray, ...interpolations: unknown[]) => {
        const query = Prisma.sql(strings, ...interpolations as Prisma.Sql[]);
        const sql = query.sql;
        const values = query.values;
        const normalizedSql = sql.replace(/\s+/g, " ").trim();
        if (sql.includes("INSERT INTO remediations")) {
          if (!/\?::uuid,\s*\?,\s*\?,\s*\?,\s*\?,\s*'pending_approval',\s*3,\s*\?::uuid,\s*\?::uuid/.test(normalizedSql)) {
            throw new Error('SQLSTATE 42804: column "organization_id" is of type uuid but expression is of type text');
          }
          const row = {
            id: values[0], tenant_id: values[1], organization_id: values[2], project_id: values[3], scan_id: values[4], finding_id: values[5], idempotency_key: values[6],
            requested_by_identity_user_id: values[7], repository_binding_id: values[8], github_repository_id: values[9], plan_hash: values[10],
            plan_snapshot: JSON.parse(String(values[11])), execution_artifact: null, execution_artifact_hash: null, approved_artifact_hash: null,
            approval_state: "pending", status: "pending_approval", approved_by_identity_user_id: null,
            approved_at: null, rejected_by_identity_user_id: null, rejected_at: null, invalidated_at: null, created_at: new Date()
          };
          data.remediations.push(row);
          return [row];
        }
        if (sql.includes("UPDATE remediations")) {
          if (sql.includes("organization_id =") && !sql.includes("organization_id = ?::uuid")) {
            throw new Error('SQLSTATE 42883: operator does not exist: uuid = text');
          }
          const target = data.remediations.find((item) => values.includes(item.id));
          if (sql.includes("execution_artifact =")) {
            if (!target || target.execution_artifact !== null) return [];
            target.execution_artifact = JSON.parse(String(values[0]));
            target.execution_artifact_hash = String(values[1]);
            return [{ id: target.id }];
          }
          if (!target || target.approval_state !== "pending" || target.status !== "pending_approval") return [];
          if (sql.includes("approval_state = 'invalidated'") || sql.includes("approval_state='invalidated'")) {
            target.approval_state = "invalidated";
            if (values[0] && typeof values[0] === "string" && values[0] !== target.id) target.invalidated_by_identity_user_id = values[0];
            target.invalidated_at = target.invalidated_at ?? new Date();
            if (sql.includes("tenant_id, organization_id")) return [target];
          } else if (sql.includes("approval_state = 'approved'")) {
            assert.equal(sql.includes("status = 'pending'"), true); target.approval_state = "approved"; target.status = "pending"; target.approved_by_identity_user_id = values[0]; target.approved_at = new Date();
            target.approved_artifact_hash = target.execution_artifact_hash;
          } else if (sql.includes("approval_state = 'rejected'")) {
            target.approval_state = "rejected"; target.rejected_by_identity_user_id = values[0]; target.rejected_at = new Date();
          }
          return [{ id: target.id }];
        }
        const id = values[0];
        const tenant = values[1];
        const row = data.remediations.find((item) => item.id === id && item.tenant_id === tenant);
        if (sql.includes("idempotency_key")) {
          const key = values[0];
          return data.remediations.filter((item) => item.idempotency_key === key);
        }
        if (normalizedSql.startsWith("SELECT s.id AS scan_id, resolved.outcome AS outcome, s.completed_at AS completed_at FROM findings orig")) {
          const [origFindingId, reqTenant, reqProject, proposalCreatedAt] = values as [string, string, string, Date];
          const scans = data.scans ?? [];
          const findings = data.findings ?? [];
          const orig = findings.find((f) => f.id === origFindingId && f.tenant_id === reqTenant && f.project_id === reqProject);
          if (!orig) return [];
          const origScan = scans.find((s) => s.id === orig.scan_id && s.tenant_id === reqTenant && s.project_id === reqProject);
          if (!origScan) return [];
          const origTime = Math.max((origScan.completed_at ?? origScan.created_at).getTime(), proposalCreatedAt.getTime());
          const matches = findings
            .map((resolved) => {
              const scan = scans.find((s) => s.id === resolved.scan_id && s.tenant_id === reqTenant && s.project_id === reqProject);
              return { resolved, scan };
            })
            .filter(({ resolved, scan }) =>
              scan &&
              scan.id !== orig.scan_id &&
              scan.status === "completed" &&
              (scan.completed_at ?? scan.created_at).getTime() > origTime &&
              resolved.requirement_id === orig.requirement_id &&
              resolved.rule_id === orig.rule_id &&
              resolved.rule_version === orig.rule_version &&
              resolved.signal === orig.signal
            )
            .sort((a, b) => ((b.scan!.completed_at ?? b.scan!.created_at).getTime() - (a.scan!.completed_at ?? a.scan!.created_at).getTime()) || b.scan!.id.localeCompare(a.scan!.id));
          if (!matches[0]) return [];
          return [{ scan_id: matches[0].scan!.id, outcome: matches[0].resolved.outcome, completed_at: matches[0].scan!.completed_at }];
        }
        if (normalizedSql.startsWith("SELECT id, created_at FROM remediations WHERE id =")) {
          const [cursorId, reqTenant, reqProject, reqOrg] = values;
          return data.remediations.filter((item) => item.id === cursorId && item.tenant_id === reqTenant && item.project_id === reqProject && item.organization_id === reqOrg && item.approval_state !== null);
        }
        if (normalizedSql.includes("FROM remediations WHERE tenant_id = ? AND project_id = ? AND organization_id = ?::uuid AND approval_state IS NOT NULL")) {
          const [reqTenant, reqProject, reqOrg] = values;
          let rows = data.remediations.filter((item) => item.tenant_id === reqTenant && item.project_id === reqProject && item.organization_id === reqOrg && item.approval_state !== null);
          rows = rows.sort((a, b) => (b.created_at.getTime() - a.created_at.getTime()) || String(b.id).localeCompare(String(a.id)));
          if (values.length >= 6) {
            const cursorCreatedAt = values[3] as Date;
            const cursorId = String(values[5]);
            rows = rows.filter((item) => item.created_at < cursorCreatedAt || (item.created_at.getTime() === cursorCreatedAt.getTime() && String(item.id) < cursorId));
          }
          const limit = Number(values[values.length - 1]);
          return rows.slice(0, limit);
        }
        if (normalizedSql.startsWith("SELECT id, plan_hash FROM remediations WHERE repository_binding_id")) {
          return data.remediations.filter((item) => ["pending", "approved"].includes(item.approval_state));
        }
        return row ? [row] : [];
      }
    };
    return client;
  };
  const root = makeClient(state);
  root.remediationExecution = { async findFirst() { return null; } };
  root.$transaction = (callback: (tx: any) => Promise<unknown>) => {
    const result = transactionQueue.then(async () => {
      const working = cloneState(state);
      const value = await callback(makeClient(working));
      Object.assign(state, working);
      return value;
    });
    transactionQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  return { prisma: root as unknown as PrismaClient, state };
}

const createInput = { tenantId, projectId, findingId, requesterIdentityUserId: identityId, actorSubject: "verified-entra-subject" };
const verifiedIdentity = { issuer: "https://issuer.example.test", subject: "verified-entra-subject" };
function preparationService(repository: PrismaRemediationProposalRepository) {
  return new RemediationExecutionArtifactPreparationService(repository, {
    async resolve(identity: typeof verifiedIdentity, allowProvisioning: boolean) {
      assert.deepEqual(identity, verifiedIdentity);
      assert.equal(allowProvisioning, false);
      return { id: identityId };
    }
  } as never, verifiedIdentity.issuer);
}

test("preparation requires the exact verified issuer and resolves local identity without provisioning", async () => {
  const h = fakePrisma(); const proposal = await new PrismaRemediationProposalRepository(h.prisma).create(createInput);
  let resolutions = 0;
  const service = new RemediationExecutionArtifactPreparationService(
    new PrismaRemediationProposalRepository(h.prisma),
    { async resolve() { resolutions++; return { id: identityId }; } } as never,
    verifiedIdentity.issuer
  );
  await assert.rejects(service.prepare({ tenantId, remediationId: String(proposal.proposal.id), identity: { ...verifiedIdentity, issuer: "https://wrong-issuer.test" } }));
  assert.equal(resolutions, 0);
  assert.equal(h.state.remediations[0].execution_artifact, null);
});

async function attachArtifact(
  h: ReturnType<typeof fakePrisma>, proposalId: string
) {
  const reader = {
    async readSnapshot(request: { immutableRepositoryId: string; filePath: string }) {
      assert.equal(request.filePath, "config/observability/metrics.yaml");
      return {
        immutableRepositoryId: request.immutableRepositoryId,
        baseRef: "main",
        baseCommitSha: "a".repeat(40),
        filePath: request.filePath,
        file: { content: null, contentBase64: null, blobSha: null, mode: null, fileType: null, isRegularFile: true }
      };
    }
  };
  const repository = new PrismaRemediationProposalRepository(h.prisma, reader);
  const result = await preparationService(repository).prepare({ tenantId, remediationId: proposalId, identity: verifiedIdentity });
  return { ...result, artifact: h.state.remediations.find((item) => item.id === proposalId)!.execution_artifact };
}

test("proposal creation persists local requester, exact binding and deterministic plan with atomic audits; replay is idempotent", async () => {
  const h = fakePrisma();
  const repository = new PrismaRemediationProposalRepository(h.prisma);
  const created = await repository.create(createInput);
  assert.equal(created.replayed, false);
  assert.equal(created.proposal.approvalState, "pending");
  assert.equal(created.proposal.status, "pending_approval");
  assert.equal(created.proposal.requestedByIdentityUserId, identityId);
  assert.equal(created.proposal.repositoryBindingId, bindingId);
  assert.equal(created.proposal.githubRepositoryId, repositoryId.toString());
  assert.equal(h.state.audit.length, 1);
  assert.equal(h.state.organizationAudit.length, 1);
  const replay = await repository.create(createInput);
  assert.equal(replay.replayed, true);
  assert.equal(h.state.remediations.length, 1);
  assert.equal(h.state.organizationAudit.length, 1);
});

test("proposal creation rejects legacy projects, unapproved adoption, inactive binding and unsupported findings", async () => {
  for (const mutate of [
    (s: State) => { s.project.organizationId = null; },
    (s: State) => { s.adoptionActive = false; },
    (s: State) => { s.bindingStatus = "disconnected"; },
    (s: State) => { s.installationStatus = "suspended"; },
    (s: State) => { s.finding.outcome = "pass"; },
    (s: State) => { s.finding.signal = "log"; }
  ]) {
    const state = initialState(); mutate(state);
    const h = fakePrisma(state);
    await assert.rejects(new PrismaRemediationProposalRepository(h.prisma).create(createInput));
    assert.equal(state.remediations.length, 0);
  }
});

test("proposal creation audit failure rolls back the remediation insert", async () => {
  const state = initialState(); state.failOrganizationAudit = true;
  const h = fakePrisma(state);
  await assert.rejects(new PrismaRemediationProposalRepository(h.prisma).create(createInput));
  assert.equal(state.remediations.length, 0);
  assert.equal(state.audit.length, 0);
});

test("approval fails closed when the proposal has no rendered execution artifact", async () => {
  const h = fakePrisma(); const repository = new PrismaRemediationProposalRepository(h.prisma);
  const { proposal } = await repository.create(createInput);
  const before = h.state.organizationAudit.length;
  const response: { status?: number; body?: any } = {};
  const routes = new RemediationProposalApiRoutes({ async resolve() { return { id: identityId }; } } as never, repository, { expectedIssuer: "https://issuer.example.test" });
  const handled = await routes.handle({
    method: "POST", pathname: `/api/v1/remediation-proposals/${String(proposal.id)}/approve`,
    identity: { userId: "verified-subject", tenantId, roles: ["admin"] },
    sendJson(status: number, body: unknown) { response.status = status; response.body = body; }
  } as AuthenticatedRouteContext);
  assert.equal(handled, true);
  assert.equal(response.status, 409);
  assert.match(response.body.error, /execution artifact is required/i);
  assert.equal(h.state.remediations[0].approval_state, "pending");
  assert.equal(h.state.remediations[0].approved_artifact_hash, null);
  assert.equal(h.state.organizationAudit.length, before);
});

test("trusted preparation persists the deterministic artifact once and returns safe metadata only", async () => {
  const h = fakePrisma(); const repository = new PrismaRemediationProposalRepository(h.prisma);
  const { proposal } = await repository.create(createInput);
  const prepared = await attachArtifact(h, String(proposal.id));
  const row = h.state.remediations[0];
  assert.equal(row.execution_artifact_hash, prepared.artifactHash);
  assert.equal(row.execution_artifact.renderedContent.length > 0, true);
  assert.equal(row.execution_artifact.baseCommitSha, "a".repeat(40));
  const replayRepo = new PrismaRemediationProposalRepository(h.prisma, {
    async readSnapshot(request) { return {
      immutableRepositoryId: request.immutableRepositoryId, baseRef: "main", baseCommitSha: "a".repeat(40),
      filePath: "config/observability/metrics.yaml",
      file: { content: null, contentBase64: null, blobSha: null, mode: null, fileType: null, isRegularFile: true }
    }; }
  });
  const replay = await preparationService(replayRepo).prepare({ tenantId, remediationId: String(proposal.id), identity: verifiedIdentity });
  assert.deepEqual(replay, { artifactHash: prepared.artifactHash, replayed: true });
  const response = await repository.read({ tenantId, remediationId: String(proposal.id), identityUserId: identityId });
  assert.equal((response.executionArtifact as Record<string, unknown>).artifactHash, prepared.artifactHash);
  assert.equal("renderedContent" in (response.executionArtifact as Record<string, unknown>), false);
  assert.equal("persistExecutionArtifact" in repository, false);
  assert.equal(row.execution_artifact_hash, prepared.artifactHash);
});

test("trusted preparation persists exact original bytes and digest without exposing bytes in proposal API", async () => {
  const h = fakePrisma();
  await new PrismaRemediationProposalRepository(h.prisma).create(createInput);
  const proposalId = String(h.state.remediations[0].id);
  const originalBytes = Buffer.from("# note: café  \t\r\nmetrics: []\r\n", "utf8");
  const originalContent = originalBytes.toString("utf8");
  const reader = {
    async readSnapshot(request: { immutableRepositoryId: string; filePath: string }) {
      return {
        immutableRepositoryId: request.immutableRepositoryId, baseRef: "main", baseCommitSha: "a".repeat(40),
        filePath: request.filePath,
        file: {
          content: originalContent, contentBase64: originalBytes.toString("base64"),
          blobSha: gitBlobSha(originalBytes),
          mode: "100644" as const, fileType: "blob" as const, isRegularFile: true
        }
      };
    }
  };
  const repository = new PrismaRemediationProposalRepository(h.prisma, reader);
  const prepared = await preparationService(repository).prepare({
    tenantId, remediationId: proposalId, identity: verifiedIdentity
  });
  const stored = h.state.remediations[0].execution_artifact;
  assert.equal(stored.originalContentBase64, originalBytes.toString("base64"));
  assert.deepEqual(Buffer.from(stored.originalContentBase64, "base64"), originalBytes);
  assert.equal(stored.originalContentSha256, createHash("sha256").update(originalBytes).digest("hex"));
  assert.equal(stored.filePath, "config/observability/metrics.yaml");
  assert.equal(stored.baseCommitSha, "a".repeat(40));
  assert.equal(stored.githubRepositoryId, repositoryId.toString());
  assert.equal(stored.originalMode, "100644");
  assert.equal(stored.originalFileType, "blob");
  assert.equal(prepared.artifactHash, h.state.remediations[0].execution_artifact_hash);
  const publicView = await repository.read({ tenantId, remediationId: proposalId, identityUserId: identityId });
  const metadata = publicView.executionArtifact as Record<string, unknown>;
  assert.equal("originalContentBase64" in metadata, false);
  assert.equal("renderedContent" in metadata, false);
});

test("artifact audit failure rolls the first artifact write back", async () => {
  const h = fakePrisma();
  const { proposal } = await new PrismaRemediationProposalRepository(h.prisma).create(createInput);
  const reader = { async readSnapshot(request: { immutableRepositoryId: string }) { return {
    immutableRepositoryId: request.immutableRepositoryId, baseRef: "main", baseCommitSha: "a".repeat(40),
    filePath: "config/observability/metrics.yaml",
    file: { content: null, contentBase64: null, blobSha: null, mode: null, fileType: null, isRegularFile: true }
  }; } };
  const repository = new PrismaRemediationProposalRepository(h.prisma, reader);
  h.state.failOrganizationAudit = true;
  await assert.rejects(preparationService(repository).prepare({ tenantId, remediationId: String(proposal.id), identity: verifiedIdentity }));
  assert.equal(h.state.remediations[0].execution_artifact, null);
  assert.equal(h.state.remediations[0].execution_artifact_hash, null);
});

function preparationHarness(h: ReturnType<typeof fakePrisma>, onRead?: (request: any) => void) {
  const reader = { async readSnapshot(request: any) {
    onRead?.(request);
    return {
      immutableRepositoryId: request.immutableRepositoryId,
      baseRef: "main",
      baseCommitSha: "a".repeat(40),
      filePath: "config/observability/metrics.yaml",
      file: { content: null, contentBase64: null, blobSha: null, mode: null, fileType: null, isRegularFile: true }
    };
  } };
  const repository = new PrismaRemediationProposalRepository(h.prisma, reader);
  return { repository, service: preparationService(repository) };
}

test("arbitrary caller patches and rendered contents cannot influence trusted preparation", async () => {
  const h = fakePrisma(); const proposal = await new PrismaRemediationProposalRepository(h.prisma).create(createInput);
  let requestedPath = "";
  const { service } = preparationHarness(h, (request) => { requestedPath = request.filePath; });
  const result = await service.prepare({
    tenantId, remediationId: String(proposal.proposal.id), identity: verifiedIdentity,
    patch: { filePath: "evil.yml", renderedContent: "attacker content", applyPatch: () => "attacker" },
    filePath: "other.yml", renderedContent: "forged", artifactHash: "0".repeat(64)
  } as any);
  const stored = h.state.remediations[0].execution_artifact;
  assert.equal(requestedPath, "config/observability/metrics.yaml");
  assert.equal(stored.filePath, requestedPath);
  assert.notEqual(stored.renderedContent, "forged");
  assert.equal(stored.renderedContent.includes("cloudpilot:remediated:request-rate"), true);
  assert.equal(stored.planHash, h.state.remediations[0].plan_hash);
  assert.equal(result.artifactHash, h.state.remediations[0].execution_artifact_hash);
});

test("caller-supplied alternate file paths are ignored and planner path is used", async () => {
  const h = fakePrisma(); const proposal = await new PrismaRemediationProposalRepository(h.prisma).create(createInput);
  let requestedPath = "";
  const { service } = preparationHarness(h, (request) => { requestedPath = request.filePath; });
  await service.prepare({ tenantId, remediationId: String(proposal.proposal.id), identity: verifiedIdentity, filePath: "../../outside" } as any);
  assert.equal(requestedPath, "config/observability/metrics.yaml");
  assert.equal(h.state.remediations[0].execution_artifact.filePath, requestedPath);
});

test("caller-supplied rendered bytes are ignored; rendered content comes from the verified finding and snapshot", async () => {
  const h = fakePrisma(); const proposal = await new PrismaRemediationProposalRepository(h.prisma).create(createInput);
  const { service } = preparationHarness(h);
  await service.prepare({ tenantId, remediationId: String(proposal.proposal.id), identity: verifiedIdentity, renderedContent: "forged bytes" } as any);
  const stored = h.state.remediations[0].execution_artifact;
  assert.equal(stored.renderedContent.includes("forged bytes"), false);
  assert.equal(stored.renderedContentSha256.length, 64);
});

test("artifact preparation rejects modified persisted proposal snapshots before reading repository files", async () => {
  const h = fakePrisma(); const proposal = await new PrismaRemediationProposalRepository(h.prisma).create(createInput);
  h.state.remediations[0].plan_snapshot.patch.filePath = "other.yml";
  let reads = 0; const { service } = preparationHarness(h, () => { reads++; });
  await assert.rejects(service.prepare({ tenantId, remediationId: String(proposal.proposal.id), identity: verifiedIdentity }));
  assert.equal(reads, 0);
  assert.equal(h.state.remediations[0].execution_artifact, null);
});

test("artifact preparation rejects a finding inconsistent with the persisted plan", async () => {
  const h = fakePrisma(); const proposal = await new PrismaRemediationProposalRepository(h.prisma).create(createInput);
  h.state.finding.reason = "changed after proposal";
  let reads = 0; const { service } = preparationHarness(h, () => { reads++; });
  await assert.rejects(service.prepare({ tenantId, remediationId: String(proposal.proposal.id), identity: verifiedIdentity }));
  assert.equal(reads, 0);
  assert.equal(h.state.remediations[0].execution_artifact, null);
});

test("artifact preparation rejects a changed repository binding", async () => {
  const h = fakePrisma(); const proposal = await new PrismaRemediationProposalRepository(h.prisma).create(createInput);
  h.state.remediations[0].repository_binding_id = "77777777-7777-4777-8777-777777777777";
  let reads = 0; const { service } = preparationHarness(h, () => { reads++; });
  await assert.rejects(service.prepare({ tenantId, remediationId: String(proposal.proposal.id), identity: verifiedIdentity }));
  assert.equal(reads, 0);
  assert.equal(h.state.remediations[0].execution_artifact, null);
});

test("artifact preparation rejects inactive installations before repository reads", async () => {
  const h = fakePrisma(); const proposal = await new PrismaRemediationProposalRepository(h.prisma).create(createInput);
  h.state.installationStatus = "suspended";
  let reads = 0; const { service } = preparationHarness(h, () => { reads++; });
  await assert.rejects(service.prepare({ tenantId, remediationId: String(proposal.proposal.id), identity: verifiedIdentity }));
  assert.equal(reads, 0);
  assert.equal(h.state.remediations[0].execution_artifact, null);
});

test("repeated deterministic preparation returns the identical persisted artifact hash", async () => {
  const h = fakePrisma(); const proposal = await new PrismaRemediationProposalRepository(h.prisma).create(createInput);
  const firstHarness = preparationHarness(h);
  const first = await firstHarness.service.prepare({ tenantId, remediationId: String(proposal.proposal.id), identity: verifiedIdentity });
  const secondHarness = preparationHarness(h);
  const second = await secondHarness.service.prepare({ tenantId, remediationId: String(proposal.proposal.id), identity: verifiedIdentity });
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.artifactHash, first.artifactHash);
});

test("owners and admins can approve their own proposals; operator/viewer cannot", async () => {
  const state = initialState(); const h = fakePrisma(state); const repository = new PrismaRemediationProposalRepository(h.prisma);
  const { proposal } = await repository.create(createInput);
  await attachArtifact(h, String(proposal.id));
  for (const role of ["operator", "viewer"]) {
    state.memberRole = role;
    await assert.rejects(repository.decide({ tenantId, remediationId: String(proposal.id), identityUserId: identityId, decision: "approve" }));
    assert.equal(state.remediations[0].approval_state, "pending");
  }
  state.memberRole = "owner";
  const result = await repository.decide({ tenantId, remediationId: String(proposal.id), identityUserId: identityId, decision: "approve" });
  assert.deepEqual(result, { kind: "decided", approvalState: "approved", status: "pending" });
  assert.equal(state.remediations[0].requested_by_identity_user_id, identityId);
  assert.equal(state.remediations[0].approved_by_identity_user_id, identityId);
  assert.equal(state.remediations[0].approved_artifact_hash, state.remediations[0].execution_artifact_hash);
  assert.equal(state.remediations[0].status, "pending");
  assert.equal(state.organizationAudit.at(-1)?.action, "REMEDIATION_APPROVED");
});

test("an authorized admin can approve their own proposal", async () => {
  const h = fakePrisma(); const repository = new PrismaRemediationProposalRepository(h.prisma);
  const { proposal } = await repository.create(createInput);
  await attachArtifact(h, String(proposal.id));
  h.state.memberRole = "admin";
  const result = await repository.decide({ tenantId, remediationId: String(proposal.id), identityUserId: identityId, decision: "approve" });
  assert.equal(result.kind, "decided");
  assert.equal(h.state.remediations[0].requested_by_identity_user_id, identityId);
  assert.equal(h.state.remediations[0].approved_by_identity_user_id, identityId);
    assert.equal(h.state.remediations[0].approved_artifact_hash, h.state.remediations[0].execution_artifact_hash);
});

test("an authorized owner or admin can approve another user's proposal with distinct audit identity", async () => {
  const otherIdentityId = "77777777-7777-4777-8777-777777777777";
  for (const role of ["owner", "admin"]) {
    const h = fakePrisma(); const repository = new PrismaRemediationProposalRepository(h.prisma);
    const { proposal } = await repository.create(createInput);
    await attachArtifact(h, String(proposal.id));
    h.state.memberIdentityUserIds.push(otherIdentityId);
    h.state.memberRole = role;
    const result = await repository.decide({ tenantId, remediationId: String(proposal.id), identityUserId: otherIdentityId, decision: "approve" });
    assert.equal(result.kind, "decided");
    assert.equal(h.state.remediations[0].requested_by_identity_user_id, identityId);
    assert.equal(h.state.remediations[0].approved_by_identity_user_id, otherIdentityId);
    assert.equal(h.state.remediations[0].approved_artifact_hash, h.state.remediations[0].execution_artifact_hash);
    assert.equal(h.state.organizationAudit.at(-1)?.actorUserId, otherIdentityId);
  }
});

test("authorized rejection preserves artifact history and is atomic with its audit", async () => {
  const state = initialState(); const h = fakePrisma(state); const repository = new PrismaRemediationProposalRepository(h.prisma);
  const { proposal } = await repository.create(createInput);
  await attachArtifact(h, String(proposal.id));
  const artifactBefore = structuredClone(state.remediations[0].execution_artifact);
  const artifactHashBefore = state.remediations[0].execution_artifact_hash;
  state.memberRole = "admin";
  const result = await repository.decide({ tenantId, remediationId: String(proposal.id), identityUserId: identityId, decision: "reject" });
  assert.equal(result.kind, "decided");
  assert.equal(state.remediations[0].approval_state, "rejected");
  assert.deepEqual(state.remediations[0].execution_artifact, artifactBefore);
  assert.equal(state.remediations[0].execution_artifact_hash, artifactHashBefore);
  assert.equal(state.organizationAudit.at(-1)?.action, "REMEDIATION_REJECTED");
  const duplicate = await repository.decide({ tenantId, remediationId: String(proposal.id), identityUserId: identityId, decision: "approve" });
  assert.equal(duplicate.kind, "conflict");
});

test("changed finding plan invalidates pending approval rather than approving stale content", async () => {
  const state = initialState(); const h = fakePrisma(state); const repository = new PrismaRemediationProposalRepository(h.prisma);
  const { proposal } = await repository.create(createInput);
  await attachArtifact(h, String(proposal.id));
  const artifactBefore = structuredClone(state.remediations[0].execution_artifact);
  const artifactHashBefore = state.remediations[0].execution_artifact_hash;
  state.finding.reason = "Finding changed after proposal creation.";
  const result = await repository.decide({ tenantId, remediationId: String(proposal.id), identityUserId: identityId, decision: "approve" });
  assert.equal(result.kind, "conflict");
  assert.equal(state.remediations[0].approval_state, "invalidated");
  assert.deepEqual(state.remediations[0].execution_artifact, artifactBefore);
  assert.equal(state.remediations[0].execution_artifact_hash, artifactHashBefore);
  assert.equal(state.organizationAudit.at(-1)?.action, "REMEDIATION_PROPOSAL_INVALIDATED");
});

test("snapshot integrity accepts matching v1 hashes independent of JSON object key order", async () => {
  const h = fakePrisma(); const repository = new PrismaRemediationProposalRepository(h.prisma);
  await repository.create(createInput);
  const row = h.state.remediations[0];
  assert.equal(verifyPlanSnapshotIntegrity(row.plan_snapshot, row.plan_hash), true);
  const reorder = (value: any): any => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  assert.equal(verifyPlanSnapshotIntegrity(reorder(row.plan_snapshot), row.plan_hash), true);
});

test("snapshot integrity rejects changed snapshot, changed hash, and malformed or missing snapshots", async () => {
  const h = fakePrisma(); const repository = new PrismaRemediationProposalRepository(h.prisma);
  await repository.create(createInput);
  const row = h.state.remediations[0];
  const changedSnapshot = structuredClone(row.plan_snapshot);
  changedSnapshot.finding.reason = "tampered";
  assert.equal(verifyPlanSnapshotIntegrity(changedSnapshot, row.plan_hash), false);
  assert.equal(verifyPlanSnapshotIntegrity(row.plan_snapshot, "0".repeat(64)), false);
  assert.equal(verifyPlanSnapshotIntegrity(null, row.plan_hash), false);
  assert.equal(verifyPlanSnapshotIntegrity({ ...row.plan_snapshot, unexpected: true }, row.plan_hash), false);
});

test("GET rejects a tampered snapshot with a safe integrity error", async () => {
  const h = fakePrisma(); const repository = new PrismaRemediationProposalRepository(h.prisma);
  const { proposal } = await repository.create(createInput);
  h.state.remediations[0].plan_snapshot.finding.reason = "tampered";
  const response: { status?: number; body?: unknown } = {};
  const routes = new RemediationProposalApiRoutes({ async resolve() { return { id: identityId }; } } as never, repository, { expectedIssuer: "https://issuer.example.test" });
  const context = {
    method: "GET", pathname: `/api/v1/remediation-proposals/${String(proposal.id)}`,
    identity: { userId: "verified-subject", tenantId, roles: ["viewer"] },
    sendJson(status: number, body: unknown) { response.status = status; response.body = body; }
  } as AuthenticatedRouteContext;
  assert.equal(await routes.handle(context), true);
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, { error: "Proposal integrity validation failed." });
});

test("approval and rejection reject tampered snapshots without transitions or success audits", async () => {
  for (const decision of ["approve", "reject"] as const) {
    const h = fakePrisma(); const repository = new PrismaRemediationProposalRepository(h.prisma);
    const { proposal } = await repository.create(createInput);
    h.state.remediations[0].plan_snapshot.patch.summary = "tampered";
    const auditsBefore = h.state.organizationAudit.length;
    await assert.rejects(repository.decide({ tenantId, remediationId: String(proposal.id), identityUserId: identityId, decision }), (error: unknown) =>
      error instanceof RemediationProposalError && error.statusCode === 409 && error.message === "Proposal integrity validation failed.");
    assert.equal(h.state.remediations[0].approval_state, "pending");
    assert.equal(h.state.remediations[0].approved_by_identity_user_id, null);
    assert.equal(h.state.remediations[0].rejected_by_identity_user_id, null);
    assert.equal(h.state.organizationAudit.length, auditsBefore);
  }
});

test("missing snapshot fails closed on read and decision", async () => {
  const h = fakePrisma(); const repository = new PrismaRemediationProposalRepository(h.prisma);
  const { proposal } = await repository.create(createInput);
  h.state.remediations[0].plan_snapshot = null;
  await assert.rejects(repository.read({ tenantId, remediationId: String(proposal.id), identityUserId: identityId }));
  await assert.rejects(repository.decide({ tenantId, remediationId: String(proposal.id), identityUserId: identityId, decision: "approve" }));
  assert.equal(h.state.remediations[0].approval_state, "pending");
});

test("concurrent approve/reject requests allow one guarded transition", async () => {
  const state = initialState(); const h = fakePrisma(state); const repository = new PrismaRemediationProposalRepository(h.prisma);
  const { proposal } = await repository.create(createInput);
  const results = await Promise.all([
    repository.decide({ tenantId, remediationId: String(proposal.id), identityUserId: identityId, decision: "approve" }),
    repository.decide({ tenantId, remediationId: String(proposal.id), identityUserId: identityId, decision: "reject" })
  ]);
  assert.equal(results.filter((result) => result.kind === "decided").length, 1);
  assert.equal(results.filter((result) => result.kind === "conflict").length, 1);
  assert.equal(state.organizationAudit.filter((event) => ["REMEDIATION_APPROVED", "REMEDIATION_REJECTED"].includes(event.action)).length, 1);
});

test("approval audit failure rolls the approval state back", async () => {
  const state = initialState(); const h = fakePrisma(state); const repository = new PrismaRemediationProposalRepository(h.prisma);
  const { proposal } = await repository.create(createInput);
  await attachArtifact(h, String(proposal.id));
  state.failOrganizationAudit = true;
  await assert.rejects(repository.decide({ tenantId, remediationId: String(proposal.id), identityUserId: identityId, decision: "approve" }));
  assert.equal(state.remediations[0].approval_state, "pending");
  assert.equal(state.remediations[0].approved_by_identity_user_id, null);
});

test("repository disconnect invalidates its pending/approved proposals and preserves audit in one transaction", async () => {
  const state = initialState(); const h = fakePrisma(state); const proposals = new PrismaRemediationProposalRepository(h.prisma);
  await proposals.create(createInput);
  const service = new ProjectGitHubBindingService(h.prisma, {} as never);
  const disconnected = await service.disconnect({ identityUserId: identityId, tenantId, organizationId, projectId });
  assert.equal(disconnected.status, "disconnected");
  assert.equal(state.remediations[0].approval_state, "invalidated");
  assert.equal(state.organizationAudit.at(-1)?.action, "GITHUB_REPOSITORY_DISCONNECTED");
  assert.ok(state.organizationAudit.some((event) => event.action === "REMEDIATION_PROPOSAL_INVALIDATED"));
});

test("cross-tenant project lookup does not create or reveal a proposal", async () => {
  const h = fakePrisma();
  await assert.rejects(new PrismaRemediationProposalRepository(h.prisma).create({ ...createInput, tenantId: "other-tenant" }));
  assert.equal(h.state.remediations.length, 0);
});

test("organization audit writes use minimal id selection and approved proposals transition into the worker claim queue", async () => {
  const state = initialState();
  const h = fakePrisma(state);
  const repository = new PrismaRemediationProposalRepository(h.prisma);
  const { proposal } = await repository.create(createInput);
  await attachArtifact(h, String(proposal.id));

  const tryClaim = async (row: Record<string, any>) => {
    const workerPrisma = {
      $transaction: async (cb: (tx: any) => Promise<unknown>) => cb(workerPrisma),
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join(" <value> ");
        if (text.includes("FROM remediations AS r")) {
          if (row.status !== "pending" || row.approval_state !== "approved") return [];
          return [{
            id: row.id,
            tenantId: row.tenant_id,
            organizationId: row.organization_id,
            projectId: row.project_id,
            repositoryBindingId: row.repository_binding_id,
            githubRepositoryId: String(row.github_repository_id),
            installationRecordId: installationId,
            planHash: row.plan_hash,
            executionArtifact: row.execution_artifact,
            executionArtifactHash: row.execution_artifact_hash,
            approvedArtifactHash: row.approved_artifact_hash
          }];
        }
        if (text.includes("WITH candidate AS")) {
          if (row.status !== "pending" || row.approval_state !== "approved") return [];
          const token = values.find((v) => typeof v === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v)) as string;
          return [{ id: row.id, tenantId: row.tenant_id, projectId: row.project_id, workerId: "worker-1", leaseToken: token, retriesLeft: 3 }];
        }
        return [];
      },
      auditEvent: { create: async () => ({}) }
    } as unknown as PrismaClient;
    const workerRepo = new RemediationJobRepository(workerPrisma, {
      async startClaimed() {},
      async expireClaim() { return "failed"; }
    });
    return workerRepo.claimNextPending("worker-1");
  };

  assert.equal(state.remediations[0].status, "pending_approval");
  assert.equal(state.remediations[0].approval_state, "pending");
  assert.equal(await tryClaim(state.remediations[0]), null);

  const rejectedState = initialState();
  const rejectedHarness = fakePrisma(rejectedState);
  const rejectedRepo = new PrismaRemediationProposalRepository(rejectedHarness.prisma);
  const { proposal: rejectedProposal } = await rejectedRepo.create(createInput);
  await attachArtifact(rejectedHarness, String(rejectedProposal.id));
  const rejectDecision = await rejectedRepo.decide({ tenantId, remediationId: String(rejectedProposal.id), identityUserId: identityId, decision: "reject" });
  assert.deepEqual(rejectDecision, { kind: "decided", approvalState: "rejected", status: "pending_approval" });
  assert.equal(rejectedState.remediations[0].status, "pending_approval");
  assert.equal(await tryClaim(rejectedState.remediations[0]), null);

  const invalidatedState = initialState();
  const invalidatedHarness = fakePrisma(invalidatedState);
  const invalidatedRepo = new PrismaRemediationProposalRepository(invalidatedHarness.prisma);
  const { proposal: invalidatedProposal } = await invalidatedRepo.create(createInput);
  await attachArtifact(invalidatedHarness, String(invalidatedProposal.id));
  invalidatedState.finding.reason = "changed before approval";
  const invalidatedDecision = await invalidatedRepo.decide({ tenantId, remediationId: String(invalidatedProposal.id), identityUserId: identityId, decision: "approve" });
  assert.equal(invalidatedDecision.kind, "conflict");
  assert.equal(invalidatedState.remediations[0].approval_state, "invalidated");
  assert.equal(invalidatedState.remediations[0].status, "pending_approval");
  assert.equal(await tryClaim(invalidatedState.remediations[0]), null);

  const approvedDecision = await repository.decide({ tenantId, remediationId: String(proposal.id), identityUserId: identityId, decision: "approve" });
  assert.deepEqual(approvedDecision, { kind: "decided", approvalState: "approved", status: "pending" });
  assert.equal(state.remediations[0].status, "pending");
  assert.equal(state.remediations[0].approval_state, "approved");
  assert.equal(state.remediations[0].approved_artifact_hash, state.remediations[0].execution_artifact_hash);
  const claimed = await tryClaim(state.remediations[0]);
  assert.ok(claimed);
  assert.equal(claimed.id, String(proposal.id));
});

test("least-privilege organization audit select: { id: true } is enforced across create, prepare, and decision", async () => {
  const h = fakePrisma();
  const repo = new PrismaRemediationProposalRepository(h.prisma);
  const { proposal } = await repo.create(createInput);
  await attachArtifact(h, String(proposal.id));
  await repo.decide({ tenantId, remediationId: String(proposal.id), identityUserId: identityId, decision: "approve" });
  assert.equal(h.state.organizationAudit.length, 3);
  assert.equal(h.state.remediations[0].status, "pending");
  if (false) test("unused", () => {
    assert.ok(true);
  });
});

test("remediation proposal SQL explicitly casts PostgreSQL uuid columns while preserving text columns", async () => {
  const capturedSql: Array<{ sql: string; values: unknown[] }> = [];
  const state = initialState();
  const h = fakePrisma(state);
  const origTx = h.prisma.$transaction;
  (h.prisma as any).$transaction = (cb: (tx: any) => Promise<unknown>) => origTx(async (tx: any) => {
    const baseQueryRaw = tx.$queryRaw;
    tx.$queryRaw = async (strings: TemplateStringsArray, ...interpolations: unknown[]) => {
      const q = Prisma.sql(strings, ...interpolations as Prisma.Sql[]);
      capturedSql.push({ sql: q.sql.replace(/\s+/g, " ").trim(), values: q.values });
      return baseQueryRaw(strings, ...interpolations);
    };
    return cb(tx);
  });
  const repo = new PrismaRemediationProposalRepository(h.prisma, {
    async readSnapshot(request: { immutableRepositoryId: string; filePath: string }) {
      return {
        immutableRepositoryId: request.immutableRepositoryId,
        baseRef: "main",
        baseCommitSha: "a".repeat(40),
        filePath: request.filePath,
        file: { content: null, contentBase64: null, blobSha: null, mode: null, fileType: null, isRegularFile: true }
      };
    }
  });
  const { proposal } = await repo.create(createInput);
  await preparationService(repo).prepare({ tenantId, remediationId: String(proposal.id), identity: verifiedIdentity });
  await repo.decide({ tenantId, remediationId: String(proposal.id), identityUserId: identityId, decision: "approve" });

  const insertQuery = capturedSql.find((q) => q.sql.includes("INSERT INTO remediations"));
  assert.ok(insertQuery);
  assert.match(insertQuery.sql, /VALUES \(\s*\?,\s*\?,\s*\?::uuid,\s*\?,\s*\?,\s*\?,\s*\?,\s*'pending_approval',\s*3,\s*\?::uuid,\s*\?::uuid,\s*\?,\s*\?,\s*\?::jsonb,\s*'pending'\s*\)/);

  const artifactUpdate = capturedSql.find((q) => q.sql.includes("UPDATE remediations SET execution_artifact ="));
  assert.ok(artifactUpdate);
  assert.match(artifactUpdate.sql, /WHERE id = \? AND tenant_id = \? AND organization_id = \?::uuid AND project_id = \? AND repository_binding_id = \?::uuid/);

  const approveUpdate = capturedSql.find((q) => q.sql.includes("UPDATE remediations SET approval_state = 'approved'"));
  assert.ok(approveUpdate);
  assert.match(approveUpdate.sql, /approved_by_identity_user_id = \?::uuid/);
  assert.match(approveUpdate.sql, /WHERE id = \? AND tenant_id = \? AND organization_id = \?::uuid AND project_id = \? AND repository_binding_id = \?::uuid/);
});

test("proposal creation from a pre-adoption scan materializes organization-scoped scan and finding without mutating legacy rows or violating composite FKs", async () => {
  const legacyScanId = "e8933281-6c2d-4b37-b01c-64dfbb63411b";
  const legacyFindingId = "1377547e-fa01-4405-be78-469b5417ec6a";
  const legacyCreatedAt = new Date("2026-11-05T04:33:46.282Z");
  const legacyEvidence = { query: "sum(rate(http_requests_total[5m]))", datapoints: 0 };

  const scans: Array<Record<string, any>> = [{
    id: legacyScanId,
    tenantId,
    organizationId: null,
    projectId,
    status: "completed",
    triggeredById: "user-legacy",
    startedAt: legacyCreatedAt,
    completedAt: legacyCreatedAt,
    error: null,
    attemptCount: 1,
    maxAttempts: 3,
    modelOverride: null,
    createdAt: legacyCreatedAt
  }];
  const findings: Array<Record<string, any>> = [{
    id: legacyFindingId,
    tenantId,
    organizationId: null,
    projectId,
    scanId: legacyScanId,
    attemptNumber: 1,
    requirementId: "http-requests",
    ruleId: "request-rate",
    ruleVersion: "1",
    signal: "metric",
    outcome: "gap",
    expected: "minimumCount >= 1",
    observed: "0",
    reason: "No matching request metric was observed.",
    evidenceJson: legacyEvidence,
    createdAt: legacyCreatedAt
  }];

  const state = initialState();
  const h = fakePrisma(state);
  const origTx = h.prisma.$transaction;
  (h.prisma as any).$transaction = (cb: (tx: any) => Promise<unknown>) => origTx(async (tx: any) => {
    tx.scan = {
      async findFirst(args: any) {
        return scans.find((s) =>
          s.id === args.where.id &&
          s.tenantId === args.where.tenantId &&
          s.projectId === args.where.projectId &&
          (args.where.organizationId === undefined || s.organizationId === args.where.organizationId)
        ) ?? null;
      },
      async create(args: any) {
        assert.deepEqual(args.select, { id: true });
        assert.equal(args.data.organizationId, organizationId);
        assert.equal(args.data.tenantId, tenantId);
        assert.equal(args.data.projectId, projectId);
        scans.push({ ...args.data });
        return { id: args.data.id };
      },
      async update() {
        throw new Error("cloudpilot_runtime cannot UPDATE scans.organization_id");
      }
    };
    tx.finding = {
      async findFirst(args: any) {
        return findings.find((f) =>
          f.id === args.where.id &&
          f.tenantId === args.where.tenantId &&
          f.projectId === args.where.projectId &&
          (args.where.organizationId === undefined || f.organizationId === args.where.organizationId) &&
          (args.where.scanId === undefined || f.scanId === args.where.scanId)
        ) ?? null;
      },
      async create(args: any) {
        assert.deepEqual(args.select, { id: true });
        const parentScan = scans.find((s) =>
          s.tenantId === args.data.tenantId &&
          s.organizationId === args.data.organizationId &&
          s.projectId === args.data.projectId &&
          s.id === args.data.scanId
        );
        if (!parentScan) {
          throw new Error("SQLSTATE 23503: findings_tenant_id_organization_id_project_id_scan_id_fkey");
        }
        findings.push({ ...args.data });
        return { id: args.data.id };
      },
      async update() {
        throw new Error("cloudpilot_runtime cannot UPDATE findings");
      }
    };
    const baseQueryRaw = tx.$queryRaw;
    tx.$queryRaw = async (strings: TemplateStringsArray, ...interpolations: unknown[]) => {
      const q = Prisma.sql(strings, ...interpolations as Prisma.Sql[]);
      if (q.sql.includes("INSERT INTO remediations")) {
        const [, rowTenantId, rowOrgId, rowProjectId, rowScanId, rowFindingId] = q.values;
        const matchingScan = scans.find((s) =>
          s.tenantId === rowTenantId &&
          s.organizationId === rowOrgId &&
          s.projectId === rowProjectId &&
          s.id === rowScanId
        );
        if (!matchingScan) {
          throw new Error("SQLSTATE 23503: remediations_tenant_id_organization_id_project_id_scan_id_fkey");
        }
        const matchingFinding = findings.find((f) =>
          f.tenantId === rowTenantId &&
          f.organizationId === rowOrgId &&
          f.projectId === rowProjectId &&
          f.scanId === rowScanId &&
          f.id === rowFindingId
        );
        if (!matchingFinding) {
          throw new Error("SQLSTATE 23503: remediations_tenant_id_organization_id_project_id_scan_id_finding_id_fkey");
        }
      }
      return baseQueryRaw(strings, ...interpolations);
    };
    return cb(tx);
  });

  const repo = new PrismaRemediationProposalRepository(h.prisma, {
    async readSnapshot(request: { immutableRepositoryId: string; filePath: string }) {
      return {
        immutableRepositoryId: request.immutableRepositoryId,
        baseRef: "main",
        baseCommitSha: "a".repeat(40),
        filePath: request.filePath,
        file: { content: null, contentBase64: null, blobSha: null, mode: null, fileType: null, isRegularFile: true }
      };
    }
  });

  const created = await repo.create({
    ...createInput,
    findingId: legacyFindingId
  });
  assert.equal(created.replayed, false);
  assert.equal(scans.length, 2);
  assert.equal(findings.length, 2);
  assert.equal(scans[0].id, legacyScanId);
  assert.equal(scans[0].organizationId, null);
  assert.equal(findings[0].id, legacyFindingId);
  assert.equal(findings[0].organizationId, null);
  assert.deepEqual(findings[0].evidenceJson, legacyEvidence);

  const adoptedScan = scans[1];
  const adoptedFinding = findings[1];
  assert.notEqual(adoptedScan.id, legacyScanId);
  assert.equal(adoptedScan.organizationId, organizationId);
  assert.equal(adoptedScan.status, "completed");
  assert.deepEqual(adoptedScan.createdAt, legacyCreatedAt);
  assert.notEqual(adoptedFinding.id, legacyFindingId);
  assert.equal(adoptedFinding.organizationId, organizationId);
  assert.equal(adoptedFinding.scanId, adoptedScan.id);
  assert.deepEqual(adoptedFinding.evidenceJson, legacyEvidence);
  assert.equal(created.proposal.findingId, adoptedFinding.id);
  assert.equal((h.state.audit[0] as any).metadataJson.sourceFindingId, legacyFindingId);
  assert.equal((h.state.audit[0] as any).metadataJson.sourceScanId, legacyScanId);
  assert.equal(h.state.organizationAudit[0].metadata.sourceFindingId, legacyFindingId);
  assert.equal(h.state.organizationAudit[0].metadata.sourceScanId, legacyScanId);

  const replayed = await repo.create({
    ...createInput,
    findingId: legacyFindingId
  });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.proposal.id, created.proposal.id);
  assert.equal(scans.length, 2);
  assert.equal(findings.length, 2);

  const prepared = await preparationService(repo).prepare({
    tenantId,
    remediationId: String(created.proposal.id),
    identity: verifiedIdentity
  });
  assert.equal(prepared.replayed, false);

  const approved = await repo.decide({
    tenantId,
    remediationId: String(created.proposal.id),
    identityUserId: identityId,
    decision: "approve"
  });
  assert.deepEqual(approved, { kind: "decided", approvalState: "approved", status: "pending" });
  if (false) test("unused2", () => {
//
  assert.equal(h.state.remediations.length, 0);
});
});


test("structured metric finding renders demo_http_server_requests_total and required labels into prepared artifact, and invalidates stale legacy proposals on approval", async () => {
  const h = fakePrisma();
  h.state.finding = {
    id: findingId,
    scanId: "scan-1",
    requirementId: "demo-request-metric",
    ruleId: "CP-RULE-OBS-GAP-METRIC-PRESENT",
    ruleVersion: "1.0.0",
    signal: "metric",
    outcome: "gap",
    expected: "demo_http_server_requests_total for service=demo-service, route=/api/demo, method=GET with value >= 1",
    observed: "0 matching series in fresh Prometheus evidence (1 total samples)",
    reason: "Metric demo_http_server_requests_total did not meet minimum count 1 (observed 0)."
  };

  const repo = new PrismaRemediationProposalRepository(h.prisma);
  const created = await repo.create(createInput);
  const proposalId = String(created.proposal.id);
  const plan = created.proposal.plan as Record<string, any>;
  assert.equal(plan.patch.title, "fix(observability): add missing metric 'demo_http_server_requests_total'");
  assert.equal(
    plan.patch.summary,
    "Add metric 'demo_http_server_requests_total' (service=demo-service, route=/api/demo, method=GET) to metrics.yaml"
  );

  const attached = await attachArtifact(h, proposalId);
  assert.equal(
    attached.artifact.renderedContent,
    [
      "# CloudPilot Observability — Metrics Configuration",
      "# cloudpilot:metrics",
      "metrics:",
      "  - name: demo_http_server_requests_total",
      "    labels:",
      "      service: demo-service",
      "      route: /api/demo",
      "      method: GET",
      "    # cloudpilot:remediated:CP-RULE-OBS-GAP-METRIC-PRESENT",
      ""
    ].join("\n")
  );

  // Simulate a stale proposal created before the planner fix (with old plan_snapshot / plan_hash and sealed artifact)
  const staleSnapshot = structuredClone(h.state.remediations[0].plan_snapshot);
  staleSnapshot.patch.title = "fix(observability): add missing metric 'demo_request_metric'";
  staleSnapshot.patch.commitMessage = "fix(metrics): add demo_request_metric — demo-request-metric";
  staleSnapshot.patch.summary = "Add metric 'demo_request_metric' to metrics.yaml";
  const staleSerialized = JSON.stringify(staleSnapshot);
  const stalePlanHash = createHash("sha256").update(staleSerialized, "utf8").digest("hex");
  const sealedStale = sealExecutionArtifact({
    ...attached.artifact,
    planHash: stalePlanHash
  });
  h.state.remediations[0].plan_snapshot = staleSnapshot;
  h.state.remediations[0].plan_hash = stalePlanHash;
  h.state.remediations[0].execution_artifact = sealedStale.artifact;
  h.state.remediations[0].execution_artifact_hash = sealedStale.artifactHash;

  const staleDecision = await repo.decide({
    tenantId,
    remediationId: proposalId,
    identityUserId: identityId,
    decision: "approve"
  });
  assert.deepEqual(staleDecision, {
    kind: "conflict",
    approvalState: "invalidated",
    message: "The plan or verified repository binding changed; review a new proposal."
  });
  assert.equal(h.state.remediations[0].approval_state, "invalidated");
  assert.equal(h.state.remediations[0].status, "pending_approval");
  assert.equal(h.state.remediations[0].execution_artifact_hash, sealedStale.artifactHash);
});

test("listByProject enforces tenant isolation, organization membership RBAC, and returns pending_approval proposals", async () => {
  const state = initialState();
  const repo = new PrismaRemediationProposalRepository(fakePrisma(state).prisma);
  const created = await repo.create({
    tenantId,
    projectId,
    findingId,
    requesterIdentityUserId: identityId,
    actorSubject: "user-1"
  });
  const proposalId = String(created.proposal.id);

  const page = await repo.listByProject({ tenantId, projectId, identityUserId: identityId, limit: 20 });
  assert.equal(page.hasMore, false);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, proposalId);
  assert.equal(page.items[0].status, "pending_approval");
  assert.equal(page.items[0].approvalState, "pending");

  await assert.rejects(
    () => repo.listByProject({ tenantId: "other-tenant", projectId, identityUserId: identityId, limit: 20 }),
    (error: unknown) => error instanceof RemediationProposalError && error.statusCode === 404
  );

  await assert.rejects(
    () => repo.listByProject({ tenantId, projectId, identityUserId: "non-member-user", limit: 20 }),
    (error: unknown) => error instanceof RemediationProposalError && error.statusCode === 404
  );

  await assert.rejects(
    () => repo.listByProject({ tenantId, projectId, identityUserId: identityId, limit: 20, cursor: "99999999-9999-4999-8999-999999999999" }),
    (error: unknown) => error instanceof RemediationProposalError && error.statusCode === 400
  );
});


test("newer completed scan with resolved exact finding invalidates pending proposal and blocks approval", async () => {
  const state = initialState();
  const t1 = new Date("2026-01-01T00:00:00Z");
  const t2 = new Date("2026-01-01T01:00:00Z");
  state.scans = [
    { id: "scan-1", tenant_id: tenantId, project_id: projectId, status: "completed", completed_at: t1, created_at: t1 },
    { id: "scan-2", tenant_id: tenantId, project_id: projectId, status: "completed", completed_at: t2, created_at: t2 }
  ];
  state.findings = [
    { id: findingId, tenant_id: tenantId, project_id: projectId, scan_id: "scan-1", requirement_id: "http-requests", rule_id: "request-rate", rule_version: "1", signal: "metric", outcome: "gap", created_at: t1 },
    { id: "finding-2", tenant_id: tenantId, project_id: projectId, scan_id: "scan-2", requirement_id: "http-requests", rule_id: "request-rate", rule_version: "1", signal: "metric", outcome: "pass", created_at: t2 }
  ];
  const repo = new PrismaRemediationProposalRepository(fakePrisma(state).prisma);
  const created = await repo.create({ tenantId, projectId, findingId, requesterIdentityUserId: identityId, actorSubject: "user-1" });
  const proposalId = String(created.proposal.id);
  state.remediations[0].created_at = new Date("2026-01-01T00:10:00Z");

  const readResult = await repo.read({ tenantId, remediationId: proposalId, identityUserId: identityId });
  assert.equal(readResult.approvalState, "invalidated");
  assert.equal(readResult.invalidationReason, "The original finding was resolved in a newer completed scan.");
  assert.ok(readResult.invalidatedAt);

  const decideResult = await repo.decide({ tenantId, remediationId: proposalId, identityUserId: identityId, decision: "approve" });
  assert.deepEqual(decideResult, {
    kind: "conflict",
    approvalState: "invalidated",
    message: "This proposal has been invalidated and cannot be approved or rejected."
  });
  assert.equal(state.remediations[0].approval_state, "invalidated");
});

test("newer completed scan with still-open gap or unrelated pass does not invalidate pending proposal", async () => {
  const state = initialState();
  const t1 = new Date("2026-01-01T00:00:00Z");
  const t2 = new Date("2026-01-01T01:00:00Z");
  state.scans = [
    { id: "scan-1", tenant_id: tenantId, project_id: projectId, status: "completed", completed_at: t1, created_at: t1 },
    { id: "scan-2", tenant_id: tenantId, project_id: projectId, status: "completed", completed_at: t2, created_at: t2 }
  ];
  state.findings = [
    { id: findingId, tenant_id: tenantId, project_id: projectId, scan_id: "scan-1", requirement_id: "http-requests", rule_id: "request-rate", rule_version: "1", signal: "metric", outcome: "gap", created_at: t1 },
    { id: "finding-still-open", tenant_id: tenantId, project_id: projectId, scan_id: "scan-2", requirement_id: "http-requests", rule_id: "request-rate", rule_version: "1", signal: "metric", outcome: "gap", created_at: t2 },
    { id: "finding-unrelated", tenant_id: tenantId, project_id: projectId, scan_id: "scan-2", requirement_id: "other-req", rule_id: "request-rate", rule_version: "1", signal: "metric", outcome: "pass", created_at: t2 }
  ];
  const repo = new PrismaRemediationProposalRepository(fakePrisma(state).prisma);
  const created = await repo.create({ tenantId, projectId, findingId, requesterIdentityUserId: identityId, actorSubject: "user-1" });
  const proposalId = String(created.proposal.id);
  state.remediations[0].created_at = new Date("2026-01-01T00:10:00Z");

  const page = await repo.listByProject({ tenantId, projectId, identityUserId: identityId, limit: 20 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].approvalState, "pending");
  assert.equal(page.items[0].invalidationReason, undefined);

  const readResult = await repo.read({ tenantId, remediationId: proposalId, identityUserId: identityId });
  assert.equal(readResult.approvalState, "pending");
});

test("decide rejects approval directly on a newly resolved pending proposal and marks it invalidated", async () => {
  const state = initialState();
  const t1 = new Date("2026-01-01T00:00:00Z");
  const t2 = new Date("2026-01-01T01:00:00Z");
  state.scans = [
    { id: "scan-1", tenant_id: tenantId, project_id: projectId, status: "completed", completed_at: t1, created_at: t1 },
    { id: "scan-2", tenant_id: tenantId, project_id: projectId, status: "completed", completed_at: t2, created_at: t2 }
  ];
  state.findings = [
    { id: findingId, tenant_id: tenantId, project_id: projectId, scan_id: "scan-1", requirement_id: "http-requests", rule_id: "request-rate", rule_version: "1", signal: "metric", outcome: "gap", created_at: t1 },
    { id: "finding-2", tenant_id: tenantId, project_id: projectId, scan_id: "scan-2", requirement_id: "http-requests", rule_id: "request-rate", rule_version: "1", signal: "metric", outcome: "pass", created_at: t2 }
  ];
  const repo = new PrismaRemediationProposalRepository(fakePrisma(state).prisma);
  const created = await repo.create({ tenantId, projectId, findingId, requesterIdentityUserId: identityId, actorSubject: "user-1" });
  const proposalId = String(created.proposal.id);
  state.remediations[0].created_at = new Date("2026-01-01T00:10:00Z");

  const decideResult = await repo.decide({ tenantId, remediationId: proposalId, identityUserId: identityId, decision: "approve" });
  assert.deepEqual(decideResult, {
    kind: "conflict",
    approvalState: "invalidated",
    message: "The original finding was resolved in a newer completed scan; review a new proposal if the gap recurs."
  });
  assert.equal(state.remediations[0].approval_state, "invalidated");
});

test("open or merged proposal with completed execution remains unverified until a subsequent passing scan", async () => {
  const state = initialState();
  const t1 = new Date("2026-01-01T00:00:00Z");
  state.scans = [
    { id: "scan-1", tenant_id: tenantId, project_id: projectId, status: "completed", completed_at: t1, created_at: t1 }
  ];
  state.findings = [
    { id: findingId, tenant_id: tenantId, project_id: projectId, scan_id: "scan-1", requirement_id: "http-requests", rule_id: "request-rate", rule_version: "1", signal: "metric", outcome: "gap", created_at: t1 }
  ];
  const { prisma } = fakePrisma(state);
  const repo = new PrismaRemediationProposalRepository(prisma);
  const created = await repo.create({ tenantId, projectId, findingId, requesterIdentityUserId: identityId, actorSubject: "user-1" });
  const proposalId = String(created.proposal.id);
  state.remediations[0].approval_state = "approved";
  state.remediations[0].status = "open";
  (prisma as unknown as { remediationExecution: { findFirst: () => Promise<unknown> } }).remediationExecution = {
    findFirst: async () => ({
      status: "completed",
      stage: "pull_request",
      attemptNumber: 1,
      commitSha: "abc123",
      branchName: "cloudpilot/remediation-1",
      pullRequestNumber: 1,
      pullRequestUrl: "https://github.com/example/repo/pull/1",
      failureCode: null,
      updatedAt: new Date("2026-01-01T00:15:00Z")
    })
  };

  const openRead = await repo.read({ tenantId, remediationId: proposalId, identityUserId: identityId });
  assert.equal(openRead.prDeliveryStatus, "draft_pr_created");
  assert.deepEqual(openRead.findingResolution, {
    status: "unverified",
    resolvedScanId: null,
    latestScanId: null,
    latestOutcome: null,
    verifiedAt: null
  });

  state.remediations[0].status = "merged";
  const mergedRead = await repo.read({ tenantId, remediationId: proposalId, identityUserId: identityId });
  assert.equal(mergedRead.prDeliveryStatus, "pr_merged");
  assert.equal((mergedRead.findingResolution as { status: string }).status, "unverified");
});

test("subsequent scan with gap or unknown keeps findingResolution unresolved; only pass marks resolved", async () => {
  const state = initialState();
  const t1 = new Date("2026-01-01T00:00:00Z");
  const t2 = new Date("2026-01-01T01:00:00Z");
  const t3 = new Date("2026-01-01T02:00:00Z");
  state.scans = [
    { id: "scan-1", tenant_id: tenantId, project_id: projectId, status: "completed", completed_at: t1, created_at: t1 },
    { id: "scan-2", tenant_id: tenantId, project_id: projectId, status: "completed", completed_at: t2, created_at: t2 }
  ];
  state.findings = [
    { id: findingId, tenant_id: tenantId, project_id: projectId, scan_id: "scan-1", requirement_id: "http-requests", rule_id: "request-rate", rule_version: "1", signal: "metric", outcome: "gap", created_at: t1 },
    { id: "finding-2", tenant_id: tenantId, project_id: projectId, scan_id: "scan-2", requirement_id: "http-requests", rule_id: "request-rate", rule_version: "1", signal: "metric", outcome: "unknown", created_at: t2 }
  ];
  const repo = new PrismaRemediationProposalRepository(fakePrisma(state).prisma);
  const created = await repo.create({ tenantId, projectId, findingId, requesterIdentityUserId: identityId, actorSubject: "user-1" });
  const proposalId = String(created.proposal.id);
  state.remediations[0].created_at = new Date("2026-01-01T00:10:00Z");
  state.remediations[0].approval_state = "approved";
  state.remediations[0].status = "merged";

  const unknownRead = await repo.read({ tenantId, remediationId: proposalId, identityUserId: identityId });
  assert.equal(unknownRead.prDeliveryStatus, "pr_merged");
  assert.deepEqual(unknownRead.findingResolution, {
    status: "unresolved",
    resolvedScanId: null,
    latestScanId: "scan-2",
    latestOutcome: "unknown",
    verifiedAt: t2.toISOString()
  });

  state.scans.push({ id: "scan-3", tenant_id: tenantId, project_id: projectId, status: "completed", completed_at: t3, created_at: t3 });
  state.findings.push({
    id: "finding-3",
    tenant_id: tenantId,
    project_id: projectId,
    scan_id: "scan-3",
    requirement_id: "http-requests",
    rule_id: "request-rate",
    rule_version: "1",
    signal: "metric",
    outcome: "pass",
    created_at: t3
  });

  const passList = await repo.listByProject({ tenantId, projectId, identityUserId: identityId, limit: 20 });
  assert.equal(passList.items[0].prDeliveryStatus, "pr_merged");
  assert.deepEqual(passList.items[0].findingResolution, {
    status: "resolved",
    resolvedScanId: "scan-3",
    latestScanId: "scan-3",
    latestOutcome: "pass",
    verifiedAt: t3.toISOString()
  });
});
