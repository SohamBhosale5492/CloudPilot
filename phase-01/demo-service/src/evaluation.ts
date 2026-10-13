export type EvaluationOutcome = "pass" | "gap" | "unknown" | "inconclusive";

export interface RequestMetricRequirement {
  id: string;
  serviceName: string;
  metricName: string;
  route: string;
  method?: string;
  minimumCount: number;
  maxEvidenceAgeMs: number;
}

export interface MetricSample {
  metricName: string;
  labels: {
    serviceName: string;
    route: string;
    method?: string;
    statusCode?: string;
  };
  /**
   * Count for this distinct metric time series over the evidence collection
   * window. All samples in one TelemetryEvidence object represent the same
   * collection window. Distinct series have disjoint counts and may be summed;
   * duplicate observations of one series are not additive. Prometheus evidence
   * must be normalized from a compatible range calculation such as increase()
   * before entering this evaluator.
   */
  value: number;
}

export interface TelemetryEvidence {
  source: "synthetic-fixture" | "prometheus";
  collectedAt: string;
  available: boolean;
  complete: boolean;
  samples: MetricSample[];
}

export interface EvaluationInput {
  requirement: RequestMetricRequirement;
  evidence?: TelemetryEvidence;
  evaluatedAt: string;
}

export interface RuleMetadata {
  id: string;
  version: string;
}

export interface Finding {
  id: string;
  rule: RuleMetadata;
  requirementId: string;
  outcome: EvaluationOutcome;
  expected: string;
  observed: string;
  reason: string;
}

export const requestMetricPresenceRule: RuleMetadata = {
  id: "CP-RULE-OBS-REQ-REQUEST-METRIC-PRESENT",
  version: "1.0.0"
};

