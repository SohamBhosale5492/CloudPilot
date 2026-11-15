/**
 * Phase 05 — Gap Engine
 *
 * Deterministic, evidence-based evaluation of expected observability requirements.
 * Accepts pre-collected InspectorEvidence; does not call inspectors or make
 * network requests. Evidence collection is strictly separated from evaluation.
 */

import type {
  ExpectedAlertRequirement,
  ExpectedHealthCheckRequirement,
  ExpectedLogRequirement,
  ExpectedMetricRequirement,
  ExpectedObservabilityModel,
  ExpectedRequirement,
  ExpectedTraceRequirement
} from "./expected-observability";
import type { EvaluationOutcome, RequestMetricRequirement, TelemetryEvidence } from "./evaluation";
import { evaluateRequestMetricRequirement } from "./evaluation";
import type {
  AlertEvidenceData,
  HealthEvidenceData,
  InspectorEvidence,
  InspectorProvenance,
  InspectorSignal,
  MetricEvidenceData,
  TraceEvidenceData
} from "./inspectors";

export type { EvaluationOutcome };

// ─── Rule metadata ─────────────────────────────────────────────────────────────

export interface GapRuleMetadata {
  /** Stable rule identifier under the CP-RULE-OBS-GAP-* namespace. */
  id: string;
  /** Semantic version. Increment only when evaluation logic changes. */
  version: string;
}

export const metricGapRule: GapRuleMetadata = {
  id: "CP-RULE-OBS-GAP-METRIC-PRESENT",
  version: "1.0.0"
};

export const healthGapRule: GapRuleMetadata = {
  id: "CP-RULE-OBS-GAP-HEALTH-PROBE",
  version: "1.0.0"
};

export const logGapRule: GapRuleMetadata = {
  id: "CP-RULE-OBS-GAP-LOG-UNCONFIGURED",
  version: "1.0.0"
};

export const traceGapRule: GapRuleMetadata = {
  id: "CP-RULE-OBS-GAP-TRACE-UNCONFIGURED",
  version: "1.1.0"
};

export const alertGapRule: GapRuleMetadata = {
  id: "CP-RULE-OBS-GAP-ALERT-UNCONFIGURED",
  version: "1.0.0"
};

// ─── Finding type ──────────────────────────────────────────────────────────────

/**
 * A single gap engine evaluation result. Separate from the Phase 01 Finding
 * type to preserve the existing evaluation contract without modification.
 *
 * Outcome semantics:
 *   pass        — sufficient, fresh, complete evidence confirms compliance
 *   gap         — sufficient, fresh, complete evidence confirms non-compliance
 *   unknown     — evidence unavailable or insufficient to determine pass or gap
 *   inconclusive — evidence malformed, stale, or internally conflicting
 */
export interface GapFinding {
  /** Stable identifier: ruleId:ruleVersion:requirementId */
  id: string;
  rule: GapRuleMetadata;
  requirementId: string;
  signal: InspectorSignal;
  outcome: EvaluationOutcome;
  /** Human-readable description of what was required. */
  expected: string;
  /** Human-readable description of what was observed. */
  observed: string;
  /** Explanation of why this outcome was chosen. */
  reason: string;
  /** Provenance of the evidence that produced this finding. */
  evidenceProvenance: InspectorProvenance;
}

// ─── Configuration ─────────────────────────────────────────────────────────────

/**
 * Runtime evaluation parameters for a single metric requirement.
 *
 * ExpectedMetricRequirement intentionally omits deployment attributes
 * (serviceName, route) and policy thresholds (minimumCount, maxEvidenceAgeMs).
 * Supply them here, keyed by requirement ID.
 */
export interface MetricEvaluationConfig {
  serviceName: string;
  route: string;
  method?: string;
  /** Minimum acceptable metric count across matching series for a pass verdict. */
  minimumCount: number;
  /** Maximum age of evidence in milliseconds before it is considered stale. */
  maxEvidenceAgeMs: number;
}

