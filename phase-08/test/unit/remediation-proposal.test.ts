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
      organizationAuditEvent: { async create(args: any) { if (data.failOrganizationAudit) throw new Error("simulated audit failure"); data.organizationAudit.push(args.data); return args.data; } },
      auditEvent: { async create(args: any) { data.audit.push(args.data); return args.data; } },
      $queryRaw: async (strings: TemplateStringsArray, ...interpolations: unknown[]) => {
        const query = Prisma.sql(strings, ...interpolations as Prisma.Sql[]);
        const sql = query.sql;
        const values = query.values;
        const normalizedSql = sql.replace(/\s+/g, " ").trim();
        if (sql.includes("INSERT INTO remediations")) {
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
          const target = data.remediations.find((item) => values.includes(item.id));
          if (sql.includes("execution_artifact =")) {
            if (!target || target.execution_artifact !== null) return [];
            target.execution_artifact = JSON.parse(String(values[0]));
            target.execution_artifact_hash = String(values[1]);
            return [{ id: target.id }];
          }
          if (!target || target.approval_state !== "pending" || target.status !== "pending_approval") return [];
          if (sql.includes("approval_state = 'invalidated'") || sql.includes("approval_state='invalidated'")) {
            target.approval_state = "invalidated"; target.invalidated_by_identity_user_id = values[0]; target.invalidated_at = new Date();
          } else if (sql.includes("approval_state = 'approved'")) {
            target.approval_state = "approved"; target.approved_by_identity_user_id = values[0]; target.approved_at = new Date();
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
    (s: State) => { s.finding.signal = "trace"; }
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
  assert.deepEqual(result, { kind: "decided", approvalState: "approved", status: "pending_approval" });
  assert.equal(state.remediations[0].requested_by_identity_user_id, identityId);
  assert.equal(state.remediations[0].approved_by_identity_user_id, identityId);
  assert.equal(state.remediations[0].approved_artifact_hash, state.remediations[0].execution_artifact_hash);
  assert.equal(state.remediations[0].status, "pending_approval");
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
