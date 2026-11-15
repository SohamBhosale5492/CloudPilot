import axios, { AxiosError, type AxiosAdapter, type AxiosInstance, type AxiosRequestConfig } from "axios";
import type {
  AuditEvent, ExpectedObservabilityModel, Finding, HealthResponse, Page, Project, ProjectTargetConfig, Remediation, RemediationProposal, Scan
} from "../types/api";
import type { ArchitectureDiscoveryResult, SourceObservabilityAnalysis } from "../types/architecture";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

export function createApiClient(baseURL: string, getAccessToken: () => Promise<string>, adapter?: AxiosAdapter): AxiosInstance {
  const client = axios.create({ baseURL, timeout: 15_000, ...(adapter ? { adapter } : {}) });
  client.interceptors.request.use(async (request) => {
    const token = await getAccessToken();
    request.headers.set("Authorization", `Bearer ${token}`);
    return request;
  });
  client.interceptors.response.use(
    (response) => response,
    (error: unknown) => {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401 && typeof window !== "undefined") {
          window.dispatchEvent(new Event("cloudpilot:unauthorized"));
        }
        const data: unknown = error.response?.data;
        const message = readErrorMessage(data) ?? (error.response?.status === 403
          ? "Your role does not allow this action."
          : error.message || "The request failed.");
        return Promise.reject(new ApiError(message, error.response?.status ?? 0, data));
      }
      return Promise.reject(error);
    }
  );
  return client;
}

function readErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("error" in data)) return null;
  return typeof data.error === "string" ? data.error : null;
}

export interface PageQuery {
  cursor?: string;
  signal?: AbortSignal;
}

export class CloudPilotApi {
  constructor(private readonly client: AxiosInstance) {}

