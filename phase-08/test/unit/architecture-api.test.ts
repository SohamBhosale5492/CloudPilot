import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import type { AuthenticatedIdentity } from "../../../phase-06/src/auth/jwt-verifier.js";
import type { AuthenticatedRouteContext } from "../../../phase-06/src/api/server.js";
import type { ArchitectureDiscoveryResult } from "../../../phase-01/demo-service/src/architecture-discovery.js";
import { ArchitectureApiRoutes, LocalManifestArchitectureDiscovery, PrismaArchitectureProjectStore, type ArchitectureDiscoveryService, type ArchitectureProjectStore } from "../../src/api/architecture-api.js";

function identity(role: "admin" | "operator" | "viewer" = "admin", tenantId = "tenant-a"): AuthenticatedIdentity {
  return { userId: "user-1", tenantId, roles: [role] };
}

function request(method: string, path: string, user = identity(), body: unknown = {}) {
  const parsed = new URL(path, "http://localhost");
  const response: { status?: number; body?: unknown } = {};
  const context = {
    req: {} as AuthenticatedRouteContext["req"], res: {} as AuthenticatedRouteContext["res"],
    method, pathname: parsed.pathname, url: parsed, identity: user,
    parseJsonBody: async () => body,
    sendJson: (status: number, value: unknown) => { response.status = status; response.body = value; }
  } satisfies AuthenticatedRouteContext;
  return { context, response };
}

const discoveryResult: ArchitectureDiscoveryResult = {
  status: "partial", model: { schemaVersion: "cloudpilot.architecture.v1", services: [], resources: [] },
  diagnostics: [{ code: "PARTIAL_DISCOVERY", severity: "warning", message: "One file was unsupported." }]
};

class FakeDiscovery implements ArchitectureDiscoveryService {
  calls: unknown[] = [];
  async discover(files: Parameters<ArchitectureDiscoveryService["discover"]>[0]) { this.calls.push(files); return discoveryResult; }
}
class FakeProjects implements ArchitectureProjectStore {
  existsResult = true;
  mergeResult = true;
  saves: unknown[] = [];
  merges: unknown[] = [];
  targetSaves: unknown[] = [];
  async exists(tenantId: string) { return tenantId === "tenant-a" && this.existsResult; }
  async saveExpectedModel(...args: Parameters<ArchitectureProjectStore["saveExpectedModel"]>) { this.saves.push(args); return true; }
  async mergeExpectedModel(...args: Parameters<ArchitectureProjectStore["mergeExpectedModel"]>) { this.merges.push(args); return this.mergeResult; }
  async saveTargetConfig(...args: Parameters<ArchitectureProjectStore["saveTargetConfig"]>) { this.targetSaves.push(args); return true; }
}

test("discovery is authenticated, tenant scoped, and preserves partial diagnostics without saving a model", async () => {
  const projects = new FakeProjects(); const discovery = new FakeDiscovery();
  const routes = new ArchitectureApiRoutes(projects, discovery);
  const req = request("POST", "/api/v1/projects/p1/architecture-discovery", identity("admin", "tenant-a"), { files: [{ path: "compose.yaml", content: "services: {}" }] });
  assert.equal(await routes.handle(req.context), true);
  assert.equal(req.response.status, 200);
  assert.equal((req.response.body as ArchitectureDiscoveryResult).status, "partial");
  assert.equal(discovery.calls.length, 1);
  assert.equal(projects.saves.length, 0);

  const foreign = request("POST", "/api/v1/projects/p1/architecture-discovery", identity("admin", "tenant-b"), { files: [] });
  await routes.handle(foreign.context);
  assert.equal(foreign.response.status, 404);
  assert.equal(discovery.calls.length, 1);
});

test("expected-model merge uses an explicit baseline and reports stale drafts as conflict", async () => {
  const projects = new FakeProjects(); const routes = new ArchitectureApiRoutes(projects);
  const current = { schemaVersion: "cloudpilot.expected-observability.v1", serviceId: "api", requirements: [{ id: "old", signal: "trace", serviceName: "api" }] };
  const merged = { ...current, requirements: [...current.requirements, { id: "new", signal: "metric", metricName: "requests_total", dimensions: [] }] };
  const requestBody = { expectedCurrentModel: current, expectedModel: merged };
  const ok = request("POST", "/api/v1/projects/p1/expected-model/merge", identity(), requestBody);
  await routes.handle(ok.context);
  assert.equal(ok.response.status, 200);
  assert.deepEqual(projects.merges[0], ["tenant-a", "p1", "user-1", current, merged]);

  projects.mergeResult = false;
  const stale = request("POST", "/api/v1/projects/p1/expected-model/merge", identity(), requestBody);
  await routes.handle(stale.context);
  assert.equal(stale.response.status, 409);
  assert.equal(projects.saves.length, 0);
});

