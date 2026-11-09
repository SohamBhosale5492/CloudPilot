import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import type { RemediationLease } from "../../src/jobs/remediation-repo.js";
import { GitHubExecutionCapabilityService } from "../../src/github/github-execution-capability.js";
import { GITHUB_ARTIFACT_WRITER_PERMISSIONS, GITHUB_DRAFT_PR_PERMISSIONS, type GitHubInstallationToken } from "../../src/github/app-token-service.js";
import { ArtifactOnlyGitHubWriter, isVerifiedArtifactOnlyGitHubWriteResult } from "../../src/remediation/artifact-only-github-writer.js";
import { ArtifactOnlyGitHubDraftPrPublisher, deriveRemediationBranchName,
  isVerifiedArtifactOnlyPullRequestCloseResult } from "../../src/remediation/artifact-only-github-draft-pr-publisher.js";
import { renderExecutionArtifact } from "../../src/remediation/execution-artifact.js";
import { TrustedClaimExecutionContextService } from "../../src/remediation/trusted-claim-execution-context.js";
import { ArtifactOnlyExecutionOrchestrator } from "../../src/remediation/artifact-only-execution-orchestrator.js";
import { RemediationExecutionPersistenceService } from "../../src/remediation/remediation-execution-persistence.js";
import { internalMutationBoundary } from "../../src/github/internal-mutation-boundary.js";

const lease: RemediationLease = { id: "proposal-writer", tenantId: "tenant-writer", projectId: "project-writer", workerId: "worker-writer",
  leaseToken: "d60587a1-58d7-4836-bc3d-f8ebecb10147", retriesLeft: 1 };