export interface GapEngineConfig {
  /**
   * Per-requirement metric evaluation parameters keyed by requirement ID.
   * When absent for a given metric requirement, that requirement returns unknown.
   * Never silently defaulted.
   */
  metricConfigs?: Record<string, MetricEvaluationConfig>;
  /**
   * Maximum age in milliseconds for health probe evidence to be considered fresh.
   * When not set, pass/gap health verdicts cannot be determined and are
   * returned as inconclusive.
   */
  maxHealthEvidenceAgeMs?: number;
  /**
   * Evaluation timestamp used for all staleness checks in one evaluation pass.
   * Defaults to new Date(). Inject a fixed value for deterministic testing.
   */
  evaluatedAt?: Date;
}

// ─── Public entry points ───────────────────────────────────────────────────────

/**
 * Evaluate a single expected requirement against one piece of inspector evidence.
 *
 * Deterministic for fixed inputs. Does not call inspectors or make network requests.
 */
export function evaluateGap(
  requirement: ExpectedRequirement,
  evidence: InspectorEvidence,
  config: GapEngineConfig = {}
): GapFinding {
  const evaluatedAt = config.evaluatedAt ?? new Date();

  switch (requirement.signal) {
    case "metric":
      return evaluateMetricGap(requirement, evidence, config, evaluatedAt);
    case "health":
      return evaluateHealthGap(requirement, evidence, config.maxHealthEvidenceAgeMs, evaluatedAt);
    case "log":
      return evaluateLogGap(requirement, evidence);
    case "trace":
      return evaluateTraceGap(requirement, evidence);
    case "alert":
      return evaluateAlertGap(requirement, evidence);
    default: {
      const req = requirement as { id?: string; signal?: unknown };
      return {
        id: `CP-RULE-OBS-GAP-UNKNOWN:1.0.0:${req.id ?? "<unknown>"}`,
        rule: { id: "CP-RULE-OBS-GAP-UNKNOWN", version: "1.0.0" },
        requirementId: req.id ?? "<unknown>",
        signal: (req.signal as InspectorSignal) ?? "metric",
        outcome: "inconclusive",
        expected: "Supported observability signal.",
        observed: `Unsupported signal: ${String(req.signal)}.`,
        reason: "The gap engine does not support this signal type.",
        evidenceProvenance: evidence.provenance
      };
    }
  }
}

/**
 * Batch-evaluate all requirements in an expected observability model against a
 * collection of inspector evidence.
 *
 * Evidence is matched to requirements by requirementId:
 * - No matching evidence → unknown.
 * - Multiple entries for one requirementId → inconclusive (ambiguous mapping).
 * - Output is sorted deterministically by requirementId.
 *
 * Does not call inspectors or make network requests.
 */
export function evaluateExpectedObservabilityModel(
  model: ExpectedObservabilityModel,
  evidences: readonly InspectorEvidence[],
  config: GapEngineConfig = {}
): GapFinding[] {
  // Pin evaluatedAt once so all findings in one pass share the same timestamp.
  const evaluatedAt = config.evaluatedAt ?? new Date();
  const effectiveConfig: GapEngineConfig = { ...config, evaluatedAt };

  // Index evidence; detect duplicates
  const evidenceMap = new Map<string, InspectorEvidence[]>();
  for (const e of evidences) {
    const slot = evidenceMap.get(e.requirementId);
    if (slot) {
      slot.push(e);
    } else {
      evidenceMap.set(e.requirementId, [e]);
    }
  }

  const findings: GapFinding[] = [];

  for (const requirement of model.requirements) {
    const slot = evidenceMap.get(requirement.id);

    if (!slot || slot.length === 0) {
      findings.push(buildNoEvidenceFinding(requirement));
      continue;
    }

    if (slot.length > 1) {
      findings.push(buildAmbiguousEvidenceFinding(requirement, slot));
      continue;
    }

    findings.push(evaluateGap(requirement, slot[0], effectiveConfig));
  }

  findings.sort((a, b) => a.requirementId.localeCompare(b.requirementId));
  return findings;
}