test("Prisma model merge compares the baseline atomically and audits only a successful update", async () => {
  const auditEvents: unknown[] = [];
  const rawCalls: Array<{ sql: string; values: unknown[] }> = [];
  let updateCount = 1;
  const prisma = {
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation(prisma),
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      rawCalls.push({ sql: strings.join("?"), values });
      return updateCount;
    },
    auditEvent: { create: async (input: unknown) => { auditEvents.push(input); } }
  } as unknown as PrismaClient;
  const store = new PrismaArchitectureProjectStore(prisma);
  const baseline = { schemaVersion: "cloudpilot.expected-observability.v1", serviceId: "api", requirements: [] };
  const model = { ...baseline, requirements: [{ id: "new", signal: "metric", metricName: "requests_total", dimensions: [] }] };

  assert.equal(await store.mergeExpectedModel("tenant-a", "p1", "user-1", baseline, model as never), true);
  assert.match(rawCalls[0].sql, /expected_model IS NOT DISTINCT FROM \?::jsonb/);
  assert.deepEqual(rawCalls[0].values, [JSON.stringify(model), "p1", "tenant-a", JSON.stringify(baseline)]);
  assert.equal(auditEvents.length, 1);

  updateCount = 0;
  assert.equal(await store.mergeExpectedModel("tenant-a", "p1", "user-1", baseline, model as never), false);
  assert.equal(auditEvents.length, 1);
});

test("viewer cannot start discovery", async () => {
  const discovery = new FakeDiscovery();
  const req = request("POST", "/api/v1/projects/p1/architecture-discovery", identity("viewer"), { files: [] });
  assert.equal(await new ArchitectureApiRoutes(new FakeProjects(), discovery).handle(req.context), true);
  assert.equal(req.response.status, 403);
  assert.equal(discovery.calls.length, 0);
});

test("model save requires explicit valid requirements and remains tenant scoped", async () => {
  const projects = new FakeProjects(); const routes = new ArchitectureApiRoutes(projects);
  const path = "/api/v1/projects/p1/expected-model";
  const empty = request("PUT", path, identity(), { expectedModel: { schemaVersion: "cloudpilot.expected-observability.v1", serviceId: "api", requirements: [] } });
  await routes.handle(empty.context);
  assert.equal(empty.response.status, 400);
  assert.equal(projects.saves.length, 0);

  const model = { schemaVersion: "cloudpilot.expected-observability.v1", serviceId: "api", requirements: [
    { id: "api-requests", signal: "metric", metricName: "http_requests_total", dimensions: ["route"] }
  ] };
  const save = request("PUT", path, identity(), { expectedModel: model });
  await routes.handle(save.context);
  assert.deepEqual(save.response.body, { projectId: "p1", saved: true });
  assert.equal(projects.saves.length, 1);
  assert.equal((projects.saves[0] as unknown[])[0], "tenant-a");
});

test("telemetry target route validates supported config, scopes by tenant, and saves explicitly", async () => {
  const projects = new FakeProjects(); const routes = new ArchitectureApiRoutes(projects);
  const targetConfig = {
    prometheusBaseUrl: "http://127.0.0.1:9090",
    metricConfigs: { requests: { serviceName: "demo-service", route: "/api/demo", method: "GET", minimumCount: 1, maxEvidenceAgeMs: 60_000 } }
  };
  const valid = request("PUT", "/api/v1/projects/p1/target-config", identity("admin"), { targetConfig });
  await routes.handle(valid.context);
  assert.equal(valid.response.status, 200);
  assert.equal(projects.targetSaves.length, 1);
  assert.equal((projects.targetSaves[0] as unknown[])[0], "tenant-a");

  const unsupported = request("PUT", "/api/v1/projects/p1/target-config", identity("admin"), { targetConfig: { traceBackendUrl: "http://localhost:16686" } });
  await routes.handle(unsupported.context);
  assert.equal(unsupported.response.status, 400);
  assert.equal(projects.targetSaves.length, 1);
});

test("local manifest discovery uses the existing Compose engine and rejects unsafe or incomplete uploads", async () => {
  const discovery = new LocalManifestArchitectureDiscovery();
  const valid = await discovery.discover([{ path: "compose.yaml", content: [
    "services:", "  api:", "    image: example/api:1", "    ports:", "      - 8080:8080"
  ].join("\n") }]);
  assert.equal(valid.status, "success");
  assert.equal(valid.model.services[0]?.name, "api");
  assert.deepEqual(valid.model.services[0]?.ports, ["8080:8080"]);

  const traversal = await discovery.discover([{ path: "../outside.yaml", content: "services: {}" }]);
  assert.equal(traversal.status, "invalid");
  const unsupported = await discovery.discover([{ path: "terraform.yaml", content: "resource: {}" }]);
  assert.equal(unsupported.status, "unsupported");
});
