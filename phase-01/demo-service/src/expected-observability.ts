export type ExpectedObservabilityStatus = "valid" | "invalid" | "unsupported";
export type ExpectedObservabilityDiagnosticSeverity = "error";
export type ExpectedObservabilityDiagnosticCode =
  | "DUPLICATE_REQUIREMENT_ID"
  | "INVALID_FIELD"
  | "MALFORMED_INPUT"
  | "MISSING_FIELD"
  | "UNSUPPORTED_FIELD"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "UNSUPPORTED_VALUE";

export type ObservabilitySignal = "metric" | "log" | "trace" | "health" | "alert";
export type HealthCheckKind = "http";
export type AlertSignal = "metric" | "log" | "trace" | "health";
export type AlertSeverity = "warning" | "critical";

export interface ExpectedObservabilityDocument {
  schemaVersion: "cloudpilot.expected-observability.v1";
  serviceId: string;
  requirements: {
    metrics: ExpectedMetricRequirement[];
    logs: ExpectedLogRequirement[];
    traces: ExpectedTraceRequirement[];
    healthChecks: ExpectedHealthCheckRequirement[];
    alerts: ExpectedAlertRequirement[];
  };
}

export interface ExpectedMetricRequirement {
  id: string;
  signal: "metric";
  metricName: string;
  dimensions: string[];
}

export interface ExpectedLogRequirement {
  id: string;
  signal: "log";
  fields: string[];
}

export interface ExpectedTraceRequirement {
  id: string;
  signal: "trace";
  serviceName: string;
}

export interface ExpectedHealthCheckRequirement {
  id: string;
  signal: "health";
  kind: HealthCheckKind;
  endpoint: string;
}

export interface ExpectedAlertRequirement {
  id: string;
  signal: "alert";
  associatedSignal: AlertSignal;
  condition: string;
  severity: AlertSeverity;
}

export type ExpectedRequirement =
  | ExpectedMetricRequirement
  | ExpectedLogRequirement
  | ExpectedTraceRequirement
  | ExpectedHealthCheckRequirement
  | ExpectedAlertRequirement;

export interface ExpectedObservabilityModel {
  schemaVersion: "cloudpilot.expected-observability.v1";
  serviceId: string;
  requirements: ExpectedRequirement[];
}

export interface ExpectedObservabilityDiagnostic {
  code: ExpectedObservabilityDiagnosticCode;
  severity: ExpectedObservabilityDiagnosticSeverity;
  message: string;
  path: string;
}

export interface ExpectedObservabilityResult {
  status: ExpectedObservabilityStatus;
  model?: ExpectedObservabilityModel;
  diagnostics: ExpectedObservabilityDiagnostic[];
}

const SUPPORTED_SCHEMA_VERSION = "cloudpilot.expected-observability.v1";
const REQUIRED_REQUIREMENT_GROUPS = ["metrics", "logs", "traces", "healthChecks", "alerts"] as const;
const TOP_LEVEL_KEYS = new Set(["schemaVersion", "serviceId", "requirements"]);
const REQUIREMENTS_KEYS = new Set(REQUIRED_REQUIREMENT_GROUPS);
const METRIC_KEYS = new Set(["id", "signal", "metricName", "dimensions"]);
const LOG_KEYS = new Set(["id", "signal", "fields"]);
const TRACE_KEYS = new Set(["id", "signal", "serviceName"]);
const HEALTH_KEYS = new Set(["id", "signal", "kind", "endpoint"]);
const ALERT_KEYS = new Set(["id", "signal", "associatedSignal", "condition", "severity"]);
const ALERT_SIGNALS = new Set<AlertSignal>(["metric", "log", "trace", "health"]);
const ALERT_SEVERITIES = new Set<AlertSeverity>(["warning", "critical"]);