const s = { org: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", binding: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  installationRecord: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", installation: "9223372036854775000", repo: "9007199254740993",
  requester: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", approver: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  scan: "scan-writer", finding: "finding-writer" };
const path = "config/observability/metrics.yaml";
const original = "metrics:\n  - name: old\n";
const baseSha = "b".repeat(40);
const rootSha = "1".repeat(40); const configSha = "2".repeat(40); const obsSha = "3".repeat(40);
const newRootSha = "4".repeat(40); const newConfigSha = "5".repeat(40); const newObsSha = "6".repeat(40);
const commitSha = "7".repeat(40); const priorCommitSha = "8".repeat(40);
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const gitBlobSha = (value: string) => createHash("sha1").update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest("hex");
const originalBlobSha = gitBlobSha(original);
const finding = { id: s.finding, scanId: s.scan, requirementId: "r", ruleId: "rule", ruleVersion: "1", signal: "metric",
  outcome: "gap", expected: "count >= 1", observed: "0", reason: "Missing telemetry." };
const planSnapshot = { schemaVersion: 1, plannerVersion: "phase07-planner-v1", projectId: lease.projectId, finding,
  repository: { bindingId: s.binding, repositoryId: s.repo, installationRecordId: s.installationRecord, owner: "octo", name: "demo" },
  patch: { filePath: path, title: "t", body: "b", commitMessage: "m", summary: "s" } };
const planHash = sha256(JSON.stringify(planSnapshot));
const artifact = renderExecutionArtifact({
  scope: { proposalId: lease.id, tenantId: lease.tenantId, organizationId: s.org, projectId: lease.projectId,
    repositoryBindingId: s.binding, githubRepositoryId: s.repo, installationRecordId: s.installationRecord, planHash },
  finding,
  snapshot: { immutableRepositoryId: s.repo, baseRef: "main", baseCommitSha: baseSha, filePath: path,
    file: { content: original, contentBase64: Buffer.from(original).toString("base64"), blobSha: originalBlobSha,
      mode: "100644", fileType: "blob", isRegularFile: true } },
  createdAt: new Date("2026-11-06T00:00:00.000Z")
});
const createArtifact = renderExecutionArtifact({
  scope: { proposalId: lease.id, tenantId: lease.tenantId, organizationId: s.org, projectId: lease.projectId,
    repositoryBindingId: s.binding, githubRepositoryId: s.repo, installationRecordId: s.installationRecord, planHash },
  finding, snapshot: { immutableRepositoryId: s.repo, baseRef: "main", baseCommitSha: baseSha, filePath: path,
    file: { content: null, contentBase64: null, blobSha: null, mode: null, fileType: null, isRegularFile: true } },
  createdAt: new Date("2026-11-06T00:00:00.000Z")
});
const rendered = artifact.artifact.renderedContent;
const renderedBlobSha = gitBlobSha(rendered);

function makeState(options: { operation?: "create" | "update"; adoption?: string; bindingStatus?: string; installStatus?: string;
  baseContent?: string; retriesLeft?: number } = {}) {
  const source = options.baseContent ?? original;
  const selected = options.operation === "create" ? createArtifact : artifact;
  return {
    remediation: { id: lease.id, tenantId: lease.tenantId, organizationId: s.org, projectId: lease.projectId, scanId: s.scan,
      findingId: s.finding, status: "running", workerId: lease.workerId, leaseToken: lease.leaseToken,
      leaseExpiresAt: new Date(Date.now() + 120_000), approvalState: "approved", requestedByIdentityUserId: s.requester,
      approvedByIdentityUserId: s.approver, approvedAt: new Date("2026-11-05T00:00:00.000Z"), repositoryBindingId: s.binding,
      githubRepositoryId: BigInt(s.repo), planHash, planSnapshot: structuredClone(planSnapshot), executionArtifact: structuredClone(selected.artifact),
      executionArtifactHash: selected.artifactHash, approvedArtifactHash: selected.artifactHash, nextAttemptAt: null as Date | null },
    organizationStatus: "active", project: { id: lease.projectId, tenantId: lease.tenantId, organizationId: s.org },
    scan: { id: s.scan, tenantId: lease.tenantId, projectId: lease.projectId },
    finding: { ...finding, tenantId: lease.tenantId, projectId: lease.projectId }, adoptionStatus: options.adoption ?? "approved",
    binding: { id: s.binding, tenantId: lease.tenantId, organizationId: s.org, projectId: lease.projectId,
      installationRecordId: s.installationRecord, githubRepositoryId: BigInt(s.repo), ownerLogin: "octo", repositoryName: "demo",
      status: options.bindingStatus ?? "active", installation: { organizationId: s.org, status: options.installStatus ?? "active",
        githubInstallationId: BigInt(s.installation) } },
    requesterStatus: "active", approverStatus: "active", retriesLeft: options.retriesLeft ?? lease.retriesLeft,
    approverMembership: { role: "admin", status: "active", userStatus: "active", organizationStatus: "active" }, source
  };
}

function setup(options: { sourceExists?: boolean; sourceContent?: string; baseRefSha?: string;
  mutateAfterPost?: "blob" | "tree" | "commit"; ambiguousPost?: "blob" | "tree" | "commit";
  missingBlobAfterAmbiguous?: boolean; extraDelta?: boolean; malformedTree?: boolean;
  truncatedTree?: boolean; malformedBaseCommit?: boolean;
  failAuditAfterBlob?: boolean;
  invalidateLeaseAfterIntent?: "blob" | "tree" | "commit" | "branch" | "pull_request";
  operation?: "create" | "update"; unexpectedParent?: boolean; existingBranchSha?: string;
  branchConflictOnCreate?: "matching" | "different";
  branchCreateAmbiguous?: boolean; prCreateAmbiguous?: boolean; existingPr?: "matching" | "wrong-head" | "wrong-base";
  prHeadSha?: string; prBaseSha?: string; moveBaseDuringPrCreate?: boolean; failPrClose?: boolean;
  rateLimitPost?: "blob" | "tree" | "commit"; rateLimitRef?: boolean; forbiddenRef?: boolean;
  rateLimitRetryAfterSeconds?: number; retriesLeft?: number;
  invalidateLeaseAfterBranch?: boolean; invalidateLeaseOnPrCreate?: boolean; invalidateBeforePrCreate?: boolean;
  invalidateLeaseBeforeClose?: boolean } = {}) {
  const selectedArtifact = options.operation === "create" ? createArtifact : artifact;
  const writtenContent = selectedArtifact.artifact.renderedContent;
  const writtenBlobSha = gitBlobSha(writtenContent);
  const db = makeState({ operation: options.operation, retriesLeft: options.retriesLeft });
  const old = options.sourceContent ?? original;
  const oldBlobSha = gitBlobSha(old);
  const exists = options.sourceExists ?? true;
  const treeBodies = new Map<string, unknown>();
  treeBodies.set(rootSha, { sha: rootSha, truncated: false, tree: [{ path: "config", mode: "040000", type: "tree", sha: configSha }] });
  treeBodies.set(configSha, { sha: configSha, truncated: false, tree: [{ path: "observability", mode: "040000", type: "tree", sha: obsSha }] });
  treeBodies.set(obsSha, { sha: obsSha, truncated: false, tree: exists ? [{ path: "metrics.yaml", mode: "100644", type: "blob", sha: oldBlobSha }] : [] });
  treeBodies.set(newRootSha, { sha: newRootSha, truncated: options.truncatedTree ?? false,
    tree: [{ path: "config", mode: "040000", type: "tree", sha: newConfigSha }] });
  treeBodies.set(newConfigSha, { sha: newConfigSha, truncated: false, tree: [{ path: "observability", mode: "040000", type: "tree", sha: newObsSha }] });
  const resultingFiles = [{ path: "metrics.yaml", mode: "100644", type: "blob", sha: writtenBlobSha },
    ...(options.extraDelta ? [{ path: "intruder.txt", mode: "100644", type: "blob", sha: "9".repeat(40) }] : [])];
  treeBodies.set(newObsSha, { sha: newObsSha, truncated: false, tree: options.malformedTree ? [{ path: "metrics.yaml", mode: "100755", type: "blob", sha: renderedBlobSha }] : resultingFiles });
  let calls: string[] = []; let tokenCalls = 0; const requestBodies: Array<{ url: string; body: unknown }> = [];
  const sqlWrites: string[] = [];
  let currentBaseSha = options.baseRefSha ?? baseSha;
  let branchSha: string | null = options.existingBranchSha ?? null;
  let branchName = ""; let branchPosts = 0; let prPosts = 0; let closePosts = 0; let prLookupSeen = false;
  let pullRequest: { number: number; draft: boolean; state: "open" | "closed"; head: { ref: string; sha: string; repo: { id: string; } };
    base: { ref: string; sha: string; repo: { id: string; } }; html_url: string } | null = null;
  const buildPr = (headSha: string, baseShaValue: string) => ({ number: 41, draft: true, state: "open" as const,
    head: { ref: branchName, sha: headSha, repo: { id: s.repo } },
    base: { ref: "main", sha: baseShaValue, repo: { id: s.repo } }, html_url: "https://github.com/octo/demo/pull/41" });
  const rawPr = (pr: NonNullable<typeof pullRequest>) =>
    `{"number":${pr.number},"draft":${pr.draft},"state":"${pr.state}","head":{"ref":"${pr.head.ref}","sha":"${pr.head.sha}","repo":{"id":${s.repo}}},` +
    `"base":{"ref":"${pr.base.ref}","sha":"${pr.base.sha}","repo":{"id":${s.repo}}},"html_url":"${pr.html_url}"}`;
  let blobPersisted = options.ambiguousPost === "blob" && !options.missingBlobAfterAmbiguous;
  let failAuditWrites = false;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? "GET"; calls.push(`${method} ${url}`);
    const requiredStage = method === "POST" && url.endsWith("/git/blobs") ? "blob" :
      method === "POST" && url.endsWith("/git/trees") ? "tree" :
      method === "POST" && url.endsWith("/git/commits") ? "commit" :
      method === "POST" && url.endsWith("/git/refs") ? "branch" :
      method === "POST" && url.endsWith("/pulls") ? "pull_request" :
      method === "PATCH" && /\/pulls\/\d+$/u.test(url) ? "pull_request_close" : null;
    if (requiredStage) {
      const last = journal.at(-1);
      assert.equal(last?.eventType, "request_intent", `${requiredStage} mutation has a committed intent before request`);
      assert.equal(last?.stage, requiredStage);
    }
    if (options.rateLimitPost && requiredStage === options.rateLimitPost) {
      return new Response(JSON.stringify({
        message: "You have exceeded a secondary rate limit.",
        documentation_url: "https://docs.github.com/rest/overview/resources-in-the-rest-api#secondary-rate-limits"
      }), {
        status: 403,
          headers: { "content-type": "application/json", "retry-after": String(options.rateLimitRetryAfterSeconds ?? 30) }
      });
    }
    const prerequisiteResult = requiredStage === "tree" ? "blob" : requiredStage === "commit" ? "tree" :
      requiredStage === "branch" ? "commit" : requiredStage === "pull_request" && branchPosts > 0 ? "branch" : null;
    if (prerequisiteResult) {
      const previous = journal.at(-2);
      assert.equal(previous?.eventType, "remote_result_verified", `${requiredStage} follows persisted ${prerequisiteResult} verification`);
      assert.equal(previous?.stage, prerequisiteResult);
    }
    if (url === `https://api.github.com/repositories/${s.repo}`) return json({ id: Number(s.repo), name: "demo", owner: { login: "octo" }, default_branch: "main", archived: false, disabled: false }, 200, `{"id":${s.repo},"name":"demo","owner":{"login":"octo"},"default_branch":"main","archived":false,"disabled":false}`);
    if (url.endsWith(`/git/ref/heads/main`)) {
      if (options.forbiddenRef) return json({ message: "Forbidden" }, 403);
      if (options.rateLimitRef) {
        return new Response(JSON.stringify({
          message: "You have exceeded a secondary rate limit.",
          documentation_url: "https://docs.github.com/rest/overview/resources-in-the-rest-api#secondary-rate-limits"
        }), {
          status: 403,
          headers: { "content-type": "application/json", "retry-after": "20" }
        });
      }
      const sha = currentBaseSha;
      if (prLookupSeen && options.invalidateBeforePrCreate) {
        options.invalidateBeforePrCreate = false;
        db.remediation.leaseToken = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      }
      if (sha !== baseSha && options.invalidateLeaseBeforeClose) {
        options.invalidateLeaseBeforeClose = false;
        db.remediation.leaseToken = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      }
      return json({ ref: "refs/heads/main", object: { type: "commit", sha } });
    }
    if (branchName && url.endsWith(`/git/ref/heads/${branchName}`)) return branchSha
      ? json({ ref: `refs/heads/${branchName}`, object: { type: "commit", sha: branchSha } })
      : json({ message: "not found" }, 404);
    if (method === "POST" && url.endsWith("/git/refs")) {
      branchPosts++;
      const body = JSON.parse(String(init?.body)) as { ref: string; sha: string };
      requestBodies.push({ url, body });
      branchName = body.ref.replace(/^refs\/heads\//u, "");
      if (options.existingBranchSha) return json({ message: "reference already exists" }, 422);
      if (options.branchConflictOnCreate) {
        branchSha = options.branchConflictOnCreate === "matching" ? body.sha : priorCommitSha;
        return json({ message: "reference already exists" }, 422);
      }
      branchSha = body.sha;
      if (options.invalidateLeaseAfterBranch) db.remediation.leaseToken = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      if (options.branchCreateAmbiguous) throw new TypeError("simulated branch response loss");
      return json({ ref: body.ref, object: { type: "commit", sha: body.sha } }, 201);
    }
    if (url.includes("/pulls?") && method === "GET") {
      prLookupSeen = true;
      const raw = pullRequest ? `[${rawPr(pullRequest)}]` : "[]";
      return json(pullRequest ? [pullRequest] : [], 200, raw);
    }
    if (url.endsWith("/pulls") && method === "POST") {
      prPosts++;
      const body = JSON.parse(String(init?.body)) as { head: string; base: string; title: string; body: string; draft: boolean };
      requestBodies.push({ url, body });
      pullRequest = buildPr(options.prHeadSha ?? commitSha, options.prBaseSha ?? currentBaseSha);
      pullRequest.head.ref = body.head;
      pullRequest.base.ref = body.base;
      if (options.moveBaseDuringPrCreate) currentBaseSha = "a".repeat(40);
      if (options.invalidateLeaseOnPrCreate) db.remediation.leaseToken = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      if (options.prCreateAmbiguous) throw new TypeError("simulated PR response loss");
      return json(pullRequest, 201, rawPr(pullRequest));
    }
    if (/\/pulls\/\d+$/u.test(url) && method === "GET") {
      return pullRequest ? json(pullRequest, 200, rawPr(pullRequest)) : json({ message: "not found" }, 404);
    }
    if (/\/pulls\/\d+$/u.test(url) && method === "PATCH") {
      closePosts++;
      requestBodies.push({ url, body: JSON.parse(String(init?.body)) });
      if (options.failPrClose) return json({ message: "close failed" }, 500);
      if (pullRequest) pullRequest.state = "closed";
      return pullRequest ? json(pullRequest, 200, rawPr(pullRequest)) : json({ message: "not found" }, 404);
    }
    if (url.endsWith(`/git/commits/${baseSha}`)) return options.malformedBaseCommit
      ? json({ sha: "bad", tree: {}, parents: null })
      : json({ sha: baseSha, tree: { sha: rootSha }, parents: [{ sha: priorCommitSha }] });
    if (url.endsWith(`/git/commits/${commitSha}`)) return json({ sha: commitSha, tree: { sha: newRootSha }, parents: [{ sha: options.unexpectedParent ? priorCommitSha : baseSha }] });
    const treeMatch = url.match(/\/git\/trees\/([0-9a-f]{40})$/u);
    if (treeMatch) return treeBodies.has(treeMatch[1]!) ? json(treeBodies.get(treeMatch[1]!)!) : json({ message: "not found" }, 404);
    if (url.endsWith(`/git/blobs/${oldBlobSha}`)) return json({ sha: oldBlobSha, size: Buffer.byteLength(old), encoding: "base64", content: Buffer.from(old).toString("base64") });
    if (url.endsWith(`/git/blobs/${writtenBlobSha}`)) return blobPersisted
      ? json({ sha: writtenBlobSha, size: Buffer.byteLength(writtenContent), encoding: "base64", content: Buffer.from(writtenContent).toString("base64") })
      : json({ message: "not found" }, 404);
    if (method === "POST" && url.endsWith("/git/blobs")) {
      const body = JSON.parse(String(init?.body)) as { content: string };
      const submitted = Buffer.from(body.content, "base64").toString("utf8");
      blobPersisted = submitted === writtenContent && !options.missingBlobAfterAmbiguous;
      if (options.failAuditAfterBlob) failAuditWrites = true;
      if (options.mutateAfterPost === "blob") db.remediation.leaseToken = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      if (options.ambiguousPost === "blob") throw new TypeError("simulated network loss");
      return json({ sha: writtenBlobSha });
    }
    if (method === "POST" && url.endsWith("/git/trees")) {
      if (options.mutateAfterPost === "tree") db.remediation.leaseToken = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      if (options.ambiguousPost === "tree") throw new TypeError("simulated network loss");
      return json({ sha: newRootSha });
    }
    if (method === "POST" && url.endsWith("/git/commits")) {
      if (options.mutateAfterPost === "commit") db.remediation.leaseToken = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      if (options.ambiguousPost === "commit") throw new TypeError("simulated network loss");
      return json({ sha: commitSha, tree: { sha: newRootSha }, parents: [{ sha: baseSha }] });
    }
    return json({ message: "unexpected request" }, 404);
  }) as typeof fetch;
  let executionRow: Record<string, any> | null = null;
  const journal: Array<{ stage: string; operationKey: string | null; requestHash: string | null; eventType: string;
    metadata: Record<string, unknown> }> = [];
  const tx = {
    $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join("?");
      if (sql.includes("COALESCE(MAX(sequence_number)")) return [{ sequence: journal.length + 1 }];
      if (sql.includes("count(*) AS count")) {
        if (sql.includes("event_type = 'remote_result_verified'")) {
          return [{ count: BigInt(journal.filter((event) => event.eventType === "remote_result_verified").length) }];
        }
        if (sql.includes("event_type = 'execution_retry_scheduled'")) {
          return [{ count: BigInt(journal.filter((event) => event.eventType === "execution_retry_scheduled").length) }];
        }
        const intents = journal.filter((event) => event.eventType === "request_intent");
        const pending = intents.filter((intent) => {
          const outcomes = journal.filter((event) => event.operationKey === intent.operationKey &&
            ["remote_result_verified", "remote_mutation_rejected"].includes(event.eventType));
          return outcomes.length !== 1 || outcomes[0]?.stage !== intent.stage || outcomes[0]?.requestHash !== intent.requestHash;
        }).length;
        return [{ count: BigInt(pending) }];
      }
      if (sql.includes("SELECT retries_left AS \"retriesLeft\"")) return [{ retriesLeft: db.retriesLeft }];
      if (sql.includes("SELECT clock_timestamp() +")) return [{ retryAt: new Date(Date.now() + Number(values[0] ?? 0)) }];
      if (sql.includes("SELECT lease_expires_at > clock_timestamp()")) return [{ valid: true }];
      if (sql.includes("SELECT request_hash AS \"requestHash\"")) return journal
        .filter((event) => event.eventType === "request_intent" && event.operationKey === values[2])
        .map((event) => ({ requestHash: event.requestHash, stage: event.stage,
          fingerprint: (event.metadata.expected as Record<string, unknown> | undefined)?.requestFingerprint ?? null }));
      if (sql.includes("SELECT event_type AS \"eventType\"")) return journal
        .filter((event) => event.eventType === "remote_result_verified" || event.eventType === "remote_mutation_rejected")
        .filter((event) => event.operationKey === values[2]).map((event) => ({ eventType: event.eventType }));
      if (sql.includes("FROM remediation_execution_events") && sql.includes("SELECT id")) return [];
      if (sql.includes("FROM remediation_executions e")) return executionRow ? [{ ...executionRow }] : [];
      if (sql.includes("INSERT INTO remediation_executions")) {
        executionRow = { id: values[0], tenantId: values[1], organizationId: values[2], projectId: values[3],
          remediationId: values[4], repositoryBindingId: values[5], installationRecordId: values[6],
          githubRepositoryId: BigInt(String(values[7])), artifactHash: values[8], baseRef: values[9],
          baseCommitSha: values[10], status: "execution_started", stage: null, attemptNumber: 1, version: 0n,
          leaseTokenHash: createHash("sha256").update(lease.leaseToken).digest("hex"),
          leaseExpiresAt: db.remediation.leaseExpiresAt, commitSha: null, branchName: null,
          pullRequestNumber: null, pullRequestUrl: null, reconciliationStatus: "not_required" };
        return [{ ...executionRow }];
      }
      if (sql.includes("FROM remediation_executions")) return executionRow ? [{ ...executionRow }] : [];
      if (sql.includes("FROM remediations r")) return [{ id: db.remediation.id, tenantId: db.remediation.tenantId,
        organizationId: db.remediation.organizationId, projectId: db.remediation.projectId,
        requestedByIdentityUserId: db.remediation.requestedByIdentityUserId,
        approvedByIdentityUserId: db.remediation.approvedByIdentityUserId,
        repositoryBindingId: db.remediation.repositoryBindingId, installationRecordId: s.installationRecord,
        githubRepositoryId: db.remediation.githubRepositoryId, artifactHash: db.remediation.executionArtifactHash,
        baseRef: "main", baseCommitSha: baseSha }];
      if (sql.includes("FROM remediations")) return [{ ...db.remediation }];
      return [{ id: "locked" }];
    },
    $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join("?");
      sqlWrites.push(sql);
      if (sql.includes("INSERT INTO remediation_execution_events")) {
        journal.push({ eventType: String(values[8]), stage: String(values[9]),
          operationKey: values[10] == null ? null : String(values[10]), requestHash: values[11] == null ? null : String(values[11]),
          metadata: typeof values[22] === "string" ? JSON.parse(values[22]) as Record<string, unknown> : {} });
        return 1;
      }
      if (sql.includes("UPDATE remediation_executions") && executionRow) {
        if (sql.includes("SET status = ?")) executionRow.status = values[0];
        if (sql.includes("SET stage = ?")) executionRow.stage = values[0];
        else if (sql.includes("SET status = ?")) executionRow.stage = values[1];
        if (sql.includes("SET status = ?")) {
          if (typeof values[2] === "string" && /^[0-9a-f]{40}$/u.test(values[2])) executionRow.commitSha = values[2];
          if (typeof values[4] === "string" && values[4].startsWith("cloudpilot/")) executionRow.branchName = values[4];
          const pullNumber = values.find((value) => typeof value === "number" && value > 0);
          const pullUrl = values.find((value) => typeof value === "string" && value.startsWith("https://github.com/"));
          if (typeof pullNumber === "number") executionRow.pullRequestNumber = pullNumber;
          if (typeof pullUrl === "string") executionRow.pullRequestUrl = pullUrl;
        }
        if (sql.includes("retry_eligible_at = ?")) {
          executionRow.retryEligibleAt = values.find((value) => value instanceof Date) ?? null;
        } else if (sql.includes("retry_eligible_at = NULL")) executionRow.retryEligibleAt = null;
        executionRow.version = BigInt(executionRow.version) + 1n;
        return 1;
      }
      if (sql.includes("UPDATE remediations SET status = ?")) {
        if (sql.includes("retries_left = retries_left - 1")) db.retriesLeft -= 1;
        else if (sql.includes("retries_left = ?")) db.retriesLeft = 0;
        db.remediation.status = String(values[0]);
        db.remediation.nextAttemptAt = values.find((value) => value instanceof Date) ?? null;
        return 1;
      }
      return 1;
    },
    organization: { findUnique: async () => ({ status: db.organizationStatus }) },
    project: { findFirst: async () => db.project }, scan: { findFirst: async () => db.scan }, finding: { findFirst: async () => db.finding },
    projectOrganizationAdoption: { findFirst: async () => db.adoptionStatus === "approved" ? { status: "approved" } : null },
    projectGitHubRepository: { findFirst: async () => db.binding },
    identityUser: { findMany: async () => [{ id: s.requester, status: db.requesterStatus }, { id: s.approver, status: db.approverStatus }] },
    organizationMember: { findFirst: async () => ({ role: db.approverMembership.role, status: db.approverMembership.status,
      user: { status: db.approverMembership.userStatus }, organization: { status: db.approverMembership.organizationStatus } }) }
  };
  const prisma = { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
  const persistence = new RemediationExecutionPersistenceService(prisma, async () => {
    if (failAuditWrites) throw new Error("controlled_audit_failure");
    const last = journal.at(-1);
    if (options.invalidateLeaseAfterIntent && last?.eventType === "request_intent" &&
        last.stage === options.invalidateLeaseAfterIntent) {
      db.remediation.leaseToken = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      options.invalidateLeaseAfterIntent = undefined;
    }
  });
  const tokens = { async getArtifactWriterInstallationToken(input: { installationId: string; repositoryId: string }): Promise<GitHubInstallationToken> {
    tokenCalls++; assert.equal(input.installationId, s.installation); assert.equal(input.repositoryId, s.repo);
    return { token: "secret-test-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), installationId: s.installation,
      repositoryId: s.repo, permissions: GITHUB_ARTIFACT_WRITER_PERMISSIONS };
  }, async getDraftPullRequestInstallationToken(input: { installationId: string; repositoryId: string }): Promise<GitHubInstallationToken> {
    assert.equal(input.installationId, s.installation); assert.equal(input.repositoryId, s.repo);
    return { token: "secret-test-pr-token", expiresAt: new Date(Date.now() + 60_000).toISOString(),
      installationId: s.installation, repositoryId: s.repo, permissions: GITHUB_DRAFT_PR_PERMISSIONS };
  }, invalidate() {} };
  const contexts = new TrustedClaimExecutionContextService(prisma);
  const capabilities = new GitHubExecutionCapabilityService(contexts, tokens, { clientOptions: { fetchImpl } });
  return { db, calls, journal, tokenCalls: () => tokenCalls, capabilities, contexts, persistence,
    setAuditFailure(value: boolean) { failAuditWrites = value; },
    setBaseRefSha(value: string) { currentBaseSha = value; },
    seedBranch(name: string, sha: string) { branchName = name; branchSha = sha; },
    seedPullRequest(name: string, state: "matching" | "wrong-head" | "wrong-base") {
      branchName = name; branchSha = commitSha;
      pullRequest = buildPr(state === "wrong-head" ? priorCommitSha : commitSha,
        state === "wrong-base" ? priorCommitSha : baseSha);
    },
    seedClosedPullRequest(name: string) {
      branchName = name; branchSha = commitSha; pullRequest = buildPr(commitSha, baseSha); pullRequest.state = "closed";
    },
    stats: () => ({ branchPosts, prPosts, closePosts }), getPullRequest: () => pullRequest,
    executionState: () => executionRow, requestBodies, sqlWrites };
}