// ─── Signal-specific evaluators (private) ─────────────────────────────────────

function evaluateMetricGap(
  req: ExpectedMetricRequirement,
  evidence: InspectorEvidence,
  config: GapEngineConfig,
  evaluatedAt: Date
): GapFinding {
  const base = findingBase(metricGapRule, req.id, "metric", evidence.provenance);
  const expected = metricExpectedDescription(req);

  // Require explicit config — never silently fill in defaults
  const metricConfig = config.metricConfigs?.[req.id];
  if (metricConfig === undefined) {
    return {
      ...base,
      outcome: "unknown",
      expected,
      observed: "No metric evaluation configuration was provided for this requirement.",
      reason:
        "Metric evaluation requires serviceName, route, minimumCount, and maxEvidenceAgeMs. " +
        "Supply these via GapEngineConfig.metricConfigs[requirementId]."
    };
  }

  if (!isValidMetricConfig(metricConfig)) {
    return {
      ...base,
      outcome: "inconclusive",
      expected,
      observed: "Metric evaluation configuration contains invalid field values.",
      reason:
        "serviceName and route must be non-empty strings; " +
        "minimumCount and maxEvidenceAgeMs must be non-negative finite numbers."
    };
  }

  // Validate evidence source before projecting — unsupported sources cannot
  // produce a reliable verdict
  const rawSource = evidence.provenance.source;
  if (rawSource !== "prometheus" && rawSource !== "synthetic-fixture") {
    return {
      ...base,
      outcome: "inconclusive",
      expected,
      observed: `Evidence provenance source is unsupported or absent: ${rawSource ?? "<absent>"}.`,
      reason: "Metric evidence source must be 'prometheus' or 'synthetic-fixture'."
    };
  }

  const metricEvidence = evidence as InspectorEvidence<MetricEvidenceData>;
  const telemetryEvidence: TelemetryEvidence = {
    source: rawSource,
    collectedAt: evidence.collectedAt,
    available: evidence.available,
    complete: evidence.complete,
    samples: metricEvidence.data?.samples ?? []
  };

  const requestRequirement: RequestMetricRequirement = {
    id: req.id,
    serviceName: metricConfig.serviceName,
    metricName: req.metricName,
    route: metricConfig.route,
    method: metricConfig.method,
    minimumCount: metricConfig.minimumCount,
    maxEvidenceAgeMs: metricConfig.maxEvidenceAgeMs
  };

  const finding = evaluateRequestMetricRequirement({
    requirement: requestRequirement,
    evidence: telemetryEvidence,
    evaluatedAt: evaluatedAt.toISOString()
  });

  return {
    ...base,
    outcome: finding.outcome,
    expected: finding.expected,
    observed: finding.observed,
    reason: finding.reason
  };
}