export function normalizeExpectedObservability(input: unknown): ExpectedObservabilityResult {
  const diagnostics: ExpectedObservabilityDiagnostic[] = [];

  if (!isObject(input)) {
    return result("invalid", undefined, [{
      code: "MALFORMED_INPUT",
      severity: "error",
      message: "Expected observability input must be an object.",
      path: "$"
    }]);
  }

  validateAllowedKeys(input, TOP_LEVEL_KEYS, "$", diagnostics);

  if (!isNonEmptyString(input.schemaVersion)) {
    diagnostics.push(missingField("$.schemaVersion", "schemaVersion must be a non-empty string."));
  } else if (input.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    diagnostics.push({
      code: "UNSUPPORTED_SCHEMA_VERSION",
      severity: "error",
      message: `Unsupported schemaVersion ${input.schemaVersion}.`,
      path: "$.schemaVersion"
    });

    return result("unsupported", undefined, diagnostics);
  }

  if (!isNonEmptyString(input.serviceId)) {
    diagnostics.push(missingField("$.serviceId", "serviceId must be a non-empty string."));
  }

  let canValidateGroups = true;

  if (!isObject(input.requirements)) {
    diagnostics.push(missingField("$.requirements", "requirements must be an object."));
    canValidateGroups = false;
  } else {
    validateAllowedKeys(input.requirements, REQUIREMENTS_KEYS, "$.requirements", diagnostics);

    for (const group of REQUIRED_REQUIREMENT_GROUPS) {
      if (!Array.isArray(input.requirements[group])) {
        diagnostics.push(missingField(`$.requirements.${group}`, `${group} must be an array.`));
        canValidateGroups = false;
      }
    }
  }

  if (!canValidateGroups) {
    return result("invalid", undefined, diagnostics);
  }

  const requirementGroups = input.requirements as Record<typeof REQUIRED_REQUIREMENT_GROUPS[number], unknown[]>;
  const requirements = [
    ...normalizeMetrics(requirementGroups.metrics, diagnostics),
    ...normalizeLogs(requirementGroups.logs, diagnostics),
    ...normalizeTraces(requirementGroups.traces, diagnostics),
    ...normalizeHealthChecks(requirementGroups.healthChecks, diagnostics),
    ...normalizeAlerts(requirementGroups.alerts, diagnostics)
  ];

  detectDuplicateRequirementIds(requirements, diagnostics);

  if (diagnostics.length > 0) {
    return result("invalid", undefined, diagnostics);
  }

  requirements.sort((left, right) => left.id.localeCompare(right.id));

  return result("valid", {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    serviceId: input.serviceId as string,
    requirements
  }, diagnostics);
}

function normalizeMetrics(values: unknown[], diagnostics: ExpectedObservabilityDiagnostic[]): ExpectedMetricRequirement[] {
  return values.flatMap((value, index) => {
    const path = `$.requirements.metrics[${index}]`;

    if (!isObject(value)) {
      diagnostics.push(invalidField(path, "Metric requirement must be an object."));
      return [];
    }

    validateAllowedKeys(value, METRIC_KEYS, path, diagnostics);
    validateSignal(value.signal, "metric", `${path}.signal`, diagnostics);
    validateNonEmptyString(value.id, `${path}.id`, "Metric id must be a non-empty string.", diagnostics);
    validateNonEmptyString(value.metricName, `${path}.metricName`, "metricName must be a non-empty string.", diagnostics);
    validateStringArray(value.dimensions, `${path}.dimensions`, "dimensions must be an array of non-empty strings.", diagnostics);

    if (hasDiagnosticsForPath(path, diagnostics)) {
      return [];
    }

    const id = value.id as string;
    const metricName = value.metricName as string;
    const dimensions = value.dimensions as string[];

    return [{
      id,
      signal: "metric",
      metricName,
      dimensions: sortedUnique(dimensions)
    }];
  });
}

function normalizeLogs(values: unknown[], diagnostics: ExpectedObservabilityDiagnostic[]): ExpectedLogRequirement[] {
  return values.flatMap((value, index) => {
    const path = `$.requirements.logs[${index}]`;

    if (!isObject(value)) {
      diagnostics.push(invalidField(path, "Log requirement must be an object."));
      return [];
    }

    validateAllowedKeys(value, LOG_KEYS, path, diagnostics);
    validateSignal(value.signal, "log", `${path}.signal`, diagnostics);
    validateNonEmptyString(value.id, `${path}.id`, "Log id must be a non-empty string.", diagnostics);
    validateStringArray(value.fields, `${path}.fields`, "fields must be an array of non-empty strings.", diagnostics);

    if (hasDiagnosticsForPath(path, diagnostics)) {
      return [];
    }

    const id = value.id as string;
    const fields = value.fields as string[];

    return [{
      id,
      signal: "log",
      fields: sortedUnique(fields)
    }];
  });
}

function normalizeTraces(values: unknown[], diagnostics: ExpectedObservabilityDiagnostic[]): ExpectedTraceRequirement[] {
  return values.flatMap((value, index) => {
    const path = `$.requirements.traces[${index}]`;

    if (!isObject(value)) {
      diagnostics.push(invalidField(path, "Trace requirement must be an object."));
      return [];
    }

    validateAllowedKeys(value, TRACE_KEYS, path, diagnostics);
    validateSignal(value.signal, "trace", `${path}.signal`, diagnostics);
    validateNonEmptyString(value.id, `${path}.id`, "Trace id must be a non-empty string.", diagnostics);
    validateNonEmptyString(value.serviceName, `${path}.serviceName`, "serviceName must be a non-empty string.", diagnostics);

    if (hasDiagnosticsForPath(path, diagnostics)) {
      return [];
    }

    const id = value.id as string;
    const serviceName = value.serviceName as string;

    return [{
      id,
      signal: "trace",
      serviceName
    }];
  });
}

