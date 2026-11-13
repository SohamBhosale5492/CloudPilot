export interface Page<T> {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface Project {
  id: string;
  tenantId: string;
  name: string;
  repositoryUrl: string | null;
  expectedModel: unknown;
  targetConfig: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ExpectedObservabilityModel {
  schemaVersion: "cloudpilot.expected-observability.v1";
  serviceId: string;
  requirements: Array<{
    id: string;
    signal: "metric" | "log" | "trace" | "health" | "alert";
    [key: string]: unknown;
  }>;
}

export interface ProjectTargetConfig {
  prometheusBaseUrl?: string;
  healthBaseUrl?: string;
  traceBackendUrl?: string;
  metricConfigs?: Record<string, {
    serviceName: string;
    route: string;
    method?: string;
    minimumCount: number;
    maxEvidenceAgeMs: number;
  }>;
}

export type ScanStatus = "pending" | "running" | "completed" | "failed";
export interface Scan {
  id: string;
  tenantId: string;
  projectId: string;
  status: ScanStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  attemptCount: number;
}

export type FindingOutcome = "pass" | "gap" | "unknown" | "inconclusive";
export type FindingSignal = "metric" | "health" | "log" | "trace" | "alert";
export interface Finding {
  id: string;
  tenantId: string;
  projectId: string;
  scanId: string;
  requirementId: string;
  ruleId: string;
  ruleVersion: string;
  signal: FindingSignal;
  outcome: FindingOutcome;
  expected: string;
  observed: string;
  reason: string;
  evidenceJson: unknown;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  tenantId: string;
  projectId: string | null;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadataJson: unknown;
  createdAt: string;
}

export type RemediationStatus = "pending" | "running" | "open" | "merged" | "closed" | "failed";
export interface Remediation {
  id: string;
  projectId: string;
  scanId: string;
  findingId: string;
  status: RemediationStatus;
  branchName: string | null;
  prNumber: number | null;
  prUrl: string | null;
  patchSummary: string | null;
  errorMessage: string | null;
  retriesLeft: number;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProposalApprovalState = "pending" | "approved" | "rejected" | "invalidated";
export interface RemediationProposal {
  id: string;
  organizationId: string;
  projectId: string;
  findingId: string;
  repositoryBindingId: string;
  githubRepositoryId: string;
  planHash: string;
  plan: unknown;
  approvalState: ProposalApprovalState;
  status: string;
  approvedByIdentityUserId: string | null;
  approvedAt: string | null;
  rejectedByIdentityUserId: string | null;
  rejectedAt: string | null;
  executionArtifact: { artifactHash: string; filePath: string; baseRef: string; baseCommitSha: string } | null;
  approvedArtifactHash: string | null;
  invalidatedAt: string | null;
  createdAt: string;
  permissions?: { prepareArtifact: boolean; approve: boolean };
  execution?: null | {
    status: string; stage: string | null; attemptNumber: number; commitSha: string | null; branchName: string | null;
    pullRequestNumber: number | null; pullRequestUrl: string | null; failureCode: string | null; updatedAt: string;
  };
}

export interface HealthResponse {
  status: "ok" | "ready" | "unready";
}