function evaluateHealthGap(
  req: ExpectedHealthCheckRequirement,
  evidence: InspectorEvidence,
  maxHealthEvidenceAgeMs: number | undefined,
  evaluatedAt: Date
): GapFinding {
  const base = findingBase(healthGapRule, req.id, "health", evidence.provenance);
  const expected = `HTTP health endpoint ${req.endpoint} responds with a 2xx status.`;

  if (!evidence.available) {
    return {
      ...base,
      outcome: "unknown",
      expected,
      observed: "Health probe evidence is unavailable.",
      reason: "The health endpoint could not be reached or the probe was not configured."
    };
  }

  const data = evidence.data as HealthEvidenceData | undefined;

  if (data === undefined || data === null || typeof data.probeOutcome !== "string") {
    return {
      ...base,
      outcome: "inconclusive",
      expected,
      observed: "Health evidence data is missing or malformed.",
      reason: "Evidence is marked available but probe outcome data is absent."
    };
  }

  if (data.probeOutcome === "timeout") {
    return {
      ...base,
      outcome: "unknown",
      expected,
      observed: "Health probe timed out before receiving a response.",
      reason: "A timed-out probe cannot confirm pass or gap."
    };
  }

  if (data.probeOutcome === "error") {
    const isBodyLimitExceeded = evidence.diagnostics.some((d) => d.code === "RESPONSE_TOO_LARGE");
    return {
      ...base,
      outcome: isBodyLimitExceeded ? "inconclusive" : "unknown",
      expected,
      observed: isBodyLimitExceeded
        ? "Health probe response exceeded the configured body size limit."
        : "Health probe encountered a network or configuration error.",
      reason: isBodyLimitExceeded
        ? "The probe reached the server but could not read the full response body. Outcome cannot be determined."
        : "A probe error cannot confirm pass or gap."
    };
  }

  // For healthy and unhealthy outcomes, verify freshness before issuing a verdict
  const collectedAtMs = Date.parse(evidence.collectedAt);
  if (!Number.isFinite(collectedAtMs)) {
    return {
      ...base,
      outcome: "inconclusive",
      expected,
      observed: `Evidence collectedAt timestamp is unparseable: ${evidence.collectedAt}.`,
      reason: "Evidence freshness cannot be verified without a valid collectedAt timestamp."
    };
  }

  if (maxHealthEvidenceAgeMs === undefined) {
    return {
      ...base,
      outcome: "inconclusive",
      expected,
      observed: `Health probe returned '${data.probeOutcome}' but freshness cannot be verified.`,
      reason:
        "GapEngineConfig.maxHealthEvidenceAgeMs is not set. " +
        "Configure it to enable pass and gap verdicts for health requirements."
    };
  }

  const ageMs = evaluatedAt.getTime() - collectedAtMs;
  if (ageMs < 0 || ageMs > maxHealthEvidenceAgeMs) {
    return {
      ...base,
      outcome: "inconclusive",
      expected,
      observed: `Evidence age is ${ageMs}ms, exceeding maxHealthEvidenceAgeMs of ${maxHealthEvidenceAgeMs}ms.`,
      reason: "Stale health probe evidence cannot support a reliable verdict."
    };
  }

  if (!evidence.complete) {
    return {
      ...base,
      outcome: "unknown",
      expected,
      observed: "Health probe evidence is incomplete.",
      reason: "Incomplete health probe evidence cannot confirm pass or gap."
    };
  }

  if (data.probeOutcome === "healthy") {
    return {
      ...base,
      outcome: "pass",
      expected,
      observed: `Health probe returned HTTP ${data.statusCode ?? "?"} (healthy) in ${data.latencyMs ?? "?"}ms.`,
      reason: "Fresh HTTP probe confirms the health endpoint responds with a 2xx status."
    };
  }

  if (data.probeOutcome === "unhealthy") {
    return {
      ...base,
      outcome: "gap",
      expected,
      observed: `Health probe returned HTTP ${data.statusCode ?? "?"} (unhealthy).`,
      reason:
        "Fresh, complete HTTP probe confirms the health endpoint did not return a 2xx status. " +
        "This is a confirmed gap."
    };
  }

  return {
    ...base,
    outcome: "inconclusive",
    expected,
    observed: `Unrecognized health probe outcome: ${String(data.probeOutcome)}.`,
    reason: "Probe outcome is not recognized by the health gap rule."
  };
}