function normalizeHealthChecks(values: unknown[], diagnostics: ExpectedObservabilityDiagnostic[]): ExpectedHealthCheckRequirement[] {
  return values.flatMap((value, index) => {
    const path = `$.requirements.healthChecks[${index}]`;

    if (!isObject(value)) {
      diagnostics.push(invalidField(path, "Health check requirement must be an object."));
      return [];
    }

    validateAllowedKeys(value, HEALTH_KEYS, path, diagnostics);
    validateSignal(value.signal, "health", `${path}.signal`, diagnostics);
    validateNonEmptyString(value.id, `${path}.id`, "Health check id must be a non-empty string.", diagnostics);
    validateNonEmptyString(value.endpoint, `${path}.endpoint`, "endpoint must be a non-empty string.", diagnostics);

    if (value.kind !== "http") {
      diagnostics.push(unsupportedValue(`${path}.kind`, "Only http health checks are supported in this schema version."));
    }

    if (hasDiagnosticsForPath(path, diagnostics)) {
      return [];
    }

    const id = value.id as string;
    const endpoint = value.endpoint as string;

    return [{
      id,
      signal: "health",
      kind: "http",
      endpoint
    }];
  });
}

function normalizeAlerts(values: unknown[], diagnostics: ExpectedObservabilityDiagnostic[]): ExpectedAlertRequirement[] {
  return values.flatMap((value, index) => {
    const path = `$.requirements.alerts[${index}]`;

    if (!isObject(value)) {
      diagnostics.push(invalidField(path, "Alert requirement must be an object."));
      return [];
    }

    validateAllowedKeys(value, ALERT_KEYS, path, diagnostics);
    validateSignal(value.signal, "alert", `${path}.signal`, diagnostics);
    validateNonEmptyString(value.id, `${path}.id`, "Alert id must be a non-empty string.", diagnostics);
    validateNonEmptyString(value.condition, `${path}.condition`, "condition must be a non-empty string.", diagnostics);

    if (!ALERT_SIGNALS.has(value.associatedSignal as AlertSignal)) {
      diagnostics.push(unsupportedValue(`${path}.associatedSignal`, "associatedSignal must be metric, log, trace or health."));
    }

    if (!ALERT_SEVERITIES.has(value.severity as AlertSeverity)) {
      diagnostics.push(unsupportedValue(`${path}.severity`, "severity must be warning or critical."));
    }

    if (hasDiagnosticsForPath(path, diagnostics)) {
      return [];
    }

    const id = value.id as string;
    const associatedSignal = value.associatedSignal as AlertSignal;
    const condition = value.condition as string;
    const severity = value.severity as AlertSeverity;

    return [{
      id,
      signal: "alert",
      associatedSignal,
      condition,
      severity
    }];
  });
}

function validateAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: Set<string> | readonly string[],
  path: string,
  diagnostics: ExpectedObservabilityDiagnostic[]
): void {
  const allowed = allowedKeys instanceof Set ? allowedKeys : new Set(allowedKeys);

  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      diagnostics.push({
        code: "UNSUPPORTED_FIELD",
        severity: "error",
        message: `Field ${key} is not supported here.`,
        path: `${path}.${key}`
      });
    }
  }
}

function validateSignal(
  value: unknown,
  expectedSignal: ObservabilitySignal,
  path: string,
  diagnostics: ExpectedObservabilityDiagnostic[]
): void {
  if (value !== expectedSignal) {
    diagnostics.push(unsupportedValue(path, `signal must be ${expectedSignal}.`));
  }
}

function validateNonEmptyString(value: unknown, path: string, message: string, diagnostics: ExpectedObservabilityDiagnostic[]): void {
  if (!isNonEmptyString(value)) {
    diagnostics.push(invalidField(path, message));
  }
}

function validateStringArray(value: unknown, path: string, message: string, diagnostics: ExpectedObservabilityDiagnostic[]): void {
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
    diagnostics.push(invalidField(path, message));
  }
}

function detectDuplicateRequirementIds(requirements: ExpectedRequirement[], diagnostics: ExpectedObservabilityDiagnostic[]): void {
  const ids = new Set<string>();

  for (const requirement of requirements) {
    if (ids.has(requirement.id)) {
      diagnostics.push({
        code: "DUPLICATE_REQUIREMENT_ID",
        severity: "error",
        message: `Duplicate requirement id ${requirement.id}.`,
        path: `$.requirements.${requirement.id}`
      });
    }

    ids.add(requirement.id);
  }
}

function result(
  status: ExpectedObservabilityStatus,
  model: ExpectedObservabilityModel | undefined,
  diagnostics: ExpectedObservabilityDiagnostic[]
): ExpectedObservabilityResult {
  return model === undefined
    ? { status, diagnostics }
    : { status, model, diagnostics };
}

function hasDiagnosticsForPath(path: string, diagnostics: ExpectedObservabilityDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.path === path || diagnostic.path.startsWith(`${path}.`));
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function missingField(path: string, message: string): ExpectedObservabilityDiagnostic {
  return {
    code: "MISSING_FIELD",
    severity: "error",
    message,
    path
  };
}

function invalidField(path: string, message: string): ExpectedObservabilityDiagnostic {
  return {
    code: "INVALID_FIELD",
    severity: "error",
    message,
    path
  };
}

function unsupportedValue(path: string, message: string): ExpectedObservabilityDiagnostic {
  return {
    code: "UNSUPPORTED_VALUE",
    severity: "error",
    message,
    path
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