  async liveness(signal?: AbortSignal): Promise<HealthResponse> {
    return (await this.client.get<HealthResponse>("/health/liveness", { signal })).data;
  }
  async readiness(signal?: AbortSignal): Promise<HealthResponse> {
    return (await this.client.get<HealthResponse>("/health/readiness", { signal })).data;
  }
  async listProjects(query: PageQuery = {}): Promise<Page<Project>> {
    return (await this.client.get<Page<Project>>("/api/v1/projects", { params: query.cursor ? { cursor: query.cursor } : {}, signal: query.signal })).data;
  }
  async createProject(input: {
    name: string;
    repositoryUrl?: string;
    expectedModel?: ExpectedObservabilityModel;
    targetConfig?: ProjectTargetConfig;
  }): Promise<Project> {
    return (await this.client.post<{ project: Project }>("/api/v1/projects", input)).data.project;
  }
  async getProject(projectId: string, config?: AxiosRequestConfig): Promise<Project> {
    return (await this.client.get<{ project: Project }>(`/api/v1/projects/${encodeURIComponent(projectId)}`, config)).data.project;
  }
  async deleteProject(projectId: string): Promise<void> {
    await this.client.delete(`/api/v1/projects/${encodeURIComponent(projectId)}`);
  }
  async discoverProjectArchitecture(projectId: string, files: Array<{ path: string; content: string }>): Promise<ArchitectureDiscoveryResult> {
    return (await this.client.post<ArchitectureDiscoveryResult>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/architecture-discovery`, { files }
    )).data;
  }
  async analyzeProjectSource(projectId: string, files: Array<{ path: string; content: string }>): Promise<SourceObservabilityAnalysis> {
    return (await this.client.post<SourceObservabilityAnalysis>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/source-observability-analysis`, { files }
    )).data;
  }
  async applyProjectSourceAnalysis(projectId: string, files: Array<{ path: string; content: string }>, expectedCurrentModel: unknown): Promise<SourceObservabilityAnalysis> {
    return (await this.client.post<SourceObservabilityAnalysis>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/source-observability-analysis/apply`, { files, expectedCurrentModel }
    )).data;
  }
  async saveProjectExpectedModel(projectId: string, expectedModel: ExpectedObservabilityModel): Promise<void> {
    await this.client.put(`/api/v1/projects/${encodeURIComponent(projectId)}/expected-model`, { expectedModel });
  }
  async mergeProjectExpectedModel(projectId: string, expectedCurrentModel: unknown, expectedModel: ExpectedObservabilityModel): Promise<void> {
    await this.client.post(`/api/v1/projects/${encodeURIComponent(projectId)}/expected-model/merge`, { expectedCurrentModel, expectedModel });
  }
  async saveProjectTargetConfig(projectId: string, targetConfig: ProjectTargetConfig): Promise<void> {
    await this.client.put(`/api/v1/projects/${encodeURIComponent(projectId)}/target-config`, { targetConfig });
  }
  async configureGitHubRepository(projectId: string, repositoryUrl: string): Promise<{ projectId: string; configured: true; changed: boolean; repository: { owner: string; name: string; url: string; verified: false } }> {
    return (await this.client.put(`/api/v1/projects/${encodeURIComponent(projectId)}/github-repository`, { repositoryUrl })).data;
  }
  async disconnectGitHubRepository(projectId: string): Promise<{ projectId: string; configured: false; changed: boolean; repository: null }> {
    return (await this.client.delete(`/api/v1/projects/${encodeURIComponent(projectId)}/github-repository`)).data;
  }
  async completeGitHubInstallation(input: { installationId: string; state: string; setupAction: "install" | "update" }): Promise<{
    installationRecordId: string;
    organizationId: string;
    githubInstallationId: string;
    accountLogin: string;
    accountType: "User" | "Organization";
    status: "connected";
    alreadyConnected: boolean;
  }> {
    return (await this.client.post("/api/v1/github/installations/callback", input)).data;
  }
  async listScans(projectId: string, query: PageQuery = {}): Promise<Page<Scan>> {
    return (await this.client.get<Page<Scan>>(`/api/v1/projects/${encodeURIComponent(projectId)}/scans`, {
      params: query.cursor ? { cursor: query.cursor } : {}, signal: query.signal
    })).data;
  }
  async startScan(projectId: string): Promise<{ scanId: string; status: string; projectId: string; createdAt: string }> {
    return (await this.client.post(`/api/v1/projects/${encodeURIComponent(projectId)}/scans`, {})).data;
  }
  async getScan(projectId: string, scanId: string, config?: AxiosRequestConfig): Promise<Scan> {
    return (await this.client.get<{ scan: Scan }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/scans/${encodeURIComponent(scanId)}`, config
    )).data.scan;
  }
  async listFindings(projectId: string, scanId: string, query: PageQuery = {}): Promise<Page<Finding>> {
    return (await this.client.get<Page<Finding>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/scans/${encodeURIComponent(scanId)}/findings`,
      { params: query.cursor ? { cursor: query.cursor } : {}, signal: query.signal }
    )).data;
  }
  async listAuditEvents(query: PageQuery = {}): Promise<Page<AuditEvent>> {
    return (await this.client.get<Page<AuditEvent>>("/api/v1/audit-events", {
      params: query.cursor ? { cursor: query.cursor } : {}, signal: query.signal
    })).data;
  }
  async listRemediations(projectId: string, query: PageQuery = {}): Promise<Page<Remediation>> {
    return (await this.client.get<Page<Remediation>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/remediations`,
      { params: query.cursor ? { cursor: query.cursor } : {}, signal: query.signal }
    )).data;
  }
  async createRemediation(projectId: string, findingId: string): Promise<{ remediationId: string; statusUrl: string; status: string }> {
    return (await this.client.post(`/api/v1/projects/${encodeURIComponent(projectId)}/remediations`, { findingId })).data;
  }
  async getRemediation(remediationId: string, config?: AxiosRequestConfig): Promise<Remediation> {
    return (await this.client.get<{ remediation: Remediation }>(
      `/api/v1/remediations/${encodeURIComponent(remediationId)}`, config
    )).data.remediation;
  }
  async retriggerRemediation(remediationId: string): Promise<{ remediationId: string; statusUrl: string; status: string }> {
    return (await this.client.post(`/api/v1/remediations/${encodeURIComponent(remediationId)}/retrigger`)).data;
  }
  async listRemediationProposals(projectId: string, query: PageQuery = {}): Promise<Page<RemediationProposal>> {
    return (await this.client.get<Page<RemediationProposal>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/remediation-proposals`,
      { params: query.cursor ? { cursor: query.cursor } : {}, signal: query.signal }
    )).data;
  }
  async createRemediationProposal(projectId: string, findingId: string): Promise<{ proposal: RemediationProposal; replayed: boolean }> {
    return (await this.client.post<{ proposal: RemediationProposal; replayed: boolean }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/remediation-proposals`, { findingId }
    )).data;
  }
  async getRemediationProposal(proposalId: string, config?: AxiosRequestConfig): Promise<RemediationProposal> {
    return (await this.client.get<{ proposal: RemediationProposal }>(
      `/api/v1/remediation-proposals/${encodeURIComponent(proposalId)}`, config
    )).data.proposal;
  }
  async prepareRemediationArtifact(proposalId: string): Promise<{ artifactHash: string; replayed: boolean }> {
    return (await this.client.post<{ artifactHash: string; replayed: boolean }>(
      `/api/v1/remediation-proposals/${encodeURIComponent(proposalId)}/prepare-artifact`, {}
    )).data;
  }
  async decideRemediationProposal(proposalId: string, decision: "approve" | "reject"): Promise<{
    remediationId: string; approvalState: string; status: string;
  }> {
    return (await this.client.post(`/api/v1/remediation-proposals/${encodeURIComponent(proposalId)}/${decision}`)).data;
  }
  async listOrganizations(): Promise<{ items: Array<{ id: string; displayName: string; role: string }>; hasMore: boolean }> {
    return (await this.client.get("/api/v1/organizations")).data;
  }
  async createOrganization(displayName: string, idempotencyKey: string): Promise<{
    organization: { id: string; displayName: string; status: string; createdAt: string };
    membership: { role: string; status: string };
  }> {
    return (await this.client.post("/api/v1/organizations", { displayName }, {
      headers: { "Idempotency-Key": idempotencyKey }
    })).data;
  }
  async requestProjectAdoption(organizationId: string, projectId: string, idempotencyKey: string): Promise<{
    adoption: { id: string; status: string; projectId: string };
    replayed: boolean;
  }> {
    return (await this.client.post(
      `/api/v1/organizations/${encodeURIComponent(organizationId)}/project-adoptions`,
      { projectId },
      { headers: { "Idempotency-Key": idempotencyKey } }
    )).data;
  }
  async decideProjectAdoption(
    organizationId: string,
    adoptionId: string,
    projectId: string,
    decision: "approve" | "reject"
  ): Promise<{ adoption: { id: string; status: "approved" | "rejected" } }> {
    return (await this.client.post(
      `/api/v1/organizations/${encodeURIComponent(organizationId)}/project-adoptions/${encodeURIComponent(adoptionId)}/${decision}`,
      { projectId }
    )).data;
  }
  async startGitHubInstallation(organizationId: string): Promise<{
    intentId: string;
    state: string;
    installationUrl: string;
    expiresAt: string;
  }> {
    return (await this.client.post(
      `/api/v1/organizations/${encodeURIComponent(organizationId)}/github/installations/start`, {}
    )).data;
  }
  async listOrganizationInstallations(organizationId: string): Promise<{ installations: Array<{ id: string; accountLogin: string; accountType: string; status: string }> }> {
    return (await this.client.get(`/api/v1/organizations/${encodeURIComponent(organizationId)}/github/installations`)).data;
  }
  async listInstallationRepositories(organizationId: string, installationRecordId: string, page = 1): Promise<{
    repositories: Array<{ id: string; fullName: string; private: boolean; archived: boolean; disabled: boolean }>;
    page: number; hasNextPage: boolean;
  }> {
    return (await this.client.get(`/api/v1/organizations/${encodeURIComponent(organizationId)}/github/installations/${encodeURIComponent(installationRecordId)}/repositories`, { params: { page, perPage: 100 } })).data;
  }
  async getOrganizationProjectBinding(organizationId: string, projectId: string): Promise<{ binding: null | { id: string; installationRecordId: string; repositoryId: string; owner: string; name: string; status: string } }> {
    return (await this.client.get(`/api/v1/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/github-repository`)).data;
  }
  async bindOrganizationProjectRepository(organizationId: string, projectId: string, installationRecordId: string, repositoryId: string): Promise<unknown> {
    return (await this.client.put(`/api/v1/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/github-repository`, { installationRecordId, repositoryId })).data;
  }
  async disconnectOrganizationProjectRepository(organizationId: string, projectId: string): Promise<unknown> {
    return (await this.client.delete(`/api/v1/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/github-repository`)).data;
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof AxiosError) return error.message;
  return error instanceof Error ? error.message : "The request failed. Please try again.";
}