function evaluateUnconfiguredSignalGap(
  req: ExpectedLogRequirement | ExpectedTraceRequirement | ExpectedAlertRequirement,
  evidence: InspectorEvidence,
  rule: GapRuleMetadata
): GapFinding {
  const signal = req.signal as InspectorSignal;
  const label = signal.charAt(0).toUpperCase() + signal.slice(1);
  const base = findingBase(rule, req.id, signal, evidence.provenance);
  const expected = `${label} backend adapter is configured and returns observable evidence.`;

  if (!evidence.available) {
    const hasUnconfiguredDiagnostic = evidence.diagnostics.some(
      (d) => d.code === "BACKEND_UNCONFIGURED"
    );
    return {
      ...base,
      outcome: "unknown",
      expected,
      observed: hasUnconfiguredDiagnostic
        ? `${label} backend adapter is not configured in this environment.`
        : `${label} evidence is unavailable.`,
      reason: hasUnconfiguredDiagnostic
        ? `No ${signal} backend is integrated in Phase 04. Configure a backend adapter to enable evaluation.`
        : `${label} evidence is unavailable. The backend may not be reachable.`
    };
  }

  // available=true is unexpected for an unconfigured signal — flag as inconclusive
  return {
    ...base,
    outcome: "inconclusive",
    expected,
    observed: `${label} evidence is marked available but no backend adapter is integrated.`,
    reason:
      "Unexpected evidence state for an unconfigured backend. Evidence may be fabricated or misrouted."
  };
}

function isLogEvidence(value: unknown): value is import("./inspectors").LogEvidenceData {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as import("./inspectors").LogEvidenceData;
  return (
    Number.isInteger(candidate.totalEntries) &&
    candidate.totalEntries >= 0 &&
    Number.isInteger(candidate.validJsonEntries) &&
    candidate.validJsonEntries >= 0 &&
    Array.isArray(candidate.observedFields) &&
    Array.isArray(candidate.missingFields)
  );
}

function evaluateLogGap(requirement: ExpectedLogRequirement, evidence: InspectorEvidence): GapFinding {
  const base = findingBase(logGapRule, requirement.id, "log", evidence.provenance);
  const expected = `Loki contains structured JSON logs with required fields: ${requirement.fields.join(", ") || "none"}.`;

  if (!evidence.available) {
    const hasUnconfiguredDiagnostic = evidence.diagnostics.some((d) => d.code === "BACKEND_UNCONFIGURED");
    return {
      ...base,
      outcome: "unknown",
      expected,
      observed: hasUnconfiguredDiagnostic
        ? "Log backend adapter is not configured in this environment."
        : "Loki log evidence is unavailable.",
      reason: hasUnconfiguredDiagnostic
        ? "No log backend is configured. Configure Loki to enable structured log verification."
        : "Missing Loki response cannot confirm whether structured logs are being ingested."
    };
  }

  if (!evidence.complete || !isLogEvidence(evidence.data)) {
    return {
      ...base,
      outcome: "inconclusive",
      expected,
      observed: "Loki returned incomplete or malformed log evidence.",
      reason: "Incomplete Loki log responses cannot support a pass or gap verdict."
    };
  }

  if (evidence.data.totalEntries === 0) {
    return {
      ...base,
      outcome: "gap",
      expected,
      observed: "Loki query returned 0 log entries in the lookback window.",
      reason: "A complete Loki query confirmed no logs were ingested for this service."
    };
  }

  if (evidence.data.validJsonEntries === 0 || evidence.data.missingFields.length > 0) {
    return {
      ...base,
      outcome: "gap",
      expected,
      observed:
        evidence.data.validJsonEntries === 0
          ? `Loki returned ${evidence.data.totalEntries} log entries, but none were valid structured JSON.`
          : `Loki logs are missing required field(s): ${evidence.data.missingFields.join(", ")}.`,
      reason: "Structured JSON log validation against required fields failed."
    };
  }

  return {
    ...base,
    outcome: "pass",
    expected,
    observed: `Loki returned ${evidence.data.validJsonEntries} valid structured JSON log(s) containing all required fields (${requirement.fields.join(", ")}).`,
    reason: "A complete Loki query confirmed structured JSON log ingestion with all required fields."
  };
}

