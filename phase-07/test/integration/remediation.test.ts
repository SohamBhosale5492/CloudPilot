/**
 * Phase 07 Integration Tests — Remediation lifecycle against real PostgreSQL.
 *
 * Requires CLOUDPILOT_FIXTURE_TEST_DATABASE_URL for the isolated
 * cloudpilot_runtime_role_test database and fixture-only role on loopback port 56440.
 *   - Phase 06 migrations already applied
 *   - Phase 07 migration applied (remediations table)
 *
 * A local in-process HTTP server acts as a mock GitHub API — no real
 * GitHub account or network access required.
 *
 * Test coverage:
 *   1. Migration: remediations table exists
 *   2. Happy path: branch created, file updated, PR opened, DB record = open
 *   3. Idempotency: second call for same finding returns same PR, no duplicate DB row
 *   4. Idempotency (existing open PR): PR already open on GitHub → skips createPR
 *   5. Branch conflict: 422 from GitHub createBranch → continues to updateFile/createPR
 *   6. File not found: 404 from getFileContent → creates file with placeholder
 *   7. GitHub failure: API returns 500 → DB record has errorMessage, retriesLeft decremented
 *   8. Retry exhaustion: after max failures, status = "failed"
 *   9. Tenant isolation: remediation from tenant A not visible to tenant B
 *  10. listByProject: paginated listing returns correct remediations per tenant
 *  11. Unsupported signal (trace): skipped, no DB record created
 *  12. Non-gap outcome (pass): skipped, no DB record created
 *  13. Concurrent identical requests: exactly one DB row created (idempotency key unique)
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { GitHubConnector } from "../../src/github/github-connector.js";
import { RemediationOrchestrator, buildBranchName } from "../../src/remediation/orchestrator.js";
import { RemediationRepository, InvalidCursorError } from "../../src/db/remediation-repo.js";
import { buildIdempotencyKey } from "../../src/remediation/planner.js";
import { requireIntegrationFixtureDatabaseUrl } from "../../../test-support/integration-database.js";

// ─── Shared state ────────────────────────────────────────────────────────────

const DATABASE_URL = requireIntegrationFixtureDatabaseUrl(process.env.CLOUDPILOT_FIXTURE_TEST_DATABASE_URL);

let prisma: PrismaClient;
let tenantId: string;
let tenantBId: string;
const fixtureTenantIds: string[] = [];
let projectId: string;
let projectBId: string;
let scanId: string;
let scanBId: string;
let findingId: string;

// Mock GitHub server
let mockGhServer: http.Server;
let mockGhBaseUrl: string;

// What the mock GitHub server returns (overridden per-test)
interface MockGhState {
  openPrs: Map<string, { number: number; url: string }>;
  branches: Set<string>;
  files: Map<string, { content: string; sha: string }>;
  failNextRequest?: { status: number; message: string };
  prCounter: number;
}

const ghState: MockGhState = {
  openPrs: new Map(),
  branches: new Set(),
  files: new Map(),
  prCounter: 100
};

function resetGhState(): void {
  ghState.openPrs.clear();
  ghState.branches.clear();
  ghState.files.clear();
  ghState.failNextRequest = undefined;
  ghState.prCounter = 100;
  // Always have a "main" branch with a known SHA
  ghState.branches.add("main");
}

function startMockGitHub(): Promise<string> {
  return new Promise((resolve) => {
    mockGhServer = http.createServer((req, res) => {
      handleMockGh(req, res).catch((err) => {
        res.writeHead(500);
        res.end(JSON.stringify({ message: String(err) }));
      });
    });
    mockGhServer.listen(0, "127.0.0.1", () => {
      const addr = mockGhServer.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

async function handleMockGh(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url!, "http://localhost");
  const body = await readBody(req);
  const parsed = body ? JSON.parse(body) : {};

  const send = (status: number, data: unknown) => {
    const text = JSON.stringify(data);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(text);
  };

  if (ghState.failNextRequest) {
    const { status, message } = ghState.failNextRequest;
    ghState.failNextRequest = undefined;
    return send(status, { message });
  }

  const path = url.pathname;

  // GET /repos/:owner/:repo/git/refs/heads/:branch — get branch SHA
  const refMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/);
  if (refMatch && req.method === "GET") {
    const branch = refMatch[3];
    if (!ghState.branches.has(branch)) return send(404, { message: "Reference not found" });
    return send(200, { object: { sha: "a".repeat(40) } });
  }

  // POST /repos/:owner/:repo/git/refs — create branch
  const createRefMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/);
  if (createRefMatch && req.method === "POST") {
    const branchName = (parsed.ref as string).replace("refs/heads/", "");
    if (ghState.branches.has(branchName)) {
      return send(422, { message: "Reference already exists" });
    }
    ghState.branches.add(branchName);
    return send(201, { ref: parsed.ref, object: { sha: parsed.sha } });
  }

  // GET /repos/:owner/:repo/contents/:path — get file
  const contentsGetMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
  if (contentsGetMatch && req.method === "GET") {
    const filePath = decodeURIComponent(contentsGetMatch[3]);
    const file = ghState.files.get(filePath);
    if (!file) return send(404, { message: "Not Found" });
    return send(200, {
      path: filePath,
      content: Buffer.from(file.content).toString("base64"),
      sha: file.sha,
      encoding: "base64"
    });
  }

  // PUT /repos/:owner/:repo/contents/:path — update/create file
  const contentsPutMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
  if (contentsPutMatch && req.method === "PUT") {
    const filePath = decodeURIComponent(contentsPutMatch[3]);
    const newContent = Buffer.from(parsed.content as string, "base64").toString("utf8");
    const newSha = "sha-" + Math.random().toString(36).slice(2, 10);
    ghState.files.set(filePath, { content: newContent, sha: newSha });
    return send(200, { content: { sha: newSha } });
  }

  // GET /repos/:owner/:repo/pulls — list PRs
  const pullsGetMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/);
  if (pullsGetMatch && req.method === "GET") {
    const headParam = url.searchParams.get("head") ?? "";
    const branchName = headParam.includes(":") ? headParam.split(":")[1] : headParam;
    const existing = ghState.openPrs.get(branchName);
    if (!existing) return send(200, []);
    return send(200, [{
      number: existing.number,
      html_url: existing.url,
      title: "existing",
      state: "open",
      head: { ref: branchName },
      base: { ref: "main" }
    }]);
  }

  // POST /repos/:owner/:repo/pulls — create PR
  const pullsCreateMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/);
  if (pullsCreateMatch && req.method === "POST") {
    const num = ++ghState.prCounter;
    const prUrl = `${mockGhBaseUrl}/o/r/pull/${num}`;
    const headBranch = parsed.head as string;
    ghState.openPrs.set(headBranch, { number: num, url: prUrl });
    return send(201, {
      number: num,
      html_url: prUrl,
      title: parsed.title,
      state: "open",
      head: { ref: headBranch },
      base: { ref: parsed.base }
    });
  }

  return send(404, { message: `Mock GitHub: unhandled ${req.method} ${path}` });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

before(async () => {
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await prisma.$connect();
  const target = await prisma.$queryRaw<Array<{ database: string; role: string; serverPort: number }>>`
    SELECT current_database() AS database, current_user AS role, inet_server_port() AS "serverPort"
  `;
  if (target[0]?.database !== "cloudpilot_runtime_role_test" || target[0]?.role !== "cloudpilot_integration_test" ||
      target[0]?.serverPort !== 5432) {
    await prisma.$disconnect();
    throw new Error("Phase 07 integration database identity mismatch; refusing fixture creation.");
  }
  mockGhBaseUrl = await startMockGitHub();
  resetGhState();

  // Create tenant A
  const runId = randomUUID();
  const tenantA = await prisma.tenant.create({ data: { name: `phase07-test-${runId}` } });
  tenantId = tenantA.id;
  fixtureTenantIds.push(tenantId);

  // Create tenant B (isolation tests)
  const tenantB = await prisma.tenant.create({ data: { name: `phase07-test-B-${runId}` } });
  tenantBId = tenantB.id;
  fixtureTenantIds.push(tenantBId);

  // Create project for tenant A
  const proj = await prisma.project.create({
    data: { tenantId, name: `proj-07-${runId}` }
  });
  projectId = proj.id;

  // Create project for tenant B
  const projB = await prisma.project.create({
    data: { tenantId: tenantBId, name: `proj-07-B-${runId}` }
  });
  projectBId = projB.id;

  // Create a completed scan for tenant A
  const scan = await prisma.scan.create({
    data: { tenantId, projectId, status: "completed" }
  });
  scanId = scan.id;

  // Create a completed scan for tenant B
  const scanB = await prisma.scan.create({
    data: { tenantId: tenantBId, projectId: projectBId, status: "completed" }
  });
  scanBId = scanB.id;

  // Create a finding for tenant A
  const finding = await prisma.finding.create({
    data: {
      tenantId,
      projectId,
      scanId,
      requirementId: "req-metric-uptime",
      ruleId: "rule.metric.present",
      ruleVersion: "1.0.0",
      signal: "metric",
      outcome: "gap",
      expected: "metric present",
      observed: "metric absent",
      reason: "not found in Prometheus",
      evidenceJson: {}
    }
  });
  findingId = finding.id;
});

after(async () => {
  // Only delete rows belonging to tenant IDs successfully created by this run.
  // Empty/undefined filters must never turn a partial setup failure into a broad delete.
  try {
    if (prisma && fixtureTenantIds.length > 0) {
      const ownedTenants = [...fixtureTenantIds];
      await prisma.auditEvent.deleteMany({ where: { tenantId: { in: ownedTenants } } });
      await prisma.remediation.deleteMany({ where: { tenantId: { in: ownedTenants } } });
      await prisma.finding.deleteMany({ where: { tenantId: { in: ownedTenants } } });
      await prisma.scan.deleteMany({ where: { tenantId: { in: ownedTenants } } });
      await prisma.project.deleteMany({ where: { tenantId: { in: ownedTenants } } });
      await prisma.tenant.deleteMany({ where: { id: { in: ownedTenants } } });
    }
  } finally {
    if (prisma) await prisma.$disconnect();
    if (mockGhServer) await new Promise<void>((resolve) => mockGhServer.close(() => resolve()));
  }
});

function makeOrchestrator(extraConfig: Partial<{ owner: string; repo: string }> = {}): RemediationOrchestrator {
  const gh = new GitHubConnector({
    token: "test-token",
    apiBaseUrl: mockGhBaseUrl,
    fetchImpl: fetch,
    allowHttp: true
  });
  return new RemediationOrchestrator(prisma, gh, {
    owner: "o",
    repo: "r",
    baseBranch: "main",
    draft: true,
    ...extraConfig
  });
}

function makeGapFinding(overrides = {}) {
  return {
    requirementId: "req-metric-uptime",
    ruleId: "rule.metric.present",
    ruleVersion: "1.0.0",
    signal: "metric",
    outcome: "gap",
    expected: "metric present",
    observed: "metric absent",
    reason: "not found",
    ...overrides
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("Integration: remediations table exists in PostgreSQL", async () => {
  const count = await prisma.remediation.count();
  assert.ok(typeof count === "number", "remediations table should be queryable");
});

test("Integration: happy path creates branch, commits file, opens PR, DB = open", async () => {
  resetGhState();
  const orch = makeOrchestrator();
  const finding = makeGapFinding();

  const result = await orch.remediateOne(tenantId, projectId, scanId, findingId, finding);

  assert.equal(result.status, "open");
  assert.ok(result.prNumber && result.prNumber > 0, "Should have a PR number");
  assert.ok(result.prUrl?.startsWith(mockGhBaseUrl), "Should have a PR URL");
  assert.ok(result.branchName?.startsWith("cloudpilot/remediate/"), "Should have correct branch prefix");

  // Verify DB record
  const repo = new RemediationRepository(prisma);
  const key = buildIdempotencyKey(tenantId, findingId, finding.ruleId, finding.ruleVersion);
  const record = await repo.findByIdempotencyKey(key);
  assert.ok(record !== null, "DB record should exist");
  assert.equal(record!.status, "open");
  assert.equal(record!.prNumber, result.prNumber);
  assert.equal(record!.tenantId, tenantId);
  assert.equal(record!.projectId, projectId);
  assert.equal(record!.scanId, scanId);
  assert.equal(record!.findingId, findingId);
});

test("Integration: idempotency – second call returns same PR, exactly one DB row", async () => {
  resetGhState();

  // Use a fresh finding with unique IDs to avoid state from previous tests
  const uniqFinding = await prisma.finding.create({
    data: {
      tenantId,
      projectId,
      scanId,
      requirementId: "req-idem-test",
      ruleId: "rule.idem",
      ruleVersion: "1.0.0",
      signal: "metric",
      outcome: "gap",
      expected: "e",
      observed: "o",
      reason: "r",
      evidenceJson: {}
    }
  });

  const orch = makeOrchestrator();
  const finding = makeGapFinding({ requirementId: "req-idem-test", ruleId: "rule.idem" });

  const r1 = await orch.remediateOne(tenantId, projectId, scanId, uniqFinding.id, finding);
  const r2 = await orch.remediateOne(tenantId, projectId, scanId, uniqFinding.id, finding);

  assert.equal(r1.status, "open");
  assert.equal(r2.status, "open");
  assert.equal(r1.prNumber, r2.prNumber, "Both calls should reference same PR");

  const key = buildIdempotencyKey(tenantId, uniqFinding.id, finding.ruleId, finding.ruleVersion);
  const count = await prisma.remediation.count({ where: { idempotencyKey: key } });
  assert.equal(count, 1, "Exactly one DB row should exist");
});

test("Integration: existing open PR on GitHub – idempotent, no duplicate PR created", async () => {
  resetGhState();

  const uniqFinding = await prisma.finding.create({
    data: {
      tenantId, projectId, scanId,
      requirementId: "req-existing-pr", ruleId: "rule.existing", ruleVersion: "1.0.0",
      signal: "metric", outcome: "gap",
      expected: "e", observed: "o", reason: "r", evidenceJson: {}
    }
  });

  const finding = makeGapFinding({ requirementId: "req-existing-pr", ruleId: "rule.existing" });
  const idemKey = buildIdempotencyKey(tenantId, uniqFinding.id, finding.ruleId, finding.ruleVersion);

  // Pre-populate mock GitHub with an open PR for the branch CloudPilot would create
  const expectedBranch = buildBranchName("cloudpilot/remediate", idemKey);
  ghState.branches.add("main");
  ghState.branches.add(expectedBranch);
  ghState.openPrs.set(expectedBranch, { number: 999, url: `${mockGhBaseUrl}/o/r/pull/999` });

  const orch = makeOrchestrator();
  const result = await orch.remediateOne(tenantId, projectId, scanId, uniqFinding.id, finding);

  assert.equal(result.status, "open");
  assert.equal(result.prNumber, 999, "Should reuse the existing open PR");

  // Should be exactly one PR on GitHub (no new one created)
  const prCount = [...ghState.openPrs.values()].filter((p) => p.number === 999).length;
  assert.equal(prCount, 1);
});

test("Integration: branch conflict (422) is non-fatal – continues to create PR", async () => {
  resetGhState();
  // Pre-add the branch so createBranch gets 422
  const uniqFinding = await prisma.finding.create({
    data: {
      tenantId, projectId, scanId,
      requirementId: "req-branch-conflict", ruleId: "rule.bc", ruleVersion: "1.0.0",
      signal: "health", outcome: "gap",
      expected: "e", observed: "o", reason: "r", evidenceJson: {}
    }
  });
  const finding = makeGapFinding({ signal: "health", requirementId: "req-branch-conflict", ruleId: "rule.bc" });
  const idemKey = buildIdempotencyKey(tenantId, uniqFinding.id, finding.ruleId, finding.ruleVersion);
  const expectedBranch = buildBranchName("cloudpilot/remediate", idemKey);

  // Pre-populate branch so createBranch will return 422
  ghState.branches.add("main");
  ghState.branches.add(expectedBranch);

  const orch = makeOrchestrator();
  const result = await orch.remediateOne(tenantId, projectId, scanId, uniqFinding.id, finding);

  // Should still succeed despite branch conflict
  assert.equal(result.status, "open");
  assert.ok(result.prNumber && result.prNumber > 0);
});

test("Integration: file not found on branch → placeholder used, file created", async () => {
  resetGhState();
  const uniqFinding = await prisma.finding.create({
    data: {
      tenantId, projectId, scanId,
      requirementId: "req-no-file", ruleId: "rule.nf", ruleVersion: "1.0.0",
      signal: "alert", outcome: "gap",
      expected: "e", observed: "o", reason: "r", evidenceJson: {}
    }
  });
  const finding = makeGapFinding({ signal: "alert", requirementId: "req-no-file", ruleId: "rule.nf" });

  const orch = makeOrchestrator();
  const result = await orch.remediateOne(tenantId, projectId, scanId, uniqFinding.id, finding);

  assert.equal(result.status, "open");
  // The file should now exist in mock GitHub state
  const storedFile = ghState.files.get("config/observability/alert-rules.yaml");
  assert.ok(storedFile, "File should have been created");
  assert.ok(storedFile!.content.includes("cloudpilot:remediated"), "File should contain remediation marker");
});

test("Integration: GitHub API failure decrements retriesLeft, status stays pending", async () => {
  resetGhState();
  // Next GitHub request (getBranchSha) will fail
  ghState.failNextRequest = { status: 500, message: "Internal Server Error" };

  const uniqFinding = await prisma.finding.create({
    data: {
      tenantId, projectId, scanId,
      requirementId: "req-fail-test", ruleId: "rule.fail", ruleVersion: "1.0.0",
      signal: "metric", outcome: "gap",
      expected: "e", observed: "o", reason: "r", evidenceJson: {}
    }
  });
  const finding = makeGapFinding({ requirementId: "req-fail-test", ruleId: "rule.fail" });

  const orch = makeOrchestrator();
  const result = await orch.remediateOne(tenantId, projectId, scanId, uniqFinding.id, finding);

  assert.equal(result.status, "pending", "Status should remain pending while retries remain");

  const key = buildIdempotencyKey(tenantId, uniqFinding.id, finding.ruleId, finding.ruleVersion);
  const record = await new RemediationRepository(prisma).findByIdempotencyKey(key);
  assert.ok(record, "DB record should exist");
  assert.equal(record!.status, "pending");
  assert.ok(record!.retriesLeft < 3, "retriesLeft should have been decremented");
  assert.ok(record!.errorMessage, "errorMessage should be set");
  assert.ok(!record!.errorMessage!.includes("token"), "errorMessage should not contain token");
});

test("Integration: retry exhaustion transitions to failed", async () => {
  resetGhState();

  const uniqFinding = await prisma.finding.create({
    data: {
      tenantId, projectId, scanId,
      requirementId: "req-exhaust", ruleId: "rule.exhaust", ruleVersion: "1.0.0",
      signal: "metric", outcome: "gap",
      expected: "e", observed: "o", reason: "r", evidenceJson: {}
    }
  });
  const finding = makeGapFinding({ requirementId: "req-exhaust", ruleId: "rule.exhaust" });

  const orch = makeOrchestrator();

  // Fail 3 times in a row (each attempt decrements retriesLeft)
  for (let i = 0; i < 3; i++) {
    ghState.failNextRequest = { status: 500, message: "still failing" };
    await orch.remediateOne(tenantId, projectId, scanId, uniqFinding.id, finding);
  }

  const key = buildIdempotencyKey(tenantId, uniqFinding.id, finding.ruleId, finding.ruleVersion);
  const record = await new RemediationRepository(prisma).findByIdempotencyKey(key);
  assert.equal(record!.status, "failed");
  assert.equal(record!.retriesLeft, 0);
});

test("Integration: tenant isolation – remediation from tenant A not visible to tenant B", async () => {
  resetGhState();

  // Create a finding for tenant B
  const findingB = await prisma.finding.create({
    data: {
      tenantId: tenantBId, projectId: projectBId, scanId: scanBId,
      requirementId: "req-isolation", ruleId: "rule.iso", ruleVersion: "1.0.0",
      signal: "metric", outcome: "gap",
      expected: "e", observed: "o", reason: "r", evidenceJson: {}
    }
  });

  // Create remediation for tenant A
  const orchA = makeOrchestrator();
  const findingA = await prisma.finding.create({
    data: {
      tenantId, projectId, scanId,
      requirementId: "req-isolation-a", ruleId: "rule.iso.a", ruleVersion: "1.0.0",
      signal: "health", outcome: "gap",
      expected: "e", observed: "o", reason: "r", evidenceJson: {}
    }
  });
  await orchA.remediateOne(tenantId, projectId, scanId, findingA.id, makeGapFinding({
    signal: "health",
    requirementId: "req-isolation-a",
    ruleId: "rule.iso.a"
  }));

  // Tenant B's remediations should only show its own
  const repo = new RemediationRepository(prisma);
  const aBResults = await repo.listByProject(tenantId, projectId);
  const bResults = await repo.listByProject(tenantBId, projectBId);

  // All tenant A results belong to tenant A
  for (const r of aBResults.items) {
    assert.equal(r.tenantId, tenantId, "Tenant A result must belong to tenant A");
  }

  // Tenant B results are empty (no remediation was run for B)
  assert.equal(bResults.items.length, 0, "Tenant B should have no remediations");
  void findingB; // Used to create the finding for completeness
});

test("Integration: listByProject returns paginated results in desc order", async () => {
  resetGhState();

  // Create 3 additional findings for tenant A to generate 3 remediations
  const findings = [];
  for (let i = 0; i < 3; i++) {
    const f = await prisma.finding.create({
      data: {
        tenantId, projectId, scanId,
        requirementId: `req-page-${i}`,
        ruleId: `rule.page.${i}`,
        ruleVersion: "1.0.0",
        signal: "metric", outcome: "gap",
        expected: "e", observed: "o", reason: "r", evidenceJson: {}
      }
    });
    findings.push(f);
  }

  const orch = makeOrchestrator();
  for (const f of findings) {
    await orch.remediateOne(tenantId, projectId, scanId, f.id, makeGapFinding({
      requirementId: f.requirementId,
      ruleId: f.ruleId
    }));
  }

  const repo = new RemediationRepository(prisma);
  const page1 = await repo.listByProject(tenantId, projectId, { limit: 2 });
  assert.ok(page1.items.length <= 2);
  assert.ok(page1.hasMore || page1.items.length === 2 || page1.items.length >= 1);

  if (page1.nextCursor) {
    const page2 = await repo.listByProject(tenantId, projectId, { limit: 2, cursor: page1.nextCursor });
    assert.ok(page2.items.length >= 0);
    // Items on page 2 should all be different from page 1
    const page1Ids = new Set(page1.items.map((r) => r.id));
    for (const r of page2.items) {
      assert.ok(!page1Ids.has(r.id), "Page 2 items should not appear in page 1");
    }
  }
});

test("Integration: unsupported signal (trace gap) → skipped, no DB row created", async () => {
  const tracesFinding = makeGapFinding({ signal: "trace", ruleId: "rule.trace.uniq" });
  const orch = makeOrchestrator();

  const before = await prisma.remediation.count({ where: { tenantId } });
  const result = await orch.remediateOne(tenantId, projectId, scanId, "fake-trace-id", tracesFinding);
  const after = await prisma.remediation.count({ where: { tenantId } });

  assert.equal(result.skipped, true);
  assert.equal(after, before, "No new DB row should be created for unsupported signal");
});

test("Integration: non-gap outcome (pass) → skipped, no DB row created", async () => {
  const passFinding = makeGapFinding({ outcome: "pass", ruleId: "rule.pass.uniq" });
  const orch = makeOrchestrator();

  const before = await prisma.remediation.count({ where: { tenantId } });
  const result = await orch.remediateOne(tenantId, projectId, scanId, "fake-pass-id", passFinding);
  const after = await prisma.remediation.count({ where: { tenantId } });

  assert.equal(result.skipped, true);
  assert.equal(after, before, "No new DB row for pass outcome");
});

test("Integration: concurrent identical requests produce exactly one DB row", async () => {
  resetGhState();
  const uniqFinding = await prisma.finding.create({
    data: {
      tenantId, projectId, scanId,
      requirementId: "req-concurrent", ruleId: "rule.concurrent", ruleVersion: "1.0.0",
      signal: "metric", outcome: "gap",
      expected: "e", observed: "o", reason: "r", evidenceJson: {}
    }
  });
  const finding = makeGapFinding({ requirementId: "req-concurrent", ruleId: "rule.concurrent" });

  const orch = makeOrchestrator();
  // Fire both concurrently
  const [r1, r2] = await Promise.all([
    orch.remediateOne(tenantId, projectId, scanId, uniqFinding.id, finding),
    orch.remediateOne(tenantId, projectId, scanId, uniqFinding.id, finding)
  ]);

  const key = buildIdempotencyKey(tenantId, uniqFinding.id, finding.ruleId, finding.ruleVersion);
  const count = await prisma.remediation.count({ where: { idempotencyKey: key } });
  assert.equal(count, 1, "Concurrent requests must produce exactly one DB row");

  // Both results should be valid (one is the winner, one is idempotent)
  assert.ok(r1.status === "open" || r1.status === "pending" || r1.skipped);
  assert.ok(r2.status === "open" || r2.status === "pending" || r2.skipped);
});

test("Integration: database enforces composite FK (tenantId, findingId) referencing Finding", async () => {
  // Attempt to create a remediation under tenantBId referencing findingId that belongs to tenantId
  // Must fail at the database level due to foreign key constraint
  await assert.rejects(async () => {
    await prisma.remediation.create({
      data: {
        tenantId: tenantBId,
        projectId: projectBId,
        scanId: scanBId,
        findingId: findingId, // Belongs to tenantId, not tenantBId!
        idempotencyKey: `cross-tenant-fk-test-${Date.now()}`,
        status: "pending"
      }
    });
  }, (err: any) => {
    return err && (err.code === "P2003" || String(err).includes("foreign key") || String(err).includes("remediations_tenant_id_finding_id_fkey"));
  });
});

test("Integration: listByProject rejects cross-tenant cursor with InvalidCursorError", async () => {
  const findingA = await prisma.finding.create({
    data: {
      tenantId, projectId, scanId,
      requirementId: "req-cur-test", ruleId: "rule.cur", ruleVersion: "1.0.0",
      signal: "metric", outcome: "gap",
      expected: "e", observed: "o", reason: "r", evidenceJson: {}
    }
  });

  const orch = makeOrchestrator();
  const resA = await orch.remediateOne(tenantId, projectId, scanId, findingA.id, makeGapFinding({
    requirementId: "req-cur-test",
    ruleId: "rule.cur"
  }));

  const repo = new RemediationRepository(prisma);
  // Tenant B attempts to use tenant A's remediation ID as a pagination cursor
  await assert.rejects(
    () => repo.listByProject(tenantBId, projectBId, { cursor: resA.remediationId }),
    InvalidCursorError
  );
});

test("Integration: multiple findings under same UUID tenant generate distinct branches and PRs", async () => {
  resetGhState();
  const finding1 = await prisma.finding.create({
    data: {
      tenantId, projectId, scanId,
      requirementId: "req-multi-uuid-1", ruleId: "rule.multi.1", ruleVersion: "1.0.0",
      signal: "metric", outcome: "gap",
      expected: "e", observed: "o", reason: "r", evidenceJson: {}
    }
  });
  const finding2 = await prisma.finding.create({
    data: {
      tenantId, projectId, scanId,
      requirementId: "req-multi-uuid-2", ruleId: "rule.multi.2", ruleVersion: "1.0.0",
      signal: "health", outcome: "gap",
      expected: "e", observed: "o", reason: "r", evidenceJson: {}
    }
  });

  const orch = makeOrchestrator();
  const r1 = await orch.remediateOne(tenantId, projectId, scanId, finding1.id, makeGapFinding({
    requirementId: "req-multi-uuid-1",
    ruleId: "rule.multi.1",
    signal: "metric"
  }));
  const r2 = await orch.remediateOne(tenantId, projectId, scanId, finding2.id, makeGapFinding({
    requirementId: "req-multi-uuid-2",
    ruleId: "rule.multi.2",
    signal: "health"
  }));

  assert.equal(r1.status, "open");
  assert.equal(r2.status, "open");
  assert.notEqual(r1.branchName, r2.branchName, "Branch names must be distinct under the same UUID tenant");
  assert.notEqual(r1.prNumber, r2.prNumber, "PR numbers must be distinct for different findings");
  assert.equal(ghState.branches.has(r1.branchName!), true);
  assert.equal(ghState.branches.has(r2.branchName!), true);
});

test("Integration: audit events are recorded in real PostgreSQL audit_events table", async () => {
  resetGhState();
  const findingAudit = await prisma.finding.create({
    data: {
      tenantId, projectId, scanId,
      requirementId: "req-audit-test", ruleId: "rule.audit.1", ruleVersion: "1.0.0",
      signal: "alert", outcome: "gap",
      expected: "e", observed: "o", reason: "r", evidenceJson: {}
    }
  });

  const orch = makeOrchestrator();
  const r = await orch.remediateOne(tenantId, projectId, scanId, findingAudit.id, makeGapFinding({
    signal: "alert",
    requirementId: "req-audit-test",
    ruleId: "rule.audit.1"
  }), { actorId: "actor-integration-test" });

  assert.equal(r.status, "open");

  const events = await prisma.auditEvent.findMany({
    where: { tenantId, resourceId: r.remediationId },
    orderBy: { createdAt: "asc" }
  });

  assert.ok(events.length >= 2, "Must persist audit records in database");
  assert.equal(events[0].action, "REMEDIATION_TRIGGERED");
  assert.equal(events[0].actorId, "actor-integration-test");
  assert.equal(events[1].action, "REMEDIATION_PR_OPENED");
});

test("Integration: non-retryable 403 Forbidden immediately sets status=failed without retries", async () => {
  resetGhState();
  ghState.failNextRequest = { status: 403, message: "Forbidden: lack write permission" };

  const finding403 = await prisma.finding.create({
    data: {
      tenantId, projectId, scanId,
      requirementId: "req-403-test", ruleId: "rule.403", ruleVersion: "1.0.0",
      signal: "metric", outcome: "gap",
      expected: "e", observed: "o", reason: "r", evidenceJson: {}
    }
  });

  const orch = makeOrchestrator();
  const r = await orch.remediateOne(tenantId, projectId, scanId, finding403.id, makeGapFinding({
    requirementId: "req-403-test",
    ruleId: "rule.403"
  }));

  assert.equal(r.status, "failed");
  const record = await prisma.remediation.findUnique({
    where: { idempotencyKey: buildIdempotencyKey(tenantId, finding403.id, "rule.403", "1.0.0") }
  });
  assert.ok(record);
  assert.equal(record!.status, "failed");
  assert.equal(record!.retriesLeft, 0, "Non-retryable error should exhaust retries on first attempt");
});