export function evaluateRequestMetricRequirement(input: EvaluationInput): Finding {
  if (!isObject(input)) {
    return safeInconclusiveFinding(
      "Evaluator input is malformed.",
      "Input must be an object containing a requirement and evaluation timestamp."
    );
  }

  const { requirement, evidence } = input;
  const requirementId = isNonEmptyString(requirement?.id) ? requirement.id : "<invalid-requirement>";
  const expected = isValidRequirementShape(requirement)
    ? `${requirement.metricName} for service=${requirement.serviceName}, route=${requirement.route}` +
      `${requirement.method ? `, method=${requirement.method}` : ""} with value >= ${requirement.minimumCount}`
    : "Valid request metric requirement with non-empty id, serviceName, metricName and route.";

  const baseFinding = {
    id: `${requestMetricPresenceRule.id}:${requestMetricPresenceRule.version}:${requirementId}`,
    rule: requestMetricPresenceRule,
    requirementId,
    expected
  };

  if (!isValidRequirementShape(requirement)) {
    return {
      ...baseFinding,
      outcome: "inconclusive",
      observed: "Requirement is missing required non-empty string fields.",
      reason: "Requirement id, serviceName, metricName and route must be non-empty strings."
    };
  }

  if (requirement.method !== undefined && !isNonEmptyString(requirement.method)) {
    return {
      ...baseFinding,
      outcome: "inconclusive",
      observed: `method=${String(requirement.method)}`,
      reason: "Requirement method must be omitted or a non-empty string."
    };
  }

  if (!Number.isFinite(requirement.minimumCount) || requirement.minimumCount < 0) {
    return {
      ...baseFinding,
      outcome: "inconclusive",
      observed: `minimumCount=${requirement.minimumCount}`,
      reason: "Requirement minimumCount must be a non-negative finite number."
    };
  }

  if (!Number.isFinite(requirement.maxEvidenceAgeMs) || requirement.maxEvidenceAgeMs < 0) {
    return {
      ...baseFinding,
      outcome: "inconclusive",
      observed: `maxEvidenceAgeMs=${requirement.maxEvidenceAgeMs}`,
      reason: "Requirement maxEvidenceAgeMs must be a non-negative finite number."
    };
  }

  if (!evidence) {
    return {
      ...baseFinding,
      outcome: "unknown",
      observed: "Telemetry evidence is unavailable.",
      reason: "The requirement cannot be evaluated without telemetry evidence."
    };
  }

  if (!isObject(evidence) || !isSupportedEvidenceSource(evidence.source)) {
    return {
      ...baseFinding,
      outcome: "inconclusive",
      observed: "Telemetry evidence source is unsupported or malformed.",
      reason: "Evidence source must be synthetic-fixture or prometheus."
    };
  }

  if (typeof evidence.available !== "boolean" || typeof evidence.complete !== "boolean" || !Array.isArray(evidence.samples)) {
    return {
      ...baseFinding,
      outcome: "inconclusive",
      observed: "Telemetry evidence shape is malformed.",
      reason: "Evidence must include boolean availability/completeness and a sample array."
    };
  }

  if (evidence.available === false) {
    return {
      ...baseFinding,
      outcome: "unknown",
      observed: "Telemetry evidence is unavailable.",
      reason: "The requirement cannot be evaluated without telemetry evidence."
    };
  }

  if (!evidence.complete) {
    return {
      ...baseFinding,
      outcome: "unknown",
      observed: "Telemetry evidence is incomplete.",
      reason: "Missing or partial telemetry is insufficient to prove pass or gap."
    };
  }

  if (!isNonEmptyString(input.evaluatedAt) || !isNonEmptyString(evidence.collectedAt)) {
    return {
      ...baseFinding,
      outcome: "inconclusive",
      observed: `evaluatedAt=${String(input.evaluatedAt)}, collectedAt=${String(evidence.collectedAt)}`,
      reason: "Evidence timestamps must be non-empty strings."
    };
  }

  const evaluatedAt = Date.parse(input.evaluatedAt);
  const collectedAt = Date.parse(evidence.collectedAt);

  if (!Number.isFinite(evaluatedAt) || !Number.isFinite(collectedAt)) {
    return {
      ...baseFinding,
      outcome: "inconclusive",
      observed: `evaluatedAt=${input.evaluatedAt}, collectedAt=${evidence.collectedAt}`,
      reason: "Evidence timestamps are invalid."
    };
  }

  const ageMs = evaluatedAt - collectedAt;

  if (ageMs < 0 || ageMs > requirement.maxEvidenceAgeMs) {
    return {
      ...baseFinding,
      outcome: "inconclusive",
      observed: `Evidence age is ${ageMs}ms with maxEvidenceAgeMs=${requirement.maxEvidenceAgeMs}.`,
      reason: "Evidence is outside the allowed observation window."
    };
  }

  if (evidence.samples.some((sample) => !isValidSampleShape(sample))) {
    return {
      ...baseFinding,
      outcome: "inconclusive",
      observed: "Telemetry evidence contains malformed metric samples or labels.",
      reason: "Malformed evidence cannot support a reliable verdict."
    };
  }

  if (evidence.samples.some((sample) => !Number.isFinite(sample.value) || sample.value < 0)) {
    return {
      ...baseFinding,
      outcome: "inconclusive",
      observed: "Telemetry evidence contains invalid metric values.",
      reason: "Every metric sample must have a finite, non-negative numeric value."
    };
  }

  const matchingSamples = evidence.samples.filter((sample) => matchesRequirement(sample, requirement));

  const distinctSeries = toDistinctSeries(matchingSamples);

  if (distinctSeries.conflict) {
    return {
      ...baseFinding,
      outcome: "inconclusive",
      observed: describeSamples(matchingSamples),
      reason: "Matching telemetry contains conflicting values for the same metric labels."
    };
  }

  const total = distinctSeries.samples.reduce((sum, sample) => sum + sample.value, 0);

  if (!Number.isFinite(total)) {
    return {
      ...baseFinding,
      outcome: "inconclusive",
      observed: describeSamples(distinctSeries.samples),
      reason: "Aggregated metric value is not finite."
    };
  }

  if (total >= requirement.minimumCount) {
    return {
      ...baseFinding,
      outcome: "pass",
      observed: `Found ${distinctSeries.samples.length} distinct matching series with aggregate value ${total}.`,
      reason: "Sufficient evidence proves the request metric requirement is satisfied."
    };
  }

  return {
    ...baseFinding,
    outcome: "gap",
    observed: distinctSeries.samples.length === 0
      ? "No matching metric samples were present in complete telemetry evidence."
      : `Found ${distinctSeries.samples.length} distinct matching series with aggregate value ${total}.`,
    reason: "Complete telemetry evidence proves the required request metric condition is violated."
  };
}