function evaluateTraceGap(requirement: ExpectedTraceRequirement, evidence: InspectorEvidence): GapFinding {
  const base = findingBase(traceGapRule, requirement.id, "trace", evidence.provenance);
  const expected = `Jaeger contains at least one recent trace for service '${requirement.serviceName}'.`;
  if (!evidence.available) return {
    ...base, outcome: "unknown", expected,
    observed: evidence.diagnostics.some((item) => item.code === "BACKEND_UNCONFIGURED")
      ? "Jaeger trace backend is not configured." : "Jaeger trace evidence is unavailable.",
    reason: "Missing trace data cannot prove that the application failed to emit traces."
  };
  if (!evidence.complete || !isTraceEvidence(evidence.data)) return {
    ...base, outcome: "inconclusive", expected, observed: "Jaeger returned incomplete or malformed trace evidence.",
    reason: "Incomplete trace responses cannot support a pass or gap verdict."
  };
  if (evidence.data.serviceName !== requirement.serviceName) return {
    ...base, outcome: "inconclusive", expected,
    observed: `Jaeger response was correlated to '${evidence.data.serviceName}', not '${requirement.serviceName}'.`,
    reason: "Service identity mismatch prevents attributing traces to the expected application."
  };
  return evidence.data.traceCount > 0 ? {
    ...base, outcome: "pass", expected, observed: `Jaeger returned ${evidence.data.traceCount} trace(s) for '${requirement.serviceName}'.`,
    reason: "A complete Jaeger query confirmed recent trace data for the exact expected service name."
  } : {
    ...base, outcome: "gap", expected, observed: `Jaeger returned no traces for '${requirement.serviceName}' in the selected lookback window.`,
    reason: "A complete Jaeger query for the exact service name returned no traces during its lookback window."
  };
}

function isTraceEvidence(value: unknown): value is TraceEvidenceData {
  return typeof value === "object" && value !== null &&
    typeof (value as TraceEvidenceData).serviceName === "string" &&
    Number.isInteger((value as TraceEvidenceData).traceCount) && (value as TraceEvidenceData).traceCount >= 0;
}

function isAlertEvidence(value: unknown): value is AlertEvidenceData {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as AlertEvidenceData;
  return (
    Array.isArray(candidate.matchedRules) &&
    Number.isInteger(candidate.totalLoadedRules) &&
    candidate.totalLoadedRules >= 0 &&
    typeof candidate.ruleHealthy === "boolean"
  );
}

function evaluateAlertGap(requirement: ExpectedAlertRequirement, evidence: InspectorEvidence): GapFinding {
  const base = findingBase(alertGapRule, requirement.id, "alert", evidence.provenance);
  const expected = `Prometheus has a healthy loaded alerting rule matching requirement '${requirement.id}' (severity=${requirement.severity}).`;

  if (!evidence.available) {
    const hasUnconfiguredDiagnostic = evidence.diagnostics.some((d) => d.code === "BACKEND_UNCONFIGURED");
    return {
      ...base,
      outcome: "unknown",
      expected,
      observed: hasUnconfiguredDiagnostic
        ? "Alert backend adapter is not configured in this environment."
        : "Prometheus alert rules evidence is unavailable.",
      reason: hasUnconfiguredDiagnostic
        ? "No alert backend is configured. Configure Prometheus to enable alert rule verification."
        : "Missing Prometheus rules response cannot confirm whether the alerting rule is loaded."
    };
  }

  if (!evidence.complete || !isAlertEvidence(evidence.data)) {
    return {
      ...base,
      outcome: "inconclusive",
      expected,
      observed: "Prometheus returned incomplete or malformed alert rule evidence.",
      reason: "Incomplete alert rule responses cannot support a pass or gap verdict."
    };
  }

  if (evidence.data.matchedRules.length === 0) {
    return {
      ...base,
      outcome: "gap",
      expected,
      observed: `Prometheus loaded ${evidence.data.totalLoadedRules} alerting rule(s), but none match '${requirement.id}'.`,
      reason: "A complete Prometheus /api/v1/rules query confirmed no matching alerting rule is loaded."
    };
  }

  if (!evidence.data.ruleHealthy) {
    const names = evidence.data.matchedRules.map((r) => `${r.name}(health=${r.health})`).join(", ");
    return {
      ...base,
      outcome: "gap",
      expected,
      observed: `Matching Prometheus alerting rule(s) reported unhealthy evaluation: ${names}.`,
      reason: "Prometheus /api/v1/rules reported an evaluation error for the matching alerting rule."
    };
  }

  const firingCount = evidence.data.firingAlertCount ?? evidence.data.matchedRules.reduce((sum, r) => sum + (r.activeAlerts ?? 0), 0);
  const summary = evidence.data.matchedRules
    .map((r) => `${r.name}(state=${r.state},health=${r.health},firing=${r.activeAlerts ?? 0})`)
    .join(", ");
  return {
    ...base,
    outcome: "pass",
    expected,
    observed: `Prometheus loaded ${evidence.data.matchedRules.length} healthy alerting rule(s) (${firingCount} firing): ${summary}.`,
    reason:
      firingCount > 0
        ? "Prometheus /api/v1/rules confirmed the alerting rule is loaded, healthy, and currently firing."
        : "Prometheus /api/v1/rules confirmed the alerting rule is loaded and evaluating cleanly (inactive)."
  };
}

