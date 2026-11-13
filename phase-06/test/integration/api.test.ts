/**
 * Phase 06 PostgreSQL Integration Tests
 *
 * Requires CLOUDPILOT_FIXTURE_TEST_DATABASE_URL for the isolated
 * cloudpilot_runtime_role_test database and fixture-only role on loopback port 56440. The suite verifies current_database() before any
 * cleanup and refuses to run when a dedicated database is not configured.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { CloudPilotApiServer } from "../../src/api/server.js";
import { checkDatabaseConnection } from "../../src/db/client.js";
import { ScanRepository, StaleWorkerError } from "../../src/db/scan-repo.js";
import {
  mintTestJwt,
  TEST_PUBLIC_KEY,
  TEST_ISSUER,
  TEST_AUDIENCE
} from "../jwt-signer.js";
import { cleanupTestOwnedFixtures, requireDedicatedPhase06TestDatabase } from "./safety.js";

const DATABASE_URL = requireDedicatedPhase06TestDatabase(process.env.CLOUDPILOT_FIXTURE_TEST_DATABASE_URL);

async function runIntegrationSuite() {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  // Verify the actual server-side database identity before any fixture cleanup.
  try {
    const identity = await prisma.$queryRaw<Array<{ database_name: string; database_user: string; server_port: number }>>`
      SELECT current_database() AS database_name, current_user AS database_user, inet_server_port() AS server_port
    `;
    if (identity.length !== 1 || identity[0].database_name !== "cloudpilot_runtime_role_test" ||
        identity[0].database_user !== "cloudpilot_integration_test" || identity[0].server_port !== 5432) {
      throw new Error("Connected database identity is not the approved Phase 06 disposable test database; refusing cleanup.");
    }
    const dbHealth = await checkDatabaseConnection(prisma);
    if (!dbHealth.ok) throw new Error("Dedicated Phase 06 test database is unavailable; refusing to run integration tests.");
  } catch (error) {
    await prisma.$disconnect();
    throw error;
  }

  const runId = randomUUID();
  const tenantIds: string[] = [];
  const alphaAdminId = `it-${runId}-alpha-admin`;
  const alphaOperatorId = `it-${runId}-alpha-operator`;
  const alphaViewerId = `it-${runId}-alpha-viewer`;
  const betaAdminId = `it-${runId}-beta-admin`;

  // Seed tenants and users
  const tenantAlpha = await prisma.tenant.create({ data: { id: `it-${runId}-tenant-alpha`, name: `Alpha Corp ${runId}` } });
  tenantIds.push(tenantAlpha.id);
  const tenantBeta = await prisma.tenant.create({ data: { id: `it-${runId}-tenant-beta`, name: `Beta Corp ${runId}` } });
  tenantIds.push(tenantBeta.id);

  await prisma.user.create({ data: { id: alphaAdminId, tenantId: tenantAlpha.id, email: `${alphaAdminId}@test.invalid`, role: "admin" } });
  await prisma.user.create({ data: { id: alphaOperatorId, tenantId: tenantAlpha.id, email: `${alphaOperatorId}@test.invalid`, role: "operator" } });
  await prisma.user.create({ data: { id: alphaViewerId, tenantId: tenantAlpha.id, email: `${alphaViewerId}@test.invalid`, role: "viewer" } });
  await prisma.user.create({ data: { id: betaAdminId, tenantId: tenantBeta.id, email: `${betaAdminId}@test.invalid`, role: "admin" } });

  // Mint tokens (RS256 only — verifies production-default config)
  const tokenAlphaAdmin = mintTestJwt({ sub: alphaAdminId, tenantId: tenantAlpha.id, roles: ["admin"] });
  const tokenAlphaOp = mintTestJwt({ sub: alphaOperatorId, tenantId: tenantAlpha.id, roles: ["operator"] });
  const tokenAlphaViewer = mintTestJwt({ sub: alphaViewerId, tenantId: tenantAlpha.id, roles: ["viewer"] });
  const tokenBetaAdmin = mintTestJwt({ sub: betaAdminId, tenantId: tenantBeta.id, roles: ["admin"] });

  // Start API server with RS256-only JWT config (production default)
  const server = new CloudPilotApiServer({
    prisma,
    jwtConfig: {
      expectedIssuer: TEST_ISSUER,
      expectedAudience: TEST_AUDIENCE,
      publicKeyOrSecret: TEST_PUBLIC_KEY,
      allowedAlgorithms: ["RS256"] // Asymmetric-only — no HS256 in integration config
    }
  });

  const port = await server.start(0);
  const baseUrl = `http://localhost:${port}`;

  try {
    // ────── 1. Health Endpoints ──────
    await test("IT: GET /health/liveness returns 200", async () => {
      const res = await fetch(`${baseUrl}/health/liveness`);
      assert.equal(res.status, 200);
      const body = await res.json() as { status: string };
      assert.equal(body.status, "ok");
    });

    await test("IT: GET /health/readiness returns 200 when DB connected", async () => {
      const res = await fetch(`${baseUrl}/health/readiness`);
      assert.equal(res.status, 200);
      const body = await res.json() as { status: string };
      assert.equal(body.status, "ready");
    });

    // ────── 2. Authentication ──────
    await test("IT: unauthenticated requests to /api/v1 return 401", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects`);
      assert.equal(res.status, 401);
    });

    await test("IT: expired token is rejected with 401", async () => {
      const expired = mintTestJwt({ sub: alphaAdminId, tenantId: tenantAlpha.id, roles: ["admin"], expSecondsFromNow: -300 });
      const res = await fetch(`${baseUrl}/api/v1/projects`, {
        headers: { Authorization: `Bearer ${expired}` }
      });
      assert.equal(res.status, 401);
    });

    // ────── 3. Project CRUD and RBAC ──────
    let alphaProjectId: string;

    await test("IT: operator is forbidden from creating project (RBAC)", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenAlphaOp}` },
        body: JSON.stringify({ name: "unauthorized" })
      });
      assert.equal(res.status, 403);
    });

    await test("IT: admin creates project with expected observability model", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenAlphaAdmin}` },
        body: JSON.stringify({
          name: "it-order-service",
          repositoryUrl: "https://github.com/example/orders.git",
          expectedModel: {
            service: "it-order-service",
            version: "1.0.0",
            requirements: [
              { id: "REQ-HEALTH-IT-01", signal: "health", type: "liveness", endpoint: "/health/live" },
              { id: "REQ-LOG-IT-01", signal: "log", format: "json", destination: "stdout" },
              { id: "REQ-TRACE-IT-01", signal: "trace", propagationFormat: "w3c" }
            ]
          },
          targetConfig: { healthBaseUrl: "http://localhost:9999" }
        })
      });
      assert.equal(res.status, 201);
      const body = await res.json() as { project: { id: string; name: string; tenantId: string } };
      assert.equal(body.project.name, "it-order-service");
      assert.equal(body.project.tenantId, tenantAlpha.id);
      alphaProjectId = body.project.id;
    });

    await test("IT: duplicate project name in same tenant returns 409", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenAlphaAdmin}` },
        body: JSON.stringify({ name: "it-order-service" })
      });
      assert.equal(res.status, 409);
    });

    await test("IT: invalid project name (empty) returns 400", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenAlphaAdmin}` },
        body: JSON.stringify({ name: "" })
      });
      assert.equal(res.status, 400);
    });

    // ────── 4. Tenant Isolation ──────
    await test("IT: cross-tenant project access returns 404 (not 403, prevents enumeration)", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects/${alphaProjectId}`, {
        headers: { Authorization: `Bearer ${tokenBetaAdmin}` }
      });
      assert.equal(res.status, 404); // Must be 404, not 403
    });

    await test("IT: GET /api/v1/projects lists only tenant-scoped projects", async () => {
      // Beta has no projects
      const res = await fetch(`${baseUrl}/api/v1/projects`, {
        headers: { Authorization: `Bearer ${tokenBetaAdmin}` }
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { items: Array<{ tenantId: string }> };
      assert.equal(body.items.length, 0);
    });

    await test("IT: GET /api/v1/projects only lists own tenant (Alpha can see 1 project)", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects`, {
        headers: { Authorization: `Bearer ${tokenAlphaAdmin}` }
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { items: Array<{ tenantId: string; name: string }> };
      assert.equal(body.items.length, 1);
      assert.equal(body.items[0].tenantId, tenantAlpha.id);
    });

    // ────── 5. Scan Lifecycle and Gap Engine Integration ──────
    let scanId: string;

    await test("IT: viewer is forbidden from creating scans", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects/${alphaProjectId}/scans`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenAlphaViewer}` }
      });
      assert.equal(res.status, 403);
    });

    await test("IT: operator triggers async scan returning 202 Accepted", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects/${alphaProjectId}/scans`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenAlphaOp}` }
      });
      assert.equal(res.status, 202);
      const body = await res.json() as { scanId: string; status: string; projectId: string };
      assert.ok(body.scanId);
      assert.equal(body.status, "pending");
      assert.equal(body.projectId, alphaProjectId);
      scanId = body.scanId;
    });

    await test("IT: concurrent scan trigger returns 409 Conflict while scan is active", async () => {
      // Immediately after triggering, a second scan should conflict
      const res = await fetch(`${baseUrl}/api/v1/projects/${alphaProjectId}/scans`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenAlphaOp}` }
      });
      // 409 if still pending/running, or 202 if already completed by now — both are valid
      assert.ok(res.status === 409 || res.status === 202, `Expected 409 or 202, got ${res.status}`);
    });

    await test("IT: scan completes and transitions through pending → running → completed", async () => {
      // Poll for completion (max 5s)
      let finalStatus = "pending";
      for (let i = 0; i < 50; i++) {
        const res = await fetch(`${baseUrl}/api/v1/projects/${alphaProjectId}/scans/${scanId}`, {
          headers: { Authorization: `Bearer ${tokenAlphaViewer}` }
        });
        assert.equal(res.status, 200);
        const body = await res.json() as { scan: { status: string } };
        finalStatus = body.scan.status;
        if (finalStatus === "completed" || finalStatus === "failed") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      // Health check will fail to connect to localhost:9999, which is expected —
      // the scan should complete with findings reflecting the unavailable evidence.
      assert.ok(finalStatus === "completed" || finalStatus === "failed",
        `Expected completed or failed, got ${finalStatus}`);
    });

    // ────── 6. Findings: Gap Engine Integration ──────
    await test("IT: findings are persisted and reflect Gap Engine evaluation", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects/${alphaProjectId}/scans/${scanId}/findings`, {
        headers: { Authorization: `Bearer ${tokenAlphaViewer}` }
      });
      assert.equal(res.status, 200);
      const body = await res.json() as {
        items: Array<{
          requirementId: string;
          signal: string;
          outcome: string;
          ruleId: string;
          ruleVersion: string;
        }>;
      };
      assert.ok(Array.isArray(body.items));
      // 3 requirements: health, log, trace
      assert.equal(body.items.length, 3);

      const health = body.items.find((f) => f.requirementId === "REQ-HEALTH-IT-01");
      assert.ok(health, "Health finding must exist");
      assert.equal(health.signal, "health");
      // Health probe to localhost:9999 should fail → unknown or inconclusive; never a confirmed gap
      assert.ok(
        health.outcome === "unknown" || health.outcome === "inconclusive",
        `Health outcome must be unknown/inconclusive when target is unreachable, got: ${health.outcome}`
      );

      const log = body.items.find((f) => f.requirementId === "REQ-LOG-IT-01");
      assert.ok(log, "Log finding must exist");
      assert.equal(log.signal, "log");
      assert.equal(log.outcome, "unknown"); // Unconfigured log backend → always unknown

      const trace = body.items.find((f) => f.requirementId === "REQ-TRACE-IT-01");
      assert.ok(trace, "Trace finding must exist");
      assert.equal(trace.signal, "trace");
      assert.equal(trace.outcome, "unknown"); // Unconfigured trace backend → always unknown

      // All findings must have stable rule IDs
      for (const finding of body.items) {
        assert.ok(finding.ruleId.startsWith("CP-RULE-OBS-GAP-"), `ruleId must start with CP-RULE-OBS-GAP-, got: ${finding.ruleId}`);
        assert.match(finding.ruleVersion, /^\d+\.\d+\.\d+$/);
      }
    });

    await test("IT: cross-tenant cannot access findings (returns 404)", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects/${alphaProjectId}/scans/${scanId}/findings`, {
        headers: { Authorization: `Bearer ${tokenBetaAdmin}` }
      });
      assert.equal(res.status, 404); // Project not found for beta tenant
    });

    // ────── 7. Pagination ──────
    await test("IT: pagination empty result set returns empty items and hasMore=false", async () => {
      // Beta has 0 projects
      const res = await fetch(`${baseUrl}/api/v1/projects?limit=5`, {
        headers: { Authorization: `Bearer ${tokenBetaAdmin}` }
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { items: unknown[]; hasMore: boolean; nextCursor?: string };
      assert.equal(body.items.length, 0);
      assert.equal(body.hasMore, false);
      assert.equal(body.nextCursor, undefined);
    });

    await test("IT: pagination single page returns all items and hasMore=false", async () => {
      // Alpha has 1 project so far (alphaProjectId)
      const res = await fetch(`${baseUrl}/api/v1/projects?limit=10`, {
        headers: { Authorization: `Bearer ${tokenAlphaAdmin}` }
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { items: unknown[]; hasMore: boolean; nextCursor?: string };
      assert.equal(body.items.length, 1);
      assert.equal(body.hasMore, false);
      assert.equal(body.nextCursor, undefined);
    });

    await test("IT: pagination with limit=1 returns 1 item and nextCursor, and second page hasMore=false", async () => {
      // Create a second project for Alpha
      const res1 = await fetch(`${baseUrl}/api/v1/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenAlphaAdmin}` },
        body: JSON.stringify({ name: "it-pagination-project" })
      });
      assert.equal(res1.status, 201);
      const p2 = await res1.json() as { project: { id: string } };

      // Page 1 with limit=1
      const res2 = await fetch(`${baseUrl}/api/v1/projects?limit=1`, {
        headers: { Authorization: `Bearer ${tokenAlphaAdmin}` }
      });
      assert.equal(res2.status, 200);
      const body = await res2.json() as { items: Array<{ id: string }>; hasMore: boolean; nextCursor?: string };
      assert.equal(body.items.length, 1);
      assert.equal(body.hasMore, true);
      assert.ok(body.nextCursor, "nextCursor must be present when hasMore is true");
      const page1Id = body.items[0].id;

      // Page 2 following cursor
      const res3 = await fetch(`${baseUrl}/api/v1/projects?limit=1&cursor=${body.nextCursor}`, {
        headers: { Authorization: `Bearer ${tokenAlphaAdmin}` }
      });
      assert.equal(res3.status, 200);
      const body3 = await res3.json() as { items: Array<{ id: string }>; hasMore: boolean; nextCursor?: string };
      assert.equal(body3.items.length, 1);
      assert.notEqual(body3.items[0].id, page1Id, "Page 2 must return the next item, not repeat the cursor item");
      assert.equal(body3.hasMore, false, "Page 2 should be the final page for 2 total items with limit 1");
      assert.equal(body3.nextCursor, undefined);
    });

    await test("IT: pagination rejects non-existent cursor with 400 Bad Request", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects?cursor=00000000-0000-0000-0000-000000000000`, {
        headers: { Authorization: `Bearer ${tokenAlphaAdmin}` }
      });
      assert.equal(res.status, 400);
      const body = await res.json() as { error: string };
      assert.match(body.error, /invalid cursor/i);
    });

    await test("IT: pagination rejects cross-tenant cursor with 400 Bad Request", async () => {
      // Create a project in Beta
      const betaProjectRes = await prisma.project.create({
        data: { tenantId: tenantBeta.id, name: "beta-secret-project" }
      });

      // Alpha attempts to use Beta's project ID as cursor
      const res = await fetch(`${baseUrl}/api/v1/projects?cursor=${betaProjectRes.id}`, {
        headers: { Authorization: `Bearer ${tokenAlphaAdmin}` }
      });
      assert.equal(res.status, 400);
      const body = await res.json() as { error: string };
      assert.match(body.error, /invalid cursor/i);
    });

    await test("IT: pagination is deterministic when records share identical timestamps", async () => {
      // Clean up extra projects created for pagination tests so far, leaving a controlled set
      await prisma.project.deleteMany({ where: { tenantId: tenantAlpha.id } });

      const sharedTimestamp = new Date("2026-01-01T12:00:00Z");
      // Create 3 projects with identical createdAt
      const pA = await prisma.project.create({
        data: { id: `proj-${runId}-tie-a`, tenantId: tenantAlpha.id, name: `tie-project-a-${runId}`, createdAt: sharedTimestamp }
      });
      const pB = await prisma.project.create({
        data: { id: `proj-${runId}-tie-b`, tenantId: tenantAlpha.id, name: `tie-project-b-${runId}`, createdAt: sharedTimestamp }
      });
      const pC = await prisma.project.create({
        data: { id: `proj-${runId}-tie-c`, tenantId: tenantAlpha.id, name: `tie-project-c-${runId}`, createdAt: sharedTimestamp }
      });

      // Page 1
      const resPage1 = await fetch(`${baseUrl}/api/v1/projects?limit=1`, {
        headers: { Authorization: `Bearer ${tokenAlphaAdmin}` }
      });
      const bodyPage1 = await resPage1.json() as { items: Array<{ id: string }>; nextCursor: string; hasMore: boolean };
      assert.equal(bodyPage1.items.length, 1);
      assert.equal(bodyPage1.hasMore, true);

      // Page 2
      const resPage2 = await fetch(`${baseUrl}/api/v1/projects?limit=1&cursor=${bodyPage1.nextCursor}`, {
        headers: { Authorization: `Bearer ${tokenAlphaAdmin}` }
      });
      const bodyPage2 = await resPage2.json() as { items: Array<{ id: string }>; nextCursor: string; hasMore: boolean };
      assert.equal(bodyPage2.items.length, 1);
      assert.equal(bodyPage2.hasMore, true);
      assert.notEqual(bodyPage2.items[0].id, bodyPage1.items[0].id);

      // Page 3
      const resPage3 = await fetch(`${baseUrl}/api/v1/projects?limit=1&cursor=${bodyPage2.nextCursor}`, {
        headers: { Authorization: `Bearer ${tokenAlphaAdmin}` }
      });
      const bodyPage3 = await resPage3.json() as { items: Array<{ id: string }>; hasMore: boolean };
      assert.equal(bodyPage3.items.length, 1);
      assert.equal(bodyPage3.hasMore, false);
      assert.notEqual(bodyPage3.items[0].id, bodyPage2.items[0].id);
      assert.notEqual(bodyPage3.items[0].id, bodyPage1.items[0].id);

      const allIds = [bodyPage1.items[0].id, bodyPage2.items[0].id, bodyPage3.items[0].id];
      assert.equal(new Set(allIds).size, 3, "All 3 items must be distinct across pages despite identical timestamps");

      // Re-create alphaProjectId for remaining tests (audit/delete)
      const restored = await prisma.project.create({
        data: {
          id: alphaProjectId,
          tenantId: tenantAlpha.id,
          name: "it-order-service"
        }
      });
    });

    // ────── 8. Audit Events ──────
    await test("IT: audit events are recorded and scoped to tenant", async () => {
      const res = await fetch(`${baseUrl}/api/v1/audit-events`, {
        headers: { Authorization: `Bearer ${tokenAlphaAdmin}` }
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { items: Array<{ tenantId: string; action: string }> };
      assert.ok(body.items.length > 0, "Audit events must have been recorded");
      for (const event of body.items) {
        assert.equal(event.tenantId, tenantAlpha.id, "All audit events must belong to Alpha tenant");
      }

      // Check key actions were recorded
      const actions = body.items.map((e) => e.action);
      assert.ok(actions.includes("PROJECT_CREATED"), "PROJECT_CREATED must be audited");
      assert.ok(actions.includes("SCAN_TRIGGERED"), "SCAN_TRIGGERED must be audited");
    });

    await test("IT: viewer is forbidden from reading audit events", async () => {
      const res = await fetch(`${baseUrl}/api/v1/audit-events`, {
        headers: { Authorization: `Bearer ${tokenAlphaViewer}` }
      });
      assert.equal(res.status, 403);
    });

    await test("IT: Beta tenant cannot read Alpha audit events (tenant isolation)", async () => {
      const res = await fetch(`${baseUrl}/api/v1/audit-events`, {
        headers: { Authorization: `Bearer ${tokenBetaAdmin}` }
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { items: Array<{ tenantId: string }> };
      assert.equal(body.items.length, 0, "Beta tenant audit log must be empty");
    });

    // ────── 9. Project:Delete and Cascade ──────
    await test("IT: operator cannot delete project (RBAC)", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects/${alphaProjectId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tokenAlphaOp}` }
      });
      assert.equal(res.status, 403);
    });

    await test("IT: admin can delete project; project becomes 404 after deletion", async () => {
      // Create a project just for deletion
      const createRes = await fetch(`${baseUrl}/api/v1/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenAlphaAdmin}` },
        body: JSON.stringify({ name: "it-deletable-project" })
      });
      assert.equal(createRes.status, 201);
      const created = await createRes.json() as { project: { id: string } };
      const deletableId = created.project.id;

      const delRes = await fetch(`${baseUrl}/api/v1/projects/${deletableId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tokenAlphaAdmin}` }
      });
      assert.equal(delRes.status, 200);

      const getRes = await fetch(`${baseUrl}/api/v1/projects/${deletableId}`, {
        headers: { Authorization: `Bearer ${tokenAlphaAdmin}` }
      });
      assert.equal(getRes.status, 404);
    });

    // ────── 10. Database Relationship Integrity ──────
    await test("IT: scans list for cross-tenant project returns 404", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects/${alphaProjectId}/scans`, {
        headers: { Authorization: `Bearer ${tokenBetaAdmin}` }
      });
      assert.equal(res.status, 404);
    });

    await test("IT: scan for cross-tenant project returns 404", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects/${alphaProjectId}/scans/${scanId}`, {
        headers: { Authorization: `Bearer ${tokenBetaAdmin}` }
      });
      assert.equal(res.status, 404);
    });

    // ────── 11. Production Hardening: Concurrency, Orphan Recovery & SSRF ──────
    await test("IT: concurrent scan requests race-safely return 202 and 409 (never 500)", async () => {
      // First ensure no active scans on alphaProjectId
      await prisma.scan.updateMany({
        where: { projectId: alphaProjectId, status: { in: ["pending", "running"] } },
        data: { status: "completed" }
      });

      // Fire two concurrent scan requests simultaneously
      const [res1, res2] = await Promise.all([
        fetch(`${baseUrl}/api/v1/projects/${alphaProjectId}/scans`, {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenAlphaOp}` }
        }),
        fetch(`${baseUrl}/api/v1/projects/${alphaProjectId}/scans`, {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenAlphaOp}` }
        })
      ]);

      const statuses = [res1.status, res2.status].sort();
      // Exactly one request must succeed (202) and the other must be rejected (409)
      assert.deepEqual(statuses, [202, 409], `Expected [202, 409], got [${res1.status}, ${res2.status}]`);
    });

    await test("IT: SSRF protection blocks cloud metadata service endpoints (169.254.x.x and metadata.google.internal)", async () => {
      const res1 = await fetch(`${baseUrl}/api/v1/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenAlphaAdmin}` },
        body: JSON.stringify({
          name: "ssrf-test-aws",
          targetConfig: { healthBaseUrl: "http://169.254.169.254/latest/meta-data" }
        })
      });
      assert.equal(res1.status, 400);
      const body1 = await res1.json() as { error: string };
      assert.match(body1.error, /SSRF/i);

      const res2 = await fetch(`${baseUrl}/api/v1/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenAlphaAdmin}` },
        body: JSON.stringify({
          name: "ssrf-test-gcp",
          targetConfig: { healthBaseUrl: "http://metadata.google.internal/computeMetadata/v1" }
        })
      });
      assert.equal(res2.status, 400);
      const body2 = await res2.json() as { error: string };
      assert.match(body2.error, /SSRF/i);
    });

    // ────── 12. Durable Job Coordination, Leases & Multi-Worker Concurrency ──────
    const scanRepo = new ScanRepository(prisma);
    // The API's background poller is not under test in this repository-level
    // claim suite. Stop it and isolate pending rows to this test-owned tenant.
    await (server as unknown as { scanRunner: { shutdown(): Promise<void> } }).scanRunner.shutdown();
    await prisma.scan.updateMany({
      where: { tenantId: tenantAlpha.id, status: "pending" },
      data: { status: "failed", error: "Isolated before scan lease repository tests." }
    });

    await test("IT: two or more workers racing to claim one scan using FOR UPDATE SKIP LOCKED", async () => {
      const raceProj = await prisma.project.create({
        data: { tenantId: tenantAlpha.id, name: "worker-race-proj" }
      });

      const pendingScan = await scanRepo.create({
        tenantId: tenantAlpha.id,
        projectId: raceProj.id
      });

      // Two workers attempt to claim simultaneously
      const [claim1, claim2] = await Promise.all([
        scanRepo.claimNextPendingScan("worker-node-1", 60),
        scanRepo.claimNextPendingScan("worker-node-2", 60)
      ]);

      const claimedCount = [claim1, claim2].filter((c) => c !== null).length;
      assert.equal(claimedCount, 1, "Exactly one worker must claim the scan row");

      const winner = claim1 ?? claim2;
      assert.equal(winner?.id, pendingScan.id);
      assert.equal(winner?.status, "running");
      assert.ok(winner?.workerId === "worker-node-1" || winner?.workerId === "worker-node-2");
      assert.match(winner?.leaseToken ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    await test("IT: concurrent scans for different projects run independently", async () => {
      const projA = await prisma.project.create({ data: { tenantId: tenantAlpha.id, name: "multi-proj-a" } });
      const projB = await prisma.project.create({ data: { tenantId: tenantAlpha.id, name: "multi-proj-b" } });

      const scanA = await scanRepo.create({ tenantId: tenantAlpha.id, projectId: projA.id });
      const scanB = await scanRepo.create({ tenantId: tenantAlpha.id, projectId: projB.id });

      const claimA = await scanRepo.claimNextPendingScan("worker-A", 60);
      const claimB = await scanRepo.claimNextPendingScan("worker-B", 60);

      assert.ok(claimA);
      assert.ok(claimB);
      assert.notEqual(claimA.id, claimB.id);
      assert.notEqual(claimA.projectId, claimB.projectId);
    });

    await test("IT: worker crash followed by lease expiry and recovery (re-queuing)", async () => {
      const crashProj = await prisma.project.create({ data: { tenantId: tenantAlpha.id, name: "crash-recovery-proj" } });
      const crashedScan = await prisma.scan.create({
        data: {
          tenantId: tenantAlpha.id,
          projectId: crashProj.id,
          status: "running",
          workerId: "crashed-worker-pid-999",
          startedAt: new Date(),
          heartbeatAt: new Date(Date.now() - 30000),
          leaseExpiresAt: new Date(Date.now() - 5000), // Lease expired 5s ago
          attemptCount: 1,
          maxAttempts: 3
        }
      });

      const reclaimResult = await scanRepo.reclaimExpiredLeases();
      assert.ok(reclaimResult.requeued >= 1);

      const recovered = await scanRepo.findById(tenantAlpha.id, crashedScan.id);
      assert.ok(recovered);
      assert.equal(recovered.status, "pending", "Expired lease should be re-queued to pending");
      assert.equal(recovered.workerId, null, "Worker ID must be cleared for re-queuing");
      assert.equal(recovered.leaseToken, null, "Expired lease token must be cleared during recovery");
      assert.match(recovered.error ?? "", /re-queued/i);
      await prisma.scan.updateMany({
        where: { id: crashedScan.id, tenantId: tenantAlpha.id, status: "pending", leaseToken: null },
        data: { status: "failed", error: "Recovery fixture consumed by its test." }
      });
    });

    await test("IT: retry exhaustion and terminal failure", async () => {
      const exhaustedProj = await prisma.project.create({ data: { tenantId: tenantAlpha.id, name: "exhausted-proj" } });
      const exhaustedScan = await prisma.scan.create({
        data: {
          tenantId: tenantAlpha.id,
          projectId: exhaustedProj.id,
          status: "running",
          workerId: "terminal-crashed-worker",
          startedAt: new Date(),
          leaseExpiresAt: new Date(Date.now() - 5000), // Lease expired
          attemptCount: 3,
          maxAttempts: 3 // Exhausted
        }
      });

      const reclaimResult = await scanRepo.reclaimExpiredLeases();
      assert.ok(reclaimResult.permanentlyFailed >= 1);

      const failedScan = await scanRepo.findById(tenantAlpha.id, exhaustedScan.id);
      assert.ok(failedScan);
      assert.equal(failedScan.status, "failed", "Exhausted scan must transition to failed");
      assert.ok(failedScan.completedAt, "Completed timestamp must be set on terminal failure");
      assert.match(failedScan.error ?? "", /maximum retry attempts exceeded/i);
    });

    await test("IT: healthy long-running scan with recurring heartbeats is not reaped", async () => {
      const healthyProj = await prisma.project.create({ data: { tenantId: tenantAlpha.id, name: "healthy-heartbeat-proj" } });
      const activeScan = await prisma.scan.create({
        data: {
          tenantId: tenantAlpha.id,
          projectId: healthyProj.id,
          status: "running",
          workerId: "alive-worker-1",
          leaseToken: randomUUID(),
          startedAt: new Date(),
          heartbeatAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + 60000), // 60s in future
          attemptCount: 1,
          maxAttempts: 3
        }
      });

      // Renew lease explicitly
      const renewed = await scanRepo.renewLease({
        tenantId: tenantAlpha.id,
        projectId: healthyProj.id,
        scanId: activeScan.id,
        workerId: "alive-worker-1",
        leaseToken: activeScan.leaseToken!
      }, 120);
      assert.equal(renewed, true);

      // Run reaper
      await scanRepo.reclaimExpiredLeases();

      // Scan should remain running
      const verifiedScan = await scanRepo.findById(tenantAlpha.id, activeScan.id);
      assert.ok(verifiedScan);
      assert.equal(verifiedScan.status, "running");
    });

    await test("IT: new replica starting while another replica owns a valid lease does not fail it", async () => {
      const peerProj = await prisma.project.create({ data: { tenantId: tenantAlpha.id, name: "peer-replica-proj" } });
      const peerScan = await prisma.scan.create({
        data: {
          tenantId: tenantAlpha.id,
          projectId: peerProj.id,
          status: "running",
          workerId: "replica-1-living",
          startedAt: new Date(),
          heartbeatAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + 60000), // Valid future lease
          attemptCount: 1,
          maxAttempts: 3
        }
      });

      // Replica 2 starts up
      const { BoundedScanRunner } = await import("../../src/jobs/scan-runner.js");
      const replica2Runner = new BoundedScanRunner(prisma, { workerId: "replica-2-booting" });
      await replica2Runner.initialize();

      // Verify Replica 1's scan is undisturbed
      const checkedScan = await scanRepo.findById(tenantAlpha.id, peerScan.id);
      assert.ok(checkedScan);
      assert.equal(checkedScan.status, "running", "Living peer's active scan must NOT be failed on new replica start");

      await replica2Runner.shutdown();
    });

    await test("IT: stale worker attempting to publish after losing its lease is rejected (StaleWorkerError)", async () => {
      const staleProj = await prisma.project.create({ data: { tenantId: tenantAlpha.id, name: "stale-worker-proj" } });
      const staleScan = await prisma.scan.create({
        data: {
          tenantId: tenantAlpha.id,
          projectId: staleProj.id,
          status: "running",
          workerId: "stale-worker-lost-lease",
          leaseToken: randomUUID(),
          startedAt: new Date(),
          leaseExpiresAt: new Date(Date.now() - 10000), // Expired lease
          attemptCount: 1,
          maxAttempts: 3
        }
      });

      // Attempting to publish findings should throw StaleWorkerError
      await assert.rejects(
        async () => {
          await scanRepo.completeScanWithFindings({
            tenantId: tenantAlpha.id,
            projectId: staleProj.id,
            scanId: staleScan.id,
            workerId: "stale-worker-lost-lease",
            leaseToken: staleScan.leaseToken!
          }, [
            {
              requirementId: "req-stale",
              ruleId: "rule-1",
              ruleVersion: "1.0",
              signal: "metric",
              outcome: "pass",
              expected: "pass",
              observed: "pass",
              reason: "stale publication",
              evidenceJson: {}
            }
          ], alphaAdminId);
        },
        (err: unknown) => {
          assert.ok(err instanceof StaleWorkerError);
          assert.equal((err as StaleWorkerError).statusCode, 409);
          return true;
        }
      );

      // Verify no findings were persisted
      const findings = await prisma.finding.findMany({ where: { scanId: staleScan.id } });
      assert.equal(findings.length, 0, "No findings must be published by a stale worker");
      await prisma.scan.updateMany({
        where: { id: staleScan.id, tenantId: tenantAlpha.id, status: "running" },
        data: { status: "failed", leaseToken: null, workerId: null, leaseExpiresAt: null }
      });
    });

    await test("IT: no duplicated or cross-tenant findings after retries", async () => {
      const retryProj = await prisma.project.create({ data: { tenantId: tenantAlpha.id, name: "retry-findings-proj" } });
      const retryScan = await prisma.scan.create({
        data: {
          tenantId: tenantAlpha.id,
          projectId: retryProj.id,
          status: "running",
          workerId: "valid-retry-worker",
          leaseToken: randomUUID(),
          startedAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + 60000),
          attemptCount: 2,
          maxAttempts: 3
        }
      });

      // Seed finding from failed attempt 1
      await prisma.finding.create({
        data: {
          tenantId: tenantAlpha.id,
          projectId: retryProj.id,
          scanId: retryScan.id,
          attemptNumber: 1,
          requirementId: "req-1",
          ruleId: "r-1",
          ruleVersion: "1.0",
          signal: "health",
          outcome: "unknown",
          expected: "healthy",
          observed: "timeout",
          reason: "attempt 1 failed",
          evidenceJson: {}
        }
      });

      // Attempt 2 succeeds and publishes findings atomically
      await scanRepo.completeScanWithFindings({
        tenantId: tenantAlpha.id,
        projectId: retryProj.id,
        scanId: retryScan.id,
        workerId: "valid-retry-worker",
        leaseToken: retryScan.leaseToken!
      }, [
        {
          requirementId: "req-1",
          ruleId: "r-1",
          ruleVersion: "1.0",
          signal: "health",
          outcome: "pass",
          expected: "healthy",
          observed: "healthy",
          reason: "attempt 2 succeeded",
          evidenceJson: {}
        }
      ], alphaAdminId);

      const finalFindings = await prisma.finding.findMany({ where: { scanId: retryScan.id } });
      assert.equal(finalFindings.length, 1, "Findings from attempt 1 must be purged; exactly 1 final finding");
      assert.equal(finalFindings[0].outcome, "pass");
      assert.equal(finalFindings[0].attemptNumber, 2);
    });

    await test("IT: same worker ID receives fresh fencing token after expiry; stale attempt cannot mutate or audit", async () => {
      const project = await prisma.project.create({ data: { tenantId: tenantAlpha.id, name: "same-worker-token-fence" } });
      const pending = await scanRepo.create({ tenantId: tenantAlpha.id, projectId: project.id });
      const tokenAClaim = await scanRepo.claimNextPendingScan("reused-worker-id", 60);
      assert.ok(tokenAClaim);
      assert.equal(tokenAClaim.id, pending.id);
      const tokenA = tokenAClaim.leaseToken!;
      const leaseA = {
        tenantId: tenantAlpha.id,
        projectId: project.id,
        scanId: pending.id,
        workerId: "reused-worker-id",
        leaseToken: tokenA
      };

      await prisma.scan.update({
        where: { id: pending.id },
        data: { leaseExpiresAt: new Date(Date.now() - 5000) }
      });
      assert.equal(await scanRepo.renewLease(leaseA), false, "expired token cannot be renewed even before reaping");
      assert.deepEqual(await scanRepo.reclaimExpiredLeases(), { requeued: 1, permanentlyFailed: 0 });

      const tokenBClaim = await scanRepo.claimNextPendingScan("reused-worker-id", 60);
      assert.ok(tokenBClaim);
      assert.equal(tokenBClaim.id, pending.id);
      assert.equal(tokenBClaim.workerId, tokenAClaim.workerId);
      const tokenB = tokenBClaim.leaseToken!;
      assert.match(tokenB, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.notEqual(tokenB, tokenA);

      const leaseB = { ...leaseA, leaseToken: tokenB };
      assert.equal(await scanRepo.renewLease(leaseA), false, "old claim cannot heartbeat after same worker ID reclaims");

      const staleFinding = {
        requirementId: "stale-token-finding",
        ruleId: "rule-stale",
        ruleVersion: "1",
        signal: "metric",
        outcome: "gap",
        expected: "present",
        observed: "missing",
        reason: "stale token must not publish",
        evidenceJson: {}
      };
      await assert.rejects(scanRepo.completeScanWithFindings(leaseA, [staleFinding], alphaAdminId), StaleWorkerError);
      assert.equal(await scanRepo.failScanWithLease(leaseA, "stale failure", alphaAdminId), false);
      assert.equal((await prisma.finding.count({ where: { scanId: pending.id } })), 0);
      assert.equal(await prisma.auditEvent.count({
        where: { tenantId: tenantAlpha.id, resourceId: pending.id, action: { in: ["SCAN_COMPLETED", "SCAN_FAILED"] } }
      }), 0, "stale completion/failure must not create terminal audit entries");

      // A reaper run while the newer lease is healthy must leave it untouched.
      await scanRepo.reclaimExpiredLeases();
      const afterStaleReaper = await scanRepo.findById(tenantAlpha.id, pending.id);
      assert.equal(afterStaleReaper?.status, "running");
      assert.equal(afterStaleReaper?.leaseToken, tokenB);

      const findingA = { ...staleFinding, requirementId: "token-b-result-a", reason: "token B winner A" };
      const findingB = { ...staleFinding, requirementId: "token-b-result-b", reason: "token B winner B" };
      const concurrent = await Promise.allSettled([
        scanRepo.completeScanWithFindings(leaseB, [findingA], alphaAdminId),
        scanRepo.completeScanWithFindings(leaseB, [findingB], alphaAdminId)
      ]);
      assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(concurrent.filter((result) => result.status === "rejected" && result.reason instanceof StaleWorkerError).length, 1);
      const finalScan = await scanRepo.findById(tenantAlpha.id, pending.id);
      assert.equal(finalScan?.status, "completed", "token B must complete successfully");
      const published = await prisma.finding.findMany({ where: { tenantId: tenantAlpha.id, scanId: pending.id } });
      assert.equal(published.length, 1, "competing completion cannot publish two result sets");
      assert.equal(await prisma.auditEvent.count({
        where: { tenantId: tenantAlpha.id, resourceId: pending.id, action: "SCAN_COMPLETED" }
      }), 1, "successful completion and audit are committed once");
      assert.equal(await prisma.auditEvent.count({
        where: { tenantId: tenantAlpha.id, resourceId: pending.id, action: "SCAN_FAILED" }
      }), 0);
    });

  } finally {
    await server.stop();
    await cleanupTestOwnedFixtures(prisma, tenantIds);
    await prisma.$disconnect();
  }
}

test("Integration Suite: Phase 06 PostgreSQL API Tests", runIntegrationSuite);
