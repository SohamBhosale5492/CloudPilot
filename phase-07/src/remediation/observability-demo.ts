import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  discoverArchitecture,
  type ArchitectureDiscoveryResult
} from "../../../phase-01/demo-service/src/architecture-discovery";
import {
  normalizeExpectedObservability,
  type ExpectedObservabilityModel
} from "../../../phase-01/demo-service/src/expected-observability";
import {
  evaluateExpectedObservabilityModel,
  type GapFinding,
  type GapEngineConfig
} from "../../../phase-01/demo-service/src/gap-engine";
import {
  inspectExpectedObservabilityRequirement,
  type InspectorConfiguration,
  type InspectorEvidence
} from "../../../phase-01/demo-service/src/inspectors";
import { isRemediationSupported, planRemediation } from "./planner";

export interface ObservabilityDemoInput {
  workloadRoot: string;
  includePaths?: string[];
  expectedObservability: unknown;
  inspector: InspectorConfiguration;
  gapEngine?: GapEngineConfig;
  evaluatedAt?: Date;
}

export interface LabConfigurationSummary {
  prometheusJobs: string[];
  collectorPipelines: string[];
  diagnostics: string[];
}

export interface GeneratedConfiguration {
  filePath: string;
  content: string;
  validation: "valid";
  findingIds: string[];
}

export interface ObservabilityDemoReport {
  discovery: ArchitectureDiscoveryResult;
  configuration: LabConfigurationSummary;
  expectedModel: ExpectedObservabilityModel;
  evidence: InspectorEvidence[];
  findings: GapFinding[];
  recommendations: Array<{ findingId: string; text: string }>;
  generatedConfigurations: GeneratedConfiguration[];
}

/**
 * Runs the existing Phase 02–07 components as one read-only, deterministic
 * demo workflow. Generated configuration is returned for review and is never
 * written into the inspected workload.
 */
export async function runObservabilityDemo(input: ObservabilityDemoInput): Promise<ObservabilityDemoReport> {
  const discovery = await discoverArchitecture({ repositoryRoot: input.workloadRoot, includePaths: input.includePaths });
  const normalized = normalizeExpectedObservability(input.expectedObservability);
  if (normalized.status !== "valid" || !normalized.model) {
    throw new Error(`Expected observability model is ${normalized.status}: ${normalized.diagnostics.map((item) => item.code).join(", ")}`);
  }

  const [configuration, evidence] = await Promise.all([
    inspectLabConfiguration(input.workloadRoot),
    Promise.all(normalized.model.requirements.map((requirement) =>
      inspectExpectedObservabilityRequirement(requirement, {
        ...input.inspector,
        collectedAt: input.evaluatedAt,
        evaluatedAt: input.evaluatedAt
      })
    ))
  ]);

  const gapConfig: GapEngineConfig = { ...input.gapEngine, evaluatedAt: input.evaluatedAt ?? input.gapEngine?.evaluatedAt };
  const findings = evaluateExpectedObservabilityModel(normalized.model, evidence, gapConfig);
  const recommendations = findings.map((finding) => ({
    findingId: finding.id,
    text: finding.outcome === "gap"
      ? `Address the confirmed ${finding.signal} gap: ${finding.reason}`
      : finding.outcome === "pass"
        ? `No change recommended: ${finding.reason}`
        : `Collect or configure sufficient ${finding.signal} evidence: ${finding.reason}`
  }));

  const generatedConfigurations = new Map<string, GeneratedConfiguration>();
  for (const finding of findings) {
    if (!isRemediationSupported(finding.signal, finding.outcome)) continue;
    const patch = planRemediation({
      requirementId: finding.requirementId,
      ruleId: finding.rule.id,
      ruleVersion: finding.rule.version,
      signal: finding.signal,
      outcome: finding.outcome,
      expected: finding.expected,
      observed: finding.observed,
      reason: finding.reason
    });
    const existing = generatedConfigurations.get(patch.filePath);
    const content = patch.applyPatch(existing?.content ?? patch.initialFileContent);
    validateGeneratedYaml(content, finding.requirementId, finding.signal);
    generatedConfigurations.set(patch.filePath, {
      filePath: patch.filePath,
      content,
      validation: "valid",
      findingIds: [...(existing?.findingIds ?? []), finding.id]
    });
  }

  return {
    discovery,
    configuration,
    expectedModel: normalized.model,
    evidence,
    findings,
    recommendations,
    generatedConfigurations: [...generatedConfigurations.values()].sort((a, b) => a.filePath.localeCompare(b.filePath))
  };
}

async function inspectLabConfiguration(workloadRoot: string): Promise<LabConfigurationSummary> {
  const diagnostics: string[] = [];
  let prometheusJobs: string[] = [];
  let collectorPipelines: string[] = [];
  const prometheusPath = path.join(workloadRoot, "prometheus", "prometheus.yml");
  const collectorPath = path.join(workloadRoot, "collector", "otel-collector-config.yml");

  try {
    const config = YAML.parse(await readFile(prometheusPath, "utf8")) as { scrape_configs?: Array<{ job_name?: unknown }> };
    prometheusJobs = Array.isArray(config?.scrape_configs)
      ? config.scrape_configs.flatMap((job) => typeof job.job_name === "string" ? [job.job_name] : [])
      : [];
  } catch {
    diagnostics.push("Prometheus scrape configuration is missing or invalid.");
  }

  try {
    const config = YAML.parse(await readFile(collectorPath, "utf8")) as { service?: { pipelines?: Record<string, unknown> } };
    collectorPipelines = Object.keys(config?.service?.pipelines ?? {}).sort();
  } catch {
    diagnostics.push("OpenTelemetry Collector pipeline configuration is missing or invalid.");
  }

  return { prometheusJobs: prometheusJobs.sort(), collectorPipelines, diagnostics };
}

function validateGeneratedYaml(content: string, requirementId: string, signal: string): void {
  const document = YAML.parse(content);
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("Generated configuration root must be a mapping.");
  }
  const key = signal === "metric" ? "metrics" : signal === "health" ? "health_checks" : "alerts";
  const entries = document[key];
  const expectedEntry = signal === "health"
    ? requirementId.replace(/[^a-zA-Z0-9_\-]/g, "-").toLowerCase()
    : requirementId.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
  if (!Array.isArray(entries) || !entries.some((entry) => Object.values(entry as Record<string, unknown>).includes(expectedEntry))) {
    throw new Error("Generated configuration does not contain the approved finding entry.");
  }
}
