export type ArchitectureDiscoveryStatus = "success" | "partial" | "unsupported" | "invalid";

export interface DiscoveredService {
  id: string;
  name: string;
  workloadType: "compose-service" | "kubernetes-workload";
  image?: string;
  buildContext?: string;
  ports: string[];
  dependencies: string[];
  source: { file: string; format: "docker-compose" | "kubernetes"; documentIndex?: number };
}

export interface DiscoveredResource {
  id: string;
  name: string;
  resourceType: "compose-volume" | "compose-network" | "kubernetes-resource";
  kind?: string;
  ports: string[];
  source: { file: string; format: "docker-compose" | "kubernetes"; documentIndex?: number };
}

export interface ArchitectureDiscoveryResult {
  status: ArchitectureDiscoveryStatus;
  model: { schemaVersion: "cloudpilot.architecture.v1"; services: DiscoveredService[]; resources: DiscoveredResource[] };
  diagnostics: Array<{ code: string; severity: "info" | "warning" | "error"; message: string; file?: string }>;
}

export interface ArchitectureServiceDraft {
  service: DiscoveredService;
  expectedModel: import("./api").ExpectedObservabilityModel;
}

export interface SourceObservabilityAnalysis {
  status: "success" | "partial" | "unsupported" | "invalid";
  sourceDigest: string;
  serviceName?: string;
  routes: Array<{ method: string; path: string; evidence: { path: string; line: number; claim: string } }>;
  expectedModel: import("./api").ExpectedObservabilityModel;
  metricConfigs: Record<string, { serviceName: string; route: string; method: string; minimumCount: number; maxEvidenceAgeMs: number }>;
  evidenceByRequirement: Record<string, Array<{ path: string; line: number; claim: string }>>;
  findings: Array<{ id: string; ruleId: string; severity: "low" | "medium" | "high"; status: "gap" | "incomplete"; title: string; expected: string; observed: string; risk: string; evidence: Array<{ path: string; line: number; claim: string }> }>;
  diagnostics: string[];
  saved?: boolean;
}
