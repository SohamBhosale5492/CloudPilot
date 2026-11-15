import type { AxiosAdapter } from "axios";
import { describe, expect, it, vi } from "vitest";
import { CloudPilotApi, createApiClient } from "./client";

describe("API client", () => {
  it("lists remediation proposals for a project with optional cursor", async () => {
    const requests: Array<{ method: string; url: string; params: unknown }> = [];
    const adapter: AxiosAdapter = async (config) => ({
      data: { items: [], hasMore: false },
      status: 200,
      statusText: "OK",
      headers: {},
      config: (requests.push({ method: config.method ?? "", url: config.url ?? "", params: config.params }), config)
    });
    const api = new CloudPilotApi(createApiClient("/", async () => "token", adapter));
    await api.listRemediationProposals("project/1", { cursor: "cursor-1" });
    expect(requests).toEqual([
      { method: "get", url: "/api/v1/projects/project%2F1/remediation-proposals", params: { cursor: "cursor-1" } }
    ]);
  });

  it("acquires a bearer token for each request without storing it in the client", async () => {
    const getToken = vi.fn(async () => "mock-access-token");
    let sentAuthorization: unknown;
    const adapter: AxiosAdapter = async (config) => ({
      data: { ok: true }, status: 200, statusText: "OK", headers: {}, config: (sentAuthorization = config.headers.get("Authorization"), config)
    });
    const client = createApiClient("/", getToken, adapter);
    await client.get("/api/v1/projects");
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(sentAuthorization).toBe("Bearer mock-access-token");
    expect(client.defaults.headers.common.Authorization).toBeUndefined();
  });

  it("posts expected-model and telemetry target configuration to the existing project API", async () => {
    let requestBody: unknown;
    let requestUrl = "";
    const adapter: AxiosAdapter = async (config) => ({
      data: { project: { id: "project-1" } }, status: 201, statusText: "Created", headers: {},
      config: (requestUrl = config.url ?? "", requestBody = JSON.parse(String(config.data)), config)
    });
    const api = new CloudPilotApi(createApiClient("/", async () => "token", adapter));
    const expectedModel = {
      schemaVersion: "cloudpilot.expected-observability.v1" as const,
      serviceId: "demo-service",
      requirements: [{ id: "requests", signal: "metric" as const, metricName: "demo_http_server_requests_total", dimensions: [] }]
    };
    const targetConfig = { prometheusBaseUrl: "http://127.0.0.1:9090" };

    await api.createProject({ name: "Demo", expectedModel, targetConfig });

    expect(requestUrl).toBe("/api/v1/projects");
    expect(requestBody).toEqual({ name: "Demo", expectedModel, targetConfig });
  });

  it("saves telemetry targets through the authenticated project-scoped API", async () => {
    let method = "";
    let requestUrl = "";
    let requestBody: unknown;
    const adapter: AxiosAdapter = async (config) => ({
      data: { projectId: "project-1", saved: true }, status: 200, statusText: "OK", headers: {},
      config: (method = config.method ?? "", requestUrl = config.url ?? "", requestBody = JSON.parse(String(config.data)), config)
    });
    const api = new CloudPilotApi(createApiClient("/", async () => "token", adapter));
    const targetConfig = { prometheusBaseUrl: "http://127.0.0.1:9090", metricConfigs: {} };
    await api.saveProjectTargetConfig("project/1", targetConfig);
    expect(method).toBe("put");
    expect(requestUrl).toBe("/api/v1/projects/project%2F1/target-config");
    expect(requestBody).toEqual({ targetConfig });
  });

  it("previews and applies a source-derived model through authenticated project-scoped routes", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const adapter: AxiosAdapter = async (config) => ({
      data: { status: "success", saved: true }, status: 200, statusText: "OK", headers: {},
      config: (calls.push({ method: config.method ?? "", url: config.url ?? "", body: JSON.parse(String(config.data)) }), config)
    });
    const api = new CloudPilotApi(createApiClient("/", async () => "token", adapter));
    const files = [{ path: "backend/src/app.js", content: 'app.get("/health", handler);' }];
    await api.analyzeProjectSource("p/1", files);
    await api.applyProjectSourceAnalysis("p/1", files, null);
    expect(calls.map(({ method, url, body }) => ({ method, url, body: Object.keys(body as object).sort() }))).toEqual([
      { method: "post", url: "/api/v1/projects/p%2F1/source-observability-analysis", body: ["files"] },
      { method: "post", url: "/api/v1/projects/p%2F1/source-observability-analysis/apply", body: ["expectedCurrentModel", "files"] }
    ]);
  });

  it("configures and disconnects a project repository reference through authenticated project routes", async () => {
    const requests: Array<{ method: string; url: string; data: unknown }> = [];
    const adapter: AxiosAdapter = async (config) => ({
      data: { projectId: "project-1", configured: config.method !== "delete", changed: true },
      status: 200, statusText: "OK", headers: {},
      config: (requests.push({ method: config.method ?? "", url: config.url ?? "", data: config.data }), config)
    });
    const api = new CloudPilotApi(createApiClient("/", async () => "token", adapter));
    await api.configureGitHubRepository("project/1", "https://github.com/example/service");
    await api.disconnectGitHubRepository("project/1");
    expect(requests[0]).toMatchObject({
      method: "put", url: "/api/v1/projects/project%2F1/github-repository",
      data: JSON.stringify({ repositoryUrl: "https://github.com/example/service" })
    });
    expect(requests[1]).toMatchObject({ method: "delete", url: "/api/v1/projects/project%2F1/github-repository" });
  });

  it("relays GitHub installation callback parameters through the authenticated API without adding identifiers", async () => {
    let requestUrl = "";
    let requestBody: unknown;
    const adapter: AxiosAdapter = async (config) => ({
      data: { status: "connected", alreadyConnected: false }, status: 201, statusText: "Created", headers: {},
      config: (requestUrl = config.url ?? "", requestBody = JSON.parse(String(config.data)), config)
    });
    const api = new CloudPilotApi(createApiClient("/", async () => "token", adapter));
    for (const setupAction of ["install", "update"] as const) {
      const callback = { installationId: "123", state: "A".repeat(43), setupAction };
      await api.completeGitHubInstallation(callback);
      expect(requestUrl).toBe("/api/v1/github/installations/callback");
      expect(requestBody).toEqual(callback);
    }
  });

  it("starts an organization GitHub installation with an empty authenticated request body", async () => {
    let requestUrl = "";
    let requestBody: unknown;
    let authorization: unknown;
    const adapter: AxiosAdapter = async (config) => ({
      data: { intentId: "intent-1", state: "s".repeat(43), installationUrl: "https://github.com/apps/cloudpilot/installations/new?state=" + "s".repeat(43), expiresAt: "2026-11-13T00:10:00Z" },
      status: 201, statusText: "Created", headers: {},
      config: (requestUrl = config.url ?? "", requestBody = JSON.parse(String(config.data)),
        authorization = config.headers.get("Authorization"), config)
    });
    const api = new CloudPilotApi(createApiClient("/", async () => "session-token", adapter));

    const result = await api.startGitHubInstallation("org/1");

    expect(requestUrl).toBe("/api/v1/organizations/org%2F1/github/installations/start");
    expect(requestBody).toEqual({});
    expect(authorization).toBe("Bearer session-token");
    expect(result.intentId).toBe("intent-1");
  });

  it("creates an organization with the backend idempotency key through the authenticated client", async () => {
    let requestUrl = "";
    let requestBody: unknown;
    let idempotencyKey: unknown;
    let authorization: unknown;
    const adapter: AxiosAdapter = async (config) => ({
      data: { organization: { id: "org-1" }, membership: { role: "owner", status: "active" } },
      status: 201, statusText: "Created", headers: {},
      config: (requestUrl = config.url ?? "", requestBody = JSON.parse(String(config.data)),
        idempotencyKey = config.headers.get("Idempotency-Key"), authorization = config.headers.get("Authorization"), config)
    });
    const api = new CloudPilotApi(createApiClient("/", async () => "session-token", adapter));

    await api.createOrganization("Example Org", "request-123");

    expect(requestUrl).toBe("/api/v1/organizations");
    expect(requestBody).toEqual({ displayName: "Example Org" });
    expect(idempotencyKey).toBe("request-123");
    expect(authorization).toBe("Bearer session-token");
  });

  it("uses the approved persisted proposal and artifact review routes", async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const adapter: AxiosAdapter = async (config) => ({
      data: config.url?.endsWith("prepare-artifact")
        ? { artifactHash: "b".repeat(64), replayed: false }
        : config.url?.endsWith("/approve") ? { remediationId: "proposal-1", approvalState: "approved", status: "pending_approval" }
          : { proposal: { id: "proposal-1" }, replayed: false },
      status: 200, statusText: "OK", headers: {},
      config: (requests.push({ method: config.method ?? "", url: config.url ?? "", body: config.data ? JSON.parse(String(config.data)) : null }), config)
    });
    const api = new CloudPilotApi(createApiClient("/", async () => "token", adapter));
    await api.createRemediationProposal("project/1", "finding-1");
    await api.prepareRemediationArtifact("proposal/1");
    await api.decideRemediationProposal("proposal/1", "approve");
    expect(requests).toEqual([
      { method: "post", url: "/api/v1/projects/project%2F1/remediation-proposals", body: { findingId: "finding-1" } },
      { method: "post", url: "/api/v1/remediation-proposals/proposal%2F1/prepare-artifact", body: {} },
      { method: "post", url: "/api/v1/remediation-proposals/proposal%2F1/approve", body: null }
    ]);
  });

  it("requests and approves project adoption through authenticated organization routes", async () => {
    const requests: Array<{ method: string; url: string; body: unknown; idempotencyKey: unknown }> = [];
    const adapter: AxiosAdapter = async (config) => ({
      data: config.url?.endsWith("/approve")
        ? { adoption: { id: "adopt-1", status: "approved" } }
        : { adoption: { id: "adopt-1", status: "pending", projectId: "project-1" }, replayed: false },
      status: config.url?.endsWith("/approve") ? 200 : 202,
      statusText: "OK",
      headers: {},
      config: (requests.push({
        method: config.method ?? "",
        url: config.url ?? "",
        body: JSON.parse(String(config.data)),
        idempotencyKey: config.headers.get("Idempotency-Key")
      }), config)
    });
    const api = new CloudPilotApi(createApiClient("/", async () => "token", adapter));
    await api.requestProjectAdoption("org/1", "project-1", "adopt-key-1");
    await api.decideProjectAdoption("org/1", "adopt/1", "project-1", "approve");
    expect(requests).toEqual([
      {
        method: "post",
        url: "/api/v1/organizations/org%2F1/project-adoptions",
        body: { projectId: "project-1" },
        idempotencyKey: "adopt-key-1"
      },
      {
        method: "post",
        url: "/api/v1/organizations/org%2F1/project-adoptions/adopt%2F1/approve",
        body: { projectId: "project-1" },
        idempotencyKey: undefined
      }
    ]);
  });
});