function isValidRequirementShape(requirement: RequestMetricRequirement): boolean {
  return isNonEmptyString(requirement?.id) &&
    isNonEmptyString(requirement.serviceName) &&
    isNonEmptyString(requirement.metricName) &&
    isNonEmptyString(requirement.route);
}

function safeInconclusiveFinding(observed: string, reason: string): Finding {
  return {
    id: `${requestMetricPresenceRule.id}:${requestMetricPresenceRule.version}:<invalid-input>`,
    rule: requestMetricPresenceRule,
    requirementId: "<invalid-input>",
    outcome: "inconclusive",
    expected: "Valid evaluator input.",
    observed,
    reason
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSupportedEvidenceSource(value: unknown): value is TelemetryEvidence["source"] {
  return value === "synthetic-fixture" || value === "prometheus";
}

function isValidSampleShape(sample: MetricSample): boolean {
  return isNonEmptyString(sample?.metricName) &&
    isObject(sample.labels) &&
    hasOnlySupportedLabelKeys(sample.labels) &&
    isNonEmptyString(sample.labels.serviceName) &&
    isNonEmptyString(sample.labels.route) &&
    (sample.labels.method === undefined || isNonEmptyString(sample.labels.method)) &&
    (sample.labels.statusCode === undefined || isNonEmptyString(sample.labels.statusCode)) &&
    typeof sample.value === "number";
}

function hasOnlySupportedLabelKeys(labels: Record<string, unknown>): boolean {
  const supportedKeys = new Set(["serviceName", "route", "method", "statusCode"]);

  return Object.keys(labels).every((key) => supportedKeys.has(key));
}

function matchesRequirement(sample: MetricSample, requirement: RequestMetricRequirement): boolean {
  return sample.metricName === requirement.metricName &&
    sample.labels.serviceName === requirement.serviceName &&
    sample.labels.route === requirement.route &&
    (requirement.method === undefined || sample.labels.method === requirement.method);
}

function toDistinctSeries(samples: MetricSample[]): { samples: MetricSample[]; conflict: boolean } {
  const samplesByKey = new Map<string, MetricSample>();

  for (const sample of samples) {
    const key = seriesIdentity(sample);
    const priorSample = samplesByKey.get(key);

    if (priorSample !== undefined && priorSample.value !== sample.value) {
      return { samples: Array.from(samplesByKey.values()), conflict: true };
    }

    samplesByKey.set(key, sample);
  }

  return { samples: Array.from(samplesByKey.values()), conflict: false };
}

function seriesIdentity(sample: MetricSample): string {
  return JSON.stringify({
    metricName: sample.metricName,
    labels: {
      serviceName: sample.labels.serviceName,
      route: sample.labels.route,
      method: sample.labels.method ?? null,
      statusCode: sample.labels.statusCode ?? null
    }
  });
}

function describeSamples(samples: MetricSample[]): string {
  if (samples.length === 0) {
    return "No matching metric samples.";
  }

  return samples
    .map((sample) => `${sample.metricName}{serviceName="${sample.labels.serviceName}",route="${sample.labels.route}",method="${sample.labels.method || ""}",statusCode="${sample.labels.statusCode || ""}"}=${sample.value}`)
    .join("; ");
}