function json(value: unknown, status = 200, raw?: string): Response {
  return new Response(raw ?? JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function run(options: Parameters<typeof setup>[0] = {}) {
  const h = setup(options);
  const capability = await h.capabilities.issue(lease);
  assert.ok(capability, "controlled fixture should issue a trusted capability");
  const context = await h.contexts.prepare(lease);
  assert.ok(context);
  const executionSession = await h.persistence.start(lease, context);
  assert.ok(executionSession);
  const fresh = await h.capabilities.leaseGuardFor(capability);
  assert.ok(fresh);
  return { ...h, capability, guard: fresh, context, executionSession, writer: new ArtifactOnlyGitHubWriter(h.capabilities) };
}

async function writeAndPublish(options: Parameters<typeof setup>[0] = {}) {
  const h = await run(options);
  const writeResult = await h.writer.write({ context: h.context, capability: h.capability, leaseGuard: h.guard, executionSession: h.executionSession });
  assert.ok(isVerifiedArtifactOnlyGitHubWriteResult(writeResult, h.capability));
  const publisher = new ArtifactOnlyGitHubDraftPrPublisher(h.capabilities);
  const publishResult = await publisher.publish({ writeResult, capability: h.capability, leaseGuard: h.guard, executionSession: h.executionSession });
  return { ...h, writeResult, publishResult, publisher };
}

test("writes and verifies one exact artifact update with pinned base, explicit tree, and sole commit parent", async () => {
  const h = await run();
  const result = await h.writer.write({ context: h.context, capability: h.capability, leaseGuard: h.guard, executionSession: h.executionSession });
  assert.deepEqual(result, { kind: "committed", commitSha, proposalId: lease.id, artifactHash: artifact.artifactHash,
    repositoryId: s.repo, baseCommitSha: baseSha });
  assert.equal(h.calls.filter((call) => call.endsWith("/git/blobs")).length, 1);
  assert.equal(h.calls.filter((call) => call.endsWith("/git/trees")).length, 1);
  assert.equal(h.calls.filter((call) => call.endsWith("/git/commits")).length, 1);
  assert.equal(h.calls.some((call) => /\/git\/refs|\/pulls|\/contents\//u.test(call)), false);
});

test("recovery reader verifies a content-addressed blob using read-only GitHub access", async () => {
  const h = await run({ ambiguousPost: "blob" });
  const outcome = await h.writer.write({ context: h.context, capability: h.capability, leaseGuard: h.guard,
    executionSession: h.executionSession });
  assert.equal(outcome.kind, "committed", "same-process read-only lookup can verify the blob after the simulated response loss");
  const boundary = internalMutationBoundary({ stage: "blob", scope: {
    proposalId: lease.id, tenantId: lease.tenantId, organizationId: s.org, projectId: lease.projectId,
    repositoryBindingId: s.binding, repositoryId: s.repo, installationRecordId: s.installationRecord,
    artifactHash: artifact.artifactHash, baseRef: "main", baseCommitSha: baseSha
  }, requestFingerprint: "d".repeat(64), operation: { filePath: h.context.filePath, renderedContentSha256: h.context.renderedContentSha256,
    byteLength: h.context.renderedBytes.byteLength, expectedBlobSha: renderedBlobSha },
  expected: { blobSha: renderedBlobSha, contentSha256: h.context.renderedContentSha256,
    byteLength: h.context.renderedBytes.byteLength, encoding: "exact-artifact-bytes" },
  mutate: async () => undefined, verify: async () => undefined });
  const before = h.calls.filter((call) => call.startsWith("POST ")).length;
  const receipt = await h.writer.recoverBlobMutation({ context: h.context, capability: h.capability,
    leaseGuard: h.guard, identity: { stage: "blob", operationKey: boundary.operationKey,
      requestHash: boundary.requestHash, operation: boundary.operation, expected: boundary.expected } });
  assert.ok(receipt);
  assert.equal(h.calls.filter((call) => call.startsWith("POST ")).length, before, "recovery performs no mutation");
  assert.ok(h.calls.some((call) => call.includes(`/git/blobs/${renderedBlobSha}`)));
});

test("restart recovery verifies deterministic branch and draft PR identities using read-only requests", async () => {
  const h = await run();
  const write = await h.writer.write({ context: h.context, capability: h.capability, leaseGuard: h.guard,
    executionSession: h.executionSession });
  assert.equal(write.kind, "committed");
  const publisher = new ArtifactOnlyGitHubDraftPrPublisher(h.capabilities);
  const branchName = deriveRemediationBranchName(h.capability);
  h.seedBranch(branchName, commitSha);
  const branchBoundary = internalMutationBoundary({ stage: "branch", scope: {
    proposalId: lease.id, tenantId: lease.tenantId, organizationId: s.org, projectId: lease.projectId,
    repositoryBindingId: s.binding, repositoryId: s.repo, installationRecordId: s.installationRecord,
    artifactHash: artifact.artifactHash, baseRef: "main", baseCommitSha: baseSha
  }, requestFingerprint: "d".repeat(64), operation: { branchName, commitSha, expectedBaseRef: "main", expectedBaseCommitSha: baseSha },
  expected: { branchName, refSha: commitSha, immutableRepositoryId: s.repo }, mutate: async () => undefined,
  verify: async () => undefined });
  const before = h.calls.filter((call) => call.startsWith("POST ")).length;
  const branchReceipt = await publisher.recoverBranchMutation({ capability: h.capability, leaseGuard: h.guard,
    identity: { stage: "branch", operationKey: branchBoundary.operationKey, requestHash: branchBoundary.requestHash,
      operation: branchBoundary.operation, expected: branchBoundary.expected }, persistedCommitSha: commitSha });
  assert.ok(branchReceipt);
  h.seedPullRequest(branchName, "matching");
  const prBoundary = internalMutationBoundary({ stage: "pull_request", scope: {
    proposalId: lease.id, tenantId: lease.tenantId, organizationId: s.org, projectId: lease.projectId,
    repositoryBindingId: s.binding, repositoryId: s.repo, installationRecordId: s.installationRecord,
    artifactHash: artifact.artifactHash, baseRef: "main", baseCommitSha: baseSha
  }, requestFingerprint: "d".repeat(64), operation: { branchName, headCommitSha: commitSha, baseRef: "main", baseCommitSha: baseSha,
    title: "CloudPilot: approved observability remediation", body: `Approved artifact: ${artifact.artifactHash}\nVerified commit: ${commitSha}`, draft: true },
  expected: { headRef: branchName, headSha: commitSha, baseRef: "main", baseSha, headRepositoryId: s.repo,
    baseRepositoryId: s.repo, draft: true, state: "open" }, mutate: async () => undefined, verify: async () => undefined });
  const prReceipt = await publisher.recoverDraftPullRequestMutation({ capability: h.capability, leaseGuard: h.guard,
    identity: { stage: "pull_request", operationKey: prBoundary.operationKey, requestHash: prBoundary.requestHash,
      operation: prBoundary.operation, expected: prBoundary.expected }, persistedCommitSha: commitSha,
    persistedBranchName: branchName });
  assert.ok(prReceipt);
  assert.equal(h.calls.filter((call) => call.startsWith("POST ")).length, before, "branch/PR recovery is read-only");
  assert.ok(h.calls.some((call) => call.includes("/pulls?head=")));
});

test("restart recovery verifies a closed PR only under exact scope and never closes it again", async () => {
  const h = await run();
  const publisher = new ArtifactOnlyGitHubDraftPrPublisher(h.capabilities);
  const branchName = deriveRemediationBranchName(h.capability);
  h.seedClosedPullRequest(branchName);
  const before = h.stats().closePosts;
  const result = await publisher.recoverClosedPullRequest({ capability: h.capability, pullRequestNumber: 41,
    pullRequestUrl: "https://github.com/octo/demo/pull/41", branchName, commitSha });
  assert.ok(result);
  assert.equal(isVerifiedArtifactOnlyPullRequestCloseResult(result, h.capability), true);
  assert.equal(h.stats().closePosts, before, "recovery never sends PATCH");
});

test("rejects forged, copied, mismatched, and expired trust inputs before GitHub access", async () => {
  const h = await run();
  const copy = { ...h.context } as typeof h.context;
  assert.deepEqual(await h.writer.write({ context: copy, capability: h.capability, leaseGuard: h.guard, executionSession: h.executionSession }),
    { kind: "failed", code: "invalid_trust_input" });
  const capCopy = { ...h.capability } as typeof h.capability;
  assert.deepEqual(await h.writer.write({ context: h.context, capability: capCopy, leaseGuard: h.guard, executionSession: h.executionSession }),
    { kind: "failed", code: "invalid_trust_input" });
  const other = await run();
  assert.deepEqual(await h.writer.write({ context: h.context, capability: h.capability, leaseGuard: other.guard, executionSession: other.executionSession }),
    { kind: "failed", code: "invalid_trust_input" });
  const changed = Object.create(Object.getPrototypeOf(h.context)) as typeof h.context;
  Object.assign(changed, h.context, { baseCommitSha: priorCommitSha });
  assert.deepEqual(await h.writer.write({ context: changed, capability: h.capability, leaseGuard: h.guard, executionSession: h.executionSession }),
    { kind: "failed", code: "invalid_trust_input" });
});

test("fails closed on base-ref movement, changed source bytes, existing create path, and missing update path", async () => {
  const moved = await run({ baseRefSha: priorCommitSha });
  assert.deepEqual(await moved.writer.write({ context: moved.context, capability: moved.capability, leaseGuard: moved.guard, executionSession: moved.executionSession }),
    { kind: "failed", code: "base_ref_moved" });
  const changed = await run({ sourceContent: "different bytes\n" });
  assert.deepEqual(await changed.writer.write({ context: changed.context, capability: changed.capability, leaseGuard: changed.guard, executionSession: changed.executionSession }),
    { kind: "failed", code: "source_state_mismatch" });
  const existingCreate = await run({ operation: "create", sourceExists: true });
  assert.deepEqual(await existingCreate.writer.write({ context: existingCreate.context, capability: existingCreate.capability, leaseGuard: existingCreate.guard, executionSession: existingCreate.executionSession }),
    { kind: "failed", code: "source_state_mismatch" });
  const missingUpdate = await run({ operation: "update", sourceExists: false });
  assert.deepEqual(await missingUpdate.writer.write({ context: missingUpdate.context, capability: missingUpdate.capability, leaseGuard: missingUpdate.guard, executionSession: missingUpdate.executionSession }),
    { kind: "failed", code: "source_state_mismatch" });
});

test("create operation requires absence and emits only the exact approved file", async () => {
  const h = await run({ operation: "create", sourceExists: false });
  const result = await h.writer.write({ context: h.context, capability: h.capability, leaseGuard: h.guard, executionSession: h.executionSession });
  assert.equal(result.kind, "committed", `${JSON.stringify(result)} ${h.calls.join(" | ")}`);
});

test("rejects unexpected tree deltas, wrong modes, truncated trees, malformed API responses, and unexpected commit parent", async () => {
  for (const options of [{ extraDelta: true }, { malformedTree: true }]) {
    const h = await run(options);
    const result = await h.writer.write({ context: h.context, capability: h.capability, leaseGuard: h.guard, executionSession: h.executionSession });
    assert.equal(result.kind, "manual_review");
    assert.equal(result.code, "post_write_verification_failed");
  }
  const parent = await run({ unexpectedParent: true });
  const result = await parent.writer.write({ context: parent.context, capability: parent.capability, leaseGuard: parent.guard, executionSession: parent.executionSession });
  assert.equal(result.kind, "manual_review");
  const truncated = await run({ truncatedTree: true });
  assert.deepEqual(await truncated.writer.write({ context: truncated.context, capability: truncated.capability, leaseGuard: truncated.guard, executionSession: truncated.executionSession }),
    { kind: "manual_review", code: "ambiguous_tree_write" });
  const malformed = await run({ malformedBaseCommit: true });
  assert.deepEqual(await malformed.writer.write({ context: malformed.context, capability: malformed.capability, leaseGuard: malformed.guard, executionSession: malformed.executionSession }),
    { kind: "failed", code: "github_read_failed" });
});

test("lease loss stops subsequent mutations and reports manual review after any accepted write", async () => {
  const beforeBlob = await run();
  beforeBlob.db.remediation.leaseToken = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  assert.deepEqual(await beforeBlob.writer.write({ context: beforeBlob.context, capability: beforeBlob.capability, leaseGuard: beforeBlob.guard, executionSession: beforeBlob.executionSession }),
    { kind: "failed", code: "lease_lost" });
  assert.equal(beforeBlob.calls.some((call) => call.startsWith("POST ")), false);

  const afterBlob = await run({ mutateAfterPost: "blob" });
  const blobResult = await afterBlob.writer.write({ context: afterBlob.context, capability: afterBlob.capability, leaseGuard: afterBlob.guard, executionSession: afterBlob.executionSession });
  assert.deepEqual(blobResult, { kind: "manual_review", code: "lease_lost_after_write" });
  assert.equal(afterBlob.calls.some((call) => call.endsWith("/git/trees")), false);
  assert.equal(afterBlob.calls.some((call) => call.endsWith("/git/commits")), false);

  const afterTree = await run({ mutateAfterPost: "tree" });
  const treeResult = await afterTree.writer.write({ context: afterTree.context, capability: afterTree.capability, leaseGuard: afterTree.guard, executionSession: afterTree.executionSession });
  assert.equal(treeResult.kind, "manual_review");
  assert.equal(afterTree.calls.some((call) => call.endsWith("/git/commits")), false);
});

test("ambiguous blob is reconciled by its known Git object ID; tree/commit ambiguity stops without retry", async () => {
  const blob = await run({ ambiguousPost: "blob" });
  const blobResult = await blob.writer.write({ context: blob.context, capability: blob.capability, leaseGuard: blob.guard, executionSession: blob.executionSession });
  assert.equal(blobResult.kind, "committed");
  assert.equal(blob.calls.filter((call) => call.endsWith("/git/blobs")).length, 1, "ambiguous blob write is never repeated");

  const missingBlob = await run({ ambiguousPost: "blob", missingBlobAfterAmbiguous: true });
  const missingResult = await missingBlob.writer.write({ context: missingBlob.context, capability: missingBlob.capability, leaseGuard: missingBlob.guard, executionSession: missingBlob.executionSession });
  assert.deepEqual(missingResult, { kind: "manual_review", code: "ambiguous_blob_write" });

  for (const kind of ["tree", "commit"] as const) {
    const h = await run({ ambiguousPost: kind });
    const result = await h.writer.write({ context: h.context, capability: h.capability, leaseGuard: h.guard, executionSession: h.executionSession });
    assert.deepEqual(result, { kind: "manual_review", code: `ambiguous_${kind}_write` });
    assert.equal(h.calls.filter((call) => call.endsWith(`/git/${kind === "tree" ? "trees" : "commits"}`)).length, 1);
  }
});

test("mutation intents precede each GitHub write; audit failure blocks writes and result failure stays manual review", async () => {
  const noIntent = await run();
  noIntent.setAuditFailure(true);
  const refused = await noIntent.writer.write({ context: noIntent.context, capability: noIntent.capability,
    leaseGuard: noIntent.guard, executionSession: noIntent.executionSession });
  assert.equal(refused.kind, "failed");
  assert.equal(noIntent.calls.some((call) => call.startsWith("POST ")), false,
    "intent/audit transaction failure prevents the GitHub mutation");

  const resultFailure = await run({ failAuditAfterBlob: true });
  const unresolved = await resultFailure.writer.write({ context: resultFailure.context, capability: resultFailure.capability,
    leaseGuard: resultFailure.guard, executionSession: resultFailure.executionSession });
  assert.deepEqual(unresolved, { kind: "manual_review", code: "post_write_verification_failed" });
  assert.equal(resultFailure.calls.filter((call) => call.endsWith("/git/blobs")).length, 1);
  assert.equal(resultFailure.calls.some((call) => call.endsWith("/git/trees") || call.endsWith("/git/commits")), false,
    "failed result persistence leaves the blob intent unresolved and stops later writes");
});

test("lease loss after committed intent but before the request is manual review and sends no GitHub mutation", async () => {
  const h = await run({ invalidateLeaseAfterIntent: "blob" });
  const result = await h.writer.write({ context: h.context, capability: h.capability, leaseGuard: h.guard,
    executionSession: h.executionSession });
  assert.deepEqual(result, { kind: "manual_review", code: "ambiguous_remote_operation" });
  assert.equal(h.calls.some((call) => call.startsWith("POST ")), false);
  assert.equal(h.journal.at(-1)?.eventType, "request_intent");
  assert.equal(h.journal.at(-1)?.stage, "blob");
});

test("derives a stable branch from proposal and artifact identity and publishes only the verified commit", async () => {
  const h = await writeAndPublish();
  const branchName = deriveRemediationBranchName(h.capability);
  assert.equal(branchName, deriveRemediationBranchName(h.capability));
  assert.match(branchName, /^cloudpilot\/remediation\/[0-9a-f]{40}$/u);
  assert.deepEqual(h.publishResult, { kind: "draft_pull_request", pullRequestNumber: 41,
    pullRequestUrl: "https://github.com/octo/demo/pull/41", branchName, commitSha, artifactHash: artifact.artifactHash,
    reconciled: false });
  assert.deepEqual(h.stats(), { branchPosts: 1, prPosts: 1, closePosts: 0 });
  assert.deepEqual(h.requestBodies.find((request) => request.url.endsWith("/git/refs"))?.body,
    { ref: `refs/heads/${branchName}`, sha: commitSha });
  const prBody = h.requestBodies.find((request) => request.url.endsWith("/pulls"))?.body as Record<string, unknown>;
  assert.deepEqual(prBody, { head: branchName, base: "main", title: "CloudPilot: approved observability remediation",
    body: `Approved artifact: ${artifact.artifactHash}\nVerified commit: ${commitSha}`, draft: true });
  assert.equal(h.calls.some((call) => /\/pulls\/\d+$/u.test(call) && call.startsWith("POST ")), false);
  const repeated = await h.publisher.publish({ writeResult: h.writeResult, capability: h.capability, leaseGuard: h.guard, executionSession: h.executionSession });
  assert.equal(repeated.kind, "manual_review", "already persisted PR state is not reported as a new verified outcome");
  if (repeated.kind === "manual_review") assert.equal(repeated.code, "pull_request_conflict");
  assert.deepEqual(h.stats(), { branchPosts: 1, prPosts: 1, closePosts: 0 }, "replay reconciles instead of creating another ref or PR");
});

test("rejects copied execution results, accepts only an exact pre-existing branch, and never overwrites a conflict", async () => {
  const first = await run();
  const writeResult = await first.writer.write({ context: first.context, capability: first.capability, leaseGuard: first.guard, executionSession: first.executionSession });
  assert.ok(isVerifiedArtifactOnlyGitHubWriteResult(writeResult, first.capability));
  const before = first.stats();
  const publisher = new ArtifactOnlyGitHubDraftPrPublisher(first.capabilities);
  const forged = { ...writeResult } as typeof writeResult;
  assert.deepEqual(await publisher.publish({ writeResult: forged as never, capability: first.capability, leaseGuard: first.guard, executionSession: first.executionSession }),
    { kind: "failed", code: "invalid_trust_input" });
  assert.deepEqual(first.stats(), before);

  const exact = await run();
  const exactResult = await exact.writer.write({ context: exact.context, capability: exact.capability, leaseGuard: exact.guard, executionSession: exact.executionSession });
  assert.ok(isVerifiedArtifactOnlyGitHubWriteResult(exactResult, exact.capability));
  exact.seedBranch(deriveRemediationBranchName(exact.capability), commitSha);
  assert.equal((await new ArtifactOnlyGitHubDraftPrPublisher(exact.capabilities).publish({
    writeResult: exactResult, capability: exact.capability, leaseGuard: exact.guard, executionSession: exact.executionSession
  })).kind, "draft_pull_request");
  assert.equal(exact.stats().branchPosts, 0);

  const conflict = await run();
  const conflictResult = await conflict.writer.write({ context: conflict.context, capability: conflict.capability, leaseGuard: conflict.guard, executionSession: conflict.executionSession });
  assert.ok(isVerifiedArtifactOnlyGitHubWriteResult(conflictResult, conflict.capability));
  conflict.seedBranch(deriveRemediationBranchName(conflict.capability), priorCommitSha);
  assert.deepEqual(await new ArtifactOnlyGitHubDraftPrPublisher(conflict.capabilities).publish({
    writeResult: conflictResult, capability: conflict.capability, leaseGuard: conflict.guard, executionSession: conflict.executionSession
  }), { kind: "failed", code: "branch_conflict" });
  assert.deepEqual(conflict.stats(), { branchPosts: 0, prPosts: 0, closePosts: 0 });
});

test("ambiguous branch and draft-PR creates reconcile by exact repository, branch, commit, and base", async () => {
  const branch = await writeAndPublish({ branchCreateAmbiguous: true });
  assert.equal(branch.publishResult.kind, "draft_pull_request");
  assert.equal(branch.stats().branchPosts, 1, "ambiguous branch create is never retried");

  const branchConflict = await writeAndPublish({ branchConflictOnCreate: "matching" });
  assert.equal(branchConflict.publishResult.kind, "draft_pull_request", "a racing exact ref is read and accepted");
  assert.equal(branchConflict.stats().branchPosts, 1);
  const unsafeConflict = await writeAndPublish({ branchConflictOnCreate: "different" });
  assert.equal(unsafeConflict.publishResult.kind, "manual_review");
  if (unsafeConflict.publishResult.kind === "manual_review") assert.equal(unsafeConflict.publishResult.code, "ambiguous_branch_creation");
  assert.equal(unsafeConflict.stats().prPosts, 0, "a conflicting ref is never overwritten or used for PR creation");

  const pr = await writeAndPublish({ prCreateAmbiguous: true });
  assert.equal(pr.publishResult.kind, "draft_pull_request");
  if (pr.publishResult.kind === "draft_pull_request") assert.equal(pr.publishResult.reconciled, true);
  assert.equal(pr.stats().prPosts, 1, "ambiguous PR create is never retried");
});

test("wrong PR head or base identity is not accepted as successful reconciliation", async () => {
  const wrongHead = await writeAndPublish({ prHeadSha: priorCommitSha });
  assert.deepEqual(wrongHead.publishResult, { kind: "manual_review", code: "pull_request_verification_failed",
    pullRequestNumber: 41, pullRequestUrl: "https://github.com/octo/demo/pull/41", branchName: deriveRemediationBranchName(wrongHead.capability) });
  assert.equal(wrongHead.stats().closePosts, 0, "a different head commit is never accepted or modified automatically");

  const wrongBase = await writeAndPublish({ prBaseSha: priorCommitSha });
  assert.equal(wrongBase.publishResult.kind, "manual_review");
  if (wrongBase.publishResult.kind === "manual_review") assert.equal(wrongBase.publishResult.code, "base_mismatch_draft_closed");
  assert.equal(wrongBase.stats().closePosts, 1, "a draft tied to a different base SHA is safely closed");
});

test("base movement before PR creation leaves the pinned branch for review and creates no PR", async () => {
  const h = await run();
  const writeResult = await h.writer.write({ context: h.context, capability: h.capability, leaseGuard: h.guard, executionSession: h.executionSession });
  assert.ok(isVerifiedArtifactOnlyGitHubWriteResult(writeResult, h.capability));
  h.setBaseRefSha("a".repeat(40));
  const result = await new ArtifactOnlyGitHubDraftPrPublisher(h.capabilities).publish({
    writeResult, capability: h.capability, leaseGuard: h.guard, executionSession: h.executionSession
  });
  assert.equal(result.kind, "manual_review");
  if (result.kind === "manual_review") assert.equal(result.code, "base_moved_before_pull_request");
  assert.equal(h.stats().branchPosts, 1);
  assert.equal(h.stats().prPosts, 0);
});

test("base movement during PR creation closes the scoped draft; closure failure reports the unresolved PR", async () => {
  const closed = await writeAndPublish({ moveBaseDuringPrCreate: true });
  assert.equal(closed.publishResult.kind, "manual_review");
  if (closed.publishResult.kind === "manual_review") {
    assert.equal(closed.publishResult.code, "base_moved_draft_closed");
    assert.equal(isVerifiedArtifactOnlyPullRequestCloseResult(closed.publishResult, closed.capability), true);
    assert.equal(isVerifiedArtifactOnlyPullRequestCloseResult({ ...closed.publishResult }, closed.capability), false);
  }
  assert.deepEqual(closed.stats(), { branchPosts: 1, prPosts: 1, closePosts: 1 });
  assert.equal(closed.getPullRequest()?.state, "closed");

  const unresolved = await writeAndPublish({ moveBaseDuringPrCreate: true, failPrClose: true });
  assert.equal(unresolved.publishResult.kind, "manual_review");
  if (unresolved.publishResult.kind === "manual_review") {
    assert.equal(unresolved.publishResult.code, "base_moved_draft_close_failed");
    assert.equal(unresolved.publishResult.pullRequestNumber, 41);
    assert.equal(unresolved.publishResult.pullRequestUrl, "https://github.com/octo/demo/pull/41");
  }
});

test("lease loss before branch, before PR, and before compensating closure stops further mutations", async () => {
  const beforeBranch = await run();
  const beforeBranchResult = await beforeBranch.writer.write({ context: beforeBranch.context,
    capability: beforeBranch.capability, leaseGuard: beforeBranch.guard, executionSession: beforeBranch.executionSession });
  assert.ok(isVerifiedArtifactOnlyGitHubWriteResult(beforeBranchResult, beforeBranch.capability));
  beforeBranch.db.remediation.leaseToken = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  assert.deepEqual(await new ArtifactOnlyGitHubDraftPrPublisher(beforeBranch.capabilities).publish({
    writeResult: beforeBranchResult, capability: beforeBranch.capability, leaseGuard: beforeBranch.guard, executionSession: beforeBranch.executionSession
  }), { kind: "failed", code: "lease_lost" });
  assert.deepEqual(beforeBranch.stats(), { branchPosts: 0, prPosts: 0, closePosts: 0 });

  const beforePr = await writeAndPublish({ invalidateBeforePrCreate: true });
  assert.equal(beforePr.publishResult.kind, "manual_review");
  if (beforePr.publishResult.kind === "manual_review") assert.equal(beforePr.publishResult.code, "lease_lost_after_write");
  assert.deepEqual(beforePr.stats(), { branchPosts: 1, prPosts: 0, closePosts: 0 });

  const beforeClose = await writeAndPublish({ moveBaseDuringPrCreate: true, invalidateLeaseBeforeClose: true });
  assert.equal(beforeClose.publishResult.kind, "manual_review");
  if (beforeClose.publishResult.kind === "manual_review") {
    assert.equal(beforeClose.publishResult.code, "base_moved_draft_close_failed");
    assert.equal(beforeClose.publishResult.pullRequestNumber, 41);
  }
  assert.equal(beforeClose.stats().closePosts, 0);
});

test("orchestrator runs persisted context, split capabilities, exact writer, and verified draft PR in order", async () => {
  const h = setup();
  const sequence: string[] = [];
  const contexts = { async prepare(value: RemediationLease) { sequence.push("context"); return h.contexts.prepare(value); } };
  const capabilities = {
    async issue(value: RemediationLease) { sequence.push("capability"); return h.capabilities.issue(value); },
    leaseGuardFor(value: unknown) { return h.capabilities.leaseGuardFor(value); }
  };
  const baseWriter = new ArtifactOnlyGitHubWriter(h.capabilities);
  const writer = { async write(input: Parameters<ArtifactOnlyGitHubWriter["write"]>[0]) {
    sequence.push("write"); return baseWriter.write(input);
  } };
  const publisher = new ArtifactOnlyGitHubDraftPrPublisher(h.capabilities);
  const orchestrator = new ArtifactOnlyExecutionOrchestrator(contexts, capabilities, writer, {
    async publish(input) { sequence.push("publish"); return publisher.publish(input); }
  }, h.persistence);

  const result = await orchestrator.execute(lease);
  assert.deepEqual(sequence, ["context", "capability", "write", "publish"]);
  const expectedBranch = `cloudpilot/remediation/${createHash("sha256").update(`${lease.id}\0${artifact.artifactHash}`, "utf8").digest("hex").slice(0, 40)}`;
  assert.deepEqual(result, { kind: "draft_pull_request", remediationId: lease.id, proposalId: lease.id,
    artifactHash: artifact.artifactHash, commitSha, pullRequestNumber: 41,
    pullRequestUrl: "https://github.com/octo/demo/pull/41", branchName: expectedBranch, reconciled: false });
  assert.deepEqual(h.stats(), { branchPosts: 1, prPosts: 1, closePosts: 0 });
  assert.equal(JSON.stringify(result).includes("secret-test"), false);
});

test("orchestrator fails closed for invalid persisted lease and authorization before token or GitHub work", async () => {
  const h = setup();
  const orchestrator = new ArtifactOnlyExecutionOrchestrator(h.contexts, h.capabilities,
    new ArtifactOnlyGitHubWriter(h.capabilities), new ArtifactOnlyGitHubDraftPrPublisher(h.capabilities), h.persistence);
  assert.deepEqual(await orchestrator.execute({ ...lease, leaseToken: "ffffffff-ffff-4fff-8fff-ffffffffffff" }),
    { kind: "failed", stage: "context", code: "claim_not_authorized", remediationId: lease.id });
  h.db.adoptionStatus = "rejected";
  assert.deepEqual(await orchestrator.execute(lease),
    { kind: "failed", stage: "context", code: "claim_not_authorized", remediationId: lease.id });
  assert.equal(h.tokenCalls(), 0);
  assert.deepEqual(h.calls, []);
});

test("orchestrator rejects unbranded context or capability results before writer execution", async () => {
  const h = setup();
  let writerCalls = 0;
  const contextForgery = new ArtifactOnlyExecutionOrchestrator(
    { async prepare() { return {} as never; } }, h.capabilities,
    { async write() { writerCalls++; return { kind: "failed", code: "github_read_failed" }; } },
    new ArtifactOnlyGitHubDraftPrPublisher(h.capabilities), h.persistence);
  assert.deepEqual(await contextForgery.execute(lease),
    { kind: "failed", stage: "context", code: "claim_not_authorized", remediationId: lease.id });

  const capabilityForgery = new ArtifactOnlyExecutionOrchestrator(h.contexts,
    { async issue() { return { proposalId: lease.id } as never; }, leaseGuardFor() { return null; } },
    { async write() { writerCalls++; return { kind: "failed", code: "github_read_failed" }; } },
    new ArtifactOnlyGitHubDraftPrPublisher(h.capabilities), h.persistence);
  assert.deepEqual(await capabilityForgery.execute(lease),
    { kind: "failed", stage: "capability", code: "claim_not_authorized", remediationId: lease.id });
  assert.equal(writerCalls, 0);
  assert.equal(h.tokenCalls(), 0);
  assert.deepEqual(h.calls, []);
});

test("writer refusal prevents PR publication, and publication failure after commit becomes manual review", async () => {
  const denied = setup();
  let publishCalls = 0;
  const refused = new ArtifactOnlyExecutionOrchestrator(denied.contexts, denied.capabilities,
    { async write() { return { kind: "failed", code: "source_state_mismatch" }; } },
    { async publish() { publishCalls++; return { kind: "failed", code: "github_request_failed" }; } }, denied.persistence);
  assert.deepEqual(await refused.execute(lease), { kind: "failed", stage: "write", code: "source_state_mismatch",
    remediationId: lease.id });
  assert.equal(publishCalls, 0);
  assert.deepEqual(denied.stats(), { branchPosts: 0, prPosts: 0, closePosts: 0 });

  const partial = setup({ existingBranchSha: priorCommitSha });
  const partialOrchestrator = new ArtifactOnlyExecutionOrchestrator(partial.contexts, partial.capabilities,
    new ArtifactOnlyGitHubWriter(partial.capabilities), new ArtifactOnlyGitHubDraftPrPublisher(partial.capabilities), partial.persistence);
  const outcome = await partialOrchestrator.execute(lease);
  assert.deepEqual(outcome, { kind: "manual_review", stage: "publish", code: "ambiguous_branch_creation",
    remediationId: lease.id, proposalId: lease.id, artifactHash: artifact.artifactHash, commitSha,
    branchName: `cloudpilot/remediation/${createHash("sha256").update(`${lease.id}\0${artifact.artifactHash}`, "utf8").digest("hex").slice(0, 40)}` });
  assert.deepEqual(partial.stats(), { branchPosts: 1, prPosts: 0, closePosts: 0 });
});

test("lease loss after a verified commit but before publisher invocation is manual review", async () => {
  const h = setup();
  const realWriter = new ArtifactOnlyGitHubWriter(h.capabilities);
  const orchestrator = new ArtifactOnlyExecutionOrchestrator(h.contexts, h.capabilities, {
    async write(input) {
      const result = await realWriter.write(input);
      h.db.remediation.leaseToken = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      return result;
    }
  }, new ArtifactOnlyGitHubDraftPrPublisher(h.capabilities), h.persistence);
  assert.deepEqual(await orchestrator.execute(lease), { kind: "manual_review", stage: "publish",
    code: "lease_lost_after_write", remediationId: lease.id, proposalId: lease.id,
    artifactHash: artifact.artifactHash, commitSha });
  assert.equal(h.stats().branchPosts, 0);
  assert.equal(h.stats().prPosts, 0);
});

test("orchestrator turns authorization loss during an accepted Git request into manual review and stops later writes", async () => {
  // The fetch mock changes the persisted lease after the pre-request guard has
  // passed, then returns the accepted blob response. The request cannot be
  // atomically cancelled; no tree, commit, branch, or PR operation may follow.
  const h = setup({ mutateAfterPost: "blob" });
  const orchestrator = new ArtifactOnlyExecutionOrchestrator(h.contexts, h.capabilities,
    new ArtifactOnlyGitHubWriter(h.capabilities), new ArtifactOnlyGitHubDraftPrPublisher(h.capabilities), h.persistence);
  const result = await orchestrator.execute(lease);
  assert.deepEqual(result, { kind: "manual_review", stage: "write", code: "lease_lost_after_write",
    remediationId: lease.id, proposalId: lease.id, artifactHash: artifact.artifactHash });
  assert.equal(h.calls.filter((call) => call.endsWith("/git/blobs")).length, 1);
  assert.equal(h.calls.some((call) => call.startsWith("POST ") &&
    /\/git\/(trees|commits|refs)|\/pulls/u.test(call)), false);
});

test("orchestrator preserves partial-write and unresolved PR details for manual reconciliation", async () => {
  const h = setup({ moveBaseDuringPrCreate: true, failPrClose: true });
  const orchestrator = new ArtifactOnlyExecutionOrchestrator(h.contexts, h.capabilities,
    new ArtifactOnlyGitHubWriter(h.capabilities), new ArtifactOnlyGitHubDraftPrPublisher(h.capabilities), h.persistence);
  const result = await orchestrator.execute(lease);
  assert.deepEqual(result, { kind: "manual_review", stage: "publish", code: "base_moved_draft_close_failed",
    remediationId: lease.id, proposalId: lease.id, artifactHash: artifact.artifactHash, commitSha,
    pullRequestNumber: 41, pullRequestUrl: "https://github.com/octo/demo/pull/41",
    branchName: `cloudpilot/remediation/${createHash("sha256").update(`${lease.id}\0${artifact.artifactHash}`, "utf8").digest("hex").slice(0, 40)}` });
  assert.deepEqual(h.stats(), { branchPosts: 1, prPosts: 1, closePosts: 1 });
});

test("writer and orchestrator propagate rate-limit retryAfterMs on read and write rejections", async () => {
  // 1. Rate-limited read reference propagates retryAfterMs through writer and orchestrator
  const readLimited = setup({ rateLimitRef: true });
  const orchestratorRead = new ArtifactOnlyExecutionOrchestrator(readLimited.contexts, readLimited.capabilities,
    new ArtifactOnlyGitHubWriter(readLimited.capabilities), new ArtifactOnlyGitHubDraftPrPublisher(readLimited.capabilities), readLimited.persistence);
  const readOutcome = await orchestratorRead.execute(lease);
  assert.deepEqual(readOutcome, {
    kind: "failed",
    stage: "write",
    code: "rate_limited",
    remediationId: lease.id,
    retryAfterMs: 20_000
  });

  // 2. Ordinary 403 forbidden without rate-limit headers remains terminal github_read_failed without retryAfterMs
  const forbidden = setup({ forbiddenRef: true });
  const orchestratorForbidden = new ArtifactOnlyExecutionOrchestrator(forbidden.contexts, forbidden.capabilities,
    new ArtifactOnlyGitHubWriter(forbidden.capabilities), new ArtifactOnlyGitHubDraftPrPublisher(forbidden.capabilities), forbidden.persistence);
  const forbiddenOutcome = await orchestratorForbidden.execute(lease);
  assert.deepEqual(forbiddenOutcome, {
    kind: "failed",
    stage: "write",
    code: "github_read_failed",
    remediationId: lease.id
  });
  assert.equal((forbiddenOutcome as any).retryAfterMs, undefined);

  // 3. Rate-limited blob mutation propagates retryAfterMs through writer and orchestrator
  const blobLimited = setup({ rateLimitPost: "blob" });
  const orchestratorBlob = new ArtifactOnlyExecutionOrchestrator(blobLimited.contexts, blobLimited.capabilities,
    new ArtifactOnlyGitHubWriter(blobLimited.capabilities), new ArtifactOnlyGitHubDraftPrPublisher(blobLimited.capabilities), blobLimited.persistence);
  const blobOutcome = await orchestratorBlob.execute(lease);
  assert.deepEqual(blobOutcome, {
    kind: "retry_scheduled",
    stage: "write",
    code: "rate_limited",
    remediationId: lease.id,
    retryAfterMs: 30_000
  });
  const blobRejections = blobLimited.journal.filter((event) => event.eventType === "remote_mutation_rejected");
  assert.equal(blobRejections.length, 1);
  assert.equal(blobRejections[0].stage, "blob");
  assert.equal(blobRejections[0].metadata.rejection, "secondary_rate_limit");
  assert.equal(typeof blobRejections[0].metadata.requestFingerprint, "string");
  const retryScheduled = blobLimited.journal.filter((event) => event.eventType === "execution_retry_scheduled");
  assert.equal(retryScheduled.length, 1);
  assert.equal(retryScheduled[0].metadata.retryOrdinal, 1);
  assert.equal(retryScheduled[0].metadata.retryAfterMs, 30_000);
  assert.equal(typeof retryScheduled[0].metadata.retryAt, "string");
  assert.ok(blobLimited.sqlWrites.some((sql) => sql.includes("retries_left = retries_left - 1")));
  assert.ok(blobLimited.sqlWrites.some((sql) => sql.includes("retry_eligible_at = ?")));
  assert.ok(blobLimited.sqlWrites.some((sql) => sql.includes("next_attempt_at = ?")));

  const clamped = setup({ rateLimitPost: "blob", rateLimitRetryAfterSeconds: 120 });
  const clampedOrchestrator = new ArtifactOnlyExecutionOrchestrator(clamped.contexts, clamped.capabilities,
    new ArtifactOnlyGitHubWriter(clamped.capabilities), new ArtifactOnlyGitHubDraftPrPublisher(clamped.capabilities), clamped.persistence);
  assert.deepEqual(await clampedOrchestrator.execute(lease), {
    kind: "retry_scheduled", stage: "write", code: "rate_limited", remediationId: lease.id, retryAfterMs: 60_000
  });
  assert.equal(clamped.journal.find((event) => event.eventType === "execution_retry_scheduled")?.metadata.retryAfterMs, 60_000);

  const exhausted = setup({ rateLimitPost: "blob", retriesLeft: 0 });
  const exhaustedOrchestrator = new ArtifactOnlyExecutionOrchestrator(exhausted.contexts, exhausted.capabilities,
    new ArtifactOnlyGitHubWriter(exhausted.capabilities), new ArtifactOnlyGitHubDraftPrPublisher(exhausted.capabilities), exhausted.persistence);
  assert.deepEqual(await exhaustedOrchestrator.execute(lease), {
    kind: "failed", stage: "write", code: "rate_limited", remediationId: lease.id, retryAfterMs: 30_000
  });
  assert.equal(exhausted.journal.some((event) => event.eventType === "remote_mutation_rejected"), true);
  assert.equal(exhausted.journal.some((event) => event.eventType === "execution_retry_scheduled"), false);
  assert.ok(exhausted.sqlWrites.some((sql) => sql.includes("UPDATE remediations SET status = 'failed'") &&
    sql.includes("retries_left = 0") && sql.includes("next_attempt_at = NULL")));

  // 4. Rate-limited tree mutation propagates retryAfterMs through writer and orchestrator
  const treeLimited = setup({ rateLimitPost: "tree" });
  const orchestratorTree = new ArtifactOnlyExecutionOrchestrator(treeLimited.contexts, treeLimited.capabilities,
    new ArtifactOnlyGitHubWriter(treeLimited.capabilities), new ArtifactOnlyGitHubDraftPrPublisher(treeLimited.capabilities), treeLimited.persistence);
  const treeOutcome = await orchestratorTree.execute(lease);
  assert.deepEqual(treeOutcome, {
    kind: "manual_review",
    stage: "write",
    code: "ambiguous_remote_operation",
    remediationId: lease.id,
    proposalId: lease.id,
    artifactHash: artifact.artifactHash
  });
  assert.equal(treeLimited.journal.filter((event) => event.eventType === "remote_mutation_rejected").length, 1);
  assert.equal(treeLimited.journal.find((event) => event.eventType === "remote_mutation_rejected")?.stage, "tree");

  // 5. Rate-limited commit mutation propagates retryAfterMs through writer and orchestrator
  const commitLimited = setup({ rateLimitPost: "commit" });
  const orchestratorCommit = new ArtifactOnlyExecutionOrchestrator(commitLimited.contexts, commitLimited.capabilities,
    new ArtifactOnlyGitHubWriter(commitLimited.capabilities), new ArtifactOnlyGitHubDraftPrPublisher(commitLimited.capabilities), commitLimited.persistence);
  const commitOutcome = await orchestratorCommit.execute(lease);
  assert.deepEqual(commitOutcome, {
    kind: "manual_review",
    stage: "write",
    code: "ambiguous_remote_operation",
    remediationId: lease.id,
    proposalId: lease.id,
    artifactHash: artifact.artifactHash
  });
  assert.equal(commitLimited.journal.filter((event) => event.eventType === "remote_mutation_rejected").length, 1);
  assert.equal(commitLimited.journal.find((event) => event.eventType === "remote_mutation_rejected")?.stage, "commit");
});