// ─── Private helpers ───────────────────────────────────────────────────────────

function findingBase(
  rule: GapRuleMetadata,
  requirementId: string,
  signal: InspectorSignal,
  provenance: InspectorProvenance
): Omit<GapFinding, "outcome" | "expected" | "observed" | "reason"> {
  return {
    id: `${rule.id}:${rule.version}:${requirementId}`,
    rule,
    requirementId,
    signal,
    evidenceProvenance: provenance
  };
}

function metricExpectedDescription(req: ExpectedMetricRequirement): string {
  const dims = req.dimensions.length > 0 ? req.dimensions.join(", ") : "none";
  return `Metric ${req.metricName} is present with required dimensions: ${dims}.`;
}

function isValidMetricConfig(config: MetricEvaluationConfig): boolean {
  return (
    typeof config.serviceName === "string" &&
    config.serviceName.trim().length > 0 &&
    typeof config.route === "string" &&
    config.route.trim().length > 0 &&
    Number.isFinite(config.minimumCount) &&
    config.minimumCount >= 0 &&
    Number.isFinite(config.maxEvidenceAgeMs) &&
    config.maxEvidenceAgeMs >= 0
  );
}

function ruleForSignal(signal: string): GapRuleMetadata {
  switch (signal) {
    case "metric": return metricGapRule;
    case "health": return healthGapRule;
    case "log": return logGapRule;
    case "trace": return traceGapRule;
    case "alert": return alertGapRule;
    default: return { id: "CP-RULE-OBS-GAP-UNKNOWN", version: "1.0.0" };
  }
}

function buildNoEvidenceFinding(requirement: ExpectedRequirement): GapFinding {
  const rule = ruleForSignal(requirement.signal);
  return {
    id: `${rule.id}:${rule.version}:${requirement.id}`,
    rule,
    requirementId: requirement.id,
    signal: requirement.signal,
    outcome: "unknown",
    expected: `Evidence for ${requirement.signal} requirement ${requirement.id}.`,
    observed: "No evidence was provided for this requirement.",
    reason:
      "Collect inspector evidence and supply it to the gap engine before evaluation can proceed.",
    evidenceProvenance: { target: "<no-evidence>", adapter: "none" }
  };
}

function buildAmbiguousEvidenceFinding(
  requirement: ExpectedRequirement,
  evidenceList: InspectorEvidence[]
): GapFinding {
  const rule = ruleForSignal(requirement.signal);
  return {
    id: `${rule.id}:${rule.version}:${requirement.id}`,
    rule,
    requirementId: requirement.id,
    signal: requirement.signal,
    outcome: "inconclusive",
    expected: `Exactly one evidence entry for requirement ${requirement.id}.`,
    observed: `${evidenceList.length} evidence entries map to requirement ${requirement.id}.`,
    reason:
      "Ambiguous evidence mapping. Deduplicate so exactly one InspectorEvidence per " +
      "requirementId is passed to evaluateExpectedObservabilityModel.",
    evidenceProvenance: evidenceList[0].provenance
  };
}
