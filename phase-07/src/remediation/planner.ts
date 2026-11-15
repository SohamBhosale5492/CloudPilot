/**
 * RemediationPlanner — generates minimal, allowlisted patches from gap findings.
 *
 * Design constraints (D-002, D-003):
 *  - Deterministic: same finding always produces the same patch.
 *  - Minimal: only the narrowest safe change for the identified gap.
 *  - Allowlisted: only known signal types and rule IDs produce patches.
 *    Unknown signals return null (no patch generated).
 *  - No arbitrary command execution or file system access.
 *  - Path traversal prevention on any path embedded in patch output.
 *
 * A patch is a structured description of what file to change and how.
 * The planner does NOT apply the patch; GitHubConnector does.
 */

export type PatchSignal = "metric" | "health" | "log" | "trace" | "alert";

export interface FindingSummary {
  requirementId: string;
  ruleId: string;
  ruleVersion: string;
  signal: PatchSignal | string;
  outcome: string;
  expected: string;
  observed: string;
  reason: string;
  evidenceJson?: unknown;
}

export interface MetricSelectorLabels {
  service: string;
  route: string;
  method?: string;
}

export interface ResolvedMetricTarget {
  metricName: string;
  labels?: MetricSelectorLabels;
}

export interface RemediationPatch {
  /** Versioned deterministic planner identity used by persisted execution artifacts. */
  plannerVersion: "phase07-planner-v1";
  /** Repository-relative file path to modify. */
  filePath: string;
  /** Canonical initial file content used only when the trusted snapshot says the file is absent. */
  initialFileContent: string;
  /** Human-readable title for the PR. */
  prTitle: string;
  /** Markdown body explaining the gap and the change. */
  prBody: string;
  /** Commit message for the file update. */
  commitMessage: string;
  /** Summary stored in the DB patch_summary column. */
  summary: string;
  /**
   * A pure transformer: given the current file content,
   * returns the patched file content.
   * Idempotent: applying twice produces the same output.
   */
  applyPatch(currentContent: string): string;
}

import YAML from "yaml";

export class UnsupportedFindingError extends Error {
  constructor(public readonly ruleId: string, public readonly signal: string) {
    super(`No remediation patch available for rule '${ruleId}' (signal: ${signal}).`);
    this.name = "UnsupportedFindingError";
  }
}

export class MalformedYamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedYamlError";
  }
}

export class UnsupportedYamlStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedYamlStructureError";
  }
}

// ── Path safety ──────────────────────────────────────────────────────────────

const SAFE_PATH_RE = /^[a-zA-Z0-9_.\/\-]+$/;

function assertSafePatchPath(path: string): void {
  if (!path || path.length > 256 || !SAFE_PATH_RE.test(path)) {
    throw new Error(`Unsafe patch file path: '${path}'.`);
  }
  if (path.includes("..") || path.startsWith("/")) {
    throw new Error(`Patch path must not traverse directories or be absolute: '${path}'.`);
  }
}

// ── Patch helpers ─────────────────────────────────────────────────────────────

/**
 * Structural YAML manipulation using AST: inserts or appends an item to the
 * specified sequence (`topKey`) within a mapping or top-level sequence.
 *
 * Preserves unrelated configuration, comments, and structure.
 * Idempotent: does not insert duplicates if `itemKey: itemValue` (and any `extraFields`) is already present.
 * Fails safely on malformed YAML or unsupported document structures.
 * Validates the output YAML before returning.
 */
export function patchObservabilityYaml(
  content: string,
  topKey: string,
  itemKey: string,
  itemValue: string,
  comment?: string,
  extraFields?: Record<string, unknown>
): string {
  const trimmed = content.trim();
  const doc = trimmed.length === 0 ? new YAML.Document({}) : YAML.parseDocument(content);

  if (doc.errors.length > 0) {
    throw new MalformedYamlError(`Malformed YAML document: ${doc.errors[0].message}`);
  }

  if (!doc.contents) {
    doc.contents = doc.createNode({});
  }

  let seq: YAML.YAMLSeq | undefined;

  if (YAML.isSeq(doc.contents)) {
    seq = doc.contents as YAML.YAMLSeq;
  } else if (YAML.isMap(doc.contents)) {
    const map = doc.contents as YAML.YAMLMap;
    const existing = map.get(topKey, true);

    if (existing === undefined || existing === null) {
      seq = doc.createNode([]) as YAML.YAMLSeq;
      map.set(topKey, seq);
    } else if (YAML.isSeq(existing)) {
      seq = existing as YAML.YAMLSeq;
    } else {
      throw new UnsupportedYamlStructureError(
        `Unsupported YAML structure: property '${topKey}' must be a sequence, found ${typeof existing}.`
      );
    }
  } else {
    throw new UnsupportedYamlStructureError(
      "Unsupported YAML structure: document root must be a mapping or sequence."
    );
  }

  const normalizedExtraEntries = extraFields
    ? Object.entries(extraFields).filter(([, value]) => value !== undefined)
    : [];

  // Check for duplicate requirement
  for (const item of seq.items) {
    const json = item && typeof (item as any).toJSON === "function" ? (item as any).toJSON() : item;
    if (json && typeof json === "object" && json[itemKey] === itemValue) {
      const extraMatches = normalizedExtraEntries.every(
        ([key, value]) => JSON.stringify((json as Record<string, unknown>)[key] ?? null) === JSON.stringify(value ?? null)
      );
      if (extraMatches) {
        return content;
      }
    }
  }

  if (seq.flow) {
    seq.flow = false;
  }

  const itemPayload: Record<string, unknown> = { [itemKey]: itemValue };
  for (const [key, value] of normalizedExtraEntries) {
    itemPayload[key] = value;
  }

  const newItemNode = doc.createNode(itemPayload);
  if (comment) {
    newItemNode.comment = ` ${comment}`;
  }
  seq.items.push(newItemNode);

  const result = doc.toString();

  try {
    YAML.parse(result);
  } catch (err) {
    throw new MalformedYamlError(
      `Generated YAML failed validation: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return result;
}

// ── Metric evidence & expected specification parsing ─────────────────────────

const PROMETHEUS_METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const SAFE_SERVICE_NAME_RE = /^[a-zA-Z0-9._\-]+$/;
const SAFE_ROUTE_RE = /^\/[a-zA-Z0-9._\-\/:{}]*$/;
const ALLOWED_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const SERVICE_LABEL_ALIASES = ["service", "serviceName", "service_name", "exported_job"] as const;
const SERVICE_LABEL_ALIAS_SET = new Set<string>(SERVICE_LABEL_ALIASES);
const STRUCTURED_METRIC_RULE_IDS = new Set([
  "CP-RULE-OBS-GAP-METRIC-PRESENT",
  "CP-RULE-OBS-REQ-REQUEST-METRIC-PRESENT"
]);

function isValidMetricName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && PROMETHEUS_METRIC_NAME_RE.test(value);
}

function isValidServiceName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && SAFE_SERVICE_NAME_RE.test(value);
}

function isValidRoute(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    SAFE_ROUTE_RE.test(value) &&
    !value.includes("..") &&
    !value.includes("//")
  );
}

function isValidHttpMethod(value: unknown): value is string {
  return typeof value === "string" && ALLOWED_HTTP_METHODS.has(value);
}

function requiresHttpMethodSelector(finding: FindingSummary, metricName: string): boolean {
  return (
    finding.ruleId === "CP-RULE-OBS-REQ-REQUEST-METRIC-PRESENT" ||
    /request|http/i.test(finding.requirementId) ||
    /request|http/i.test(metricName)
  );
}

function parseExpectedMetricTarget(finding: FindingSummary): ResolvedMetricTarget | null {
  const expected = typeof finding.expected === "string" ? finding.expected.trim() : "";
  if (!expected) {
    return null;
  }

  if (expected.startsWith("Valid request metric requirement")) {
    throw new UnsupportedFindingError(finding.ruleId, finding.signal);
  }

  const structuredAttempt =
    expected.includes(" for ") ||
    /\b(?:service|serviceName|service_name|exported_job|route|method)=/.test(expected);

  const match = /^([^\s]+)\s+for\s+(.+?)\s+with\s+value\s*>=\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(expected);
  if (!match) {
    if (structuredAttempt) {
      throw new UnsupportedFindingError(finding.ruleId, finding.signal);
    }
    return null;
  }

  const [, rawMetricName, rawSelectors, rawMin] = match;
  const minimumCount = Number(rawMin);
  if (!isValidMetricName(rawMetricName) || !Number.isFinite(minimumCount) || minimumCount < 0) {
    throw new UnsupportedFindingError(finding.ruleId, finding.signal);
  }

  const selectorParts = rawSelectors.split(",").map((part) => part.trim());
  if (selectorParts.length === 0 || selectorParts.some((part) => part.length === 0)) {
    throw new UnsupportedFindingError(finding.ruleId, finding.signal);
  }

  const seenKeys = new Set<string>();
  let service: string | undefined;
  let route: string | undefined;
  let method: string | undefined;

  for (const part of selectorParts) {
    const kv = /^([a-zA-Z_][a-zA-Z0-9_]*)=([^\s,=]+)$/.exec(part);
    if (!kv) {
      throw new UnsupportedFindingError(finding.ruleId, finding.signal);
    }
    const [, key, value] = kv;
    if (seenKeys.has(key)) {
      throw new UnsupportedFindingError(finding.ruleId, finding.signal);
    }
    seenKeys.add(key);

    if (SERVICE_LABEL_ALIAS_SET.has(key)) {
      if (!isValidServiceName(value)) {
        throw new UnsupportedFindingError(finding.ruleId, finding.signal);
      }
      if (service !== undefined && service !== value) {
        throw new UnsupportedFindingError(finding.ruleId, finding.signal);
      }
      service = value;
    } else if (key === "route") {
      if (!isValidRoute(value)) {
        throw new UnsupportedFindingError(finding.ruleId, finding.signal);
      }
      route = value;
    } else if (key === "method") {
      if (!isValidHttpMethod(value)) {
        throw new UnsupportedFindingError(finding.ruleId, finding.signal);
      }
      method = value;
    } else {
      throw new UnsupportedFindingError(finding.ruleId, finding.signal);
    }
  }

  if (!service || !route) {
    throw new UnsupportedFindingError(finding.ruleId, finding.signal);
  }

  const labels: MetricSelectorLabels = {
    service,
    route,
    ...(method ? { method } : {})
  };

  return { metricName: rawMetricName, labels };
}

interface ParsedEvidenceCandidate {
  hasExplicitEvidence: boolean;
  hasSamplesArray: boolean;
  sampleCount: number;
  metricName?: string;
  service?: string;
  route?: string;
  method?: string;
}

function parseEvidenceMetricCandidate(finding: FindingSummary): ParsedEvidenceCandidate {
  const raw = finding.evidenceJson;
  if (raw === undefined || raw === null) {
    return { hasExplicitEvidence: false, hasSamplesArray: false, sampleCount: 0 };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new UnsupportedFindingError(finding.ruleId, finding.signal);
  }
  const root = raw as Record<string, unknown>;
  if (Object.keys(root).length === 0) {
    return { hasExplicitEvidence: false, hasSamplesArray: false, sampleCount: 0 };
  }

  const metricNames = new Set<string>();
  const services = new Set<string>();
  const routes = new Set<string>();
  const methods = new Set<string>();

  const addMetricName = (val: unknown) => {
    if (val === undefined || val === null) return;
    if (!isValidMetricName(val)) {
      throw new UnsupportedFindingError(finding.ruleId, finding.signal);
    }
    metricNames.add(val);
  };
  const addRoute = (val: unknown) => {
    if (val === undefined || val === null) return;
    if (!isValidRoute(val)) {
      throw new UnsupportedFindingError(finding.ruleId, finding.signal);
    }
    routes.add(val);
  };
  const addMethod = (val: unknown) => {
    if (val === undefined || val === null) return;
    if (!isValidHttpMethod(val)) {
      throw new UnsupportedFindingError(finding.ruleId, finding.signal);
    }
    methods.add(val);
  };
  const collectServiceAliases = (obj: Record<string, unknown>) => {
    for (const key of SERVICE_LABEL_ALIASES) {
      if (!Object.prototype.hasOwnProperty.call(obj, key) || obj[key] === undefined) {
        continue;
      }
      if (!isValidServiceName(obj[key])) {
        throw new UnsupportedFindingError(finding.ruleId, finding.signal);
      }
      services.add(obj[key]);
    }
  };

  const inspectDirectObject = (obj: Record<string, unknown>) => {
    addMetricName(obj.metricName ?? obj.expectedMetric);
    collectServiceAliases(obj);
    addRoute(obj.route);
    addMethod(obj.method);

    for (const labelKey of ["labels", "requiredLabels"] as const) {
      const labelsVal = obj[labelKey];
      if (labelsVal !== undefined && labelsVal !== null) {
        if (typeof labelsVal !== "object" || Array.isArray(labelsVal)) {
          throw new UnsupportedFindingError(finding.ruleId, finding.signal);
        }
        const labelsObj = labelsVal as Record<string, unknown>;
        collectServiceAliases(labelsObj);
        addRoute(labelsObj.route);
        addMethod(labelsObj.method);
      }
    }
  };

  inspectDirectObject(root);
  if (root.requirement && typeof root.requirement === "object" && !Array.isArray(root.requirement)) {
    inspectDirectObject(root.requirement as Record<string, unknown>);
  }

  const evidenceObj = root.evidence && typeof root.evidence === "object" && !Array.isArray(root.evidence)
    ? (root.evidence as Record<string, unknown>)
    : null;
  const dataObj = evidenceObj?.data && typeof evidenceObj.data === "object" && !Array.isArray(evidenceObj.data)
    ? (evidenceObj.data as Record<string, unknown>)
    : root.data && typeof root.data === "object" && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : null;

  const rawSamples = dataObj?.samples !== undefined ? dataObj.samples : root.samples;
  let hasSamplesArray = false;
  let sampleCount = 0;

  if (rawSamples !== undefined) {
    if (!Array.isArray(rawSamples)) {
      throw new UnsupportedFindingError(finding.ruleId, finding.signal);
    }
    hasSamplesArray = true;
    sampleCount = rawSamples.length;
    for (const sample of rawSamples) {
      if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
        throw new UnsupportedFindingError(finding.ruleId, finding.signal);
      }
      const sampleRecord = sample as Record<string, unknown>;
      const sampleLabels = sampleRecord.labels;
      if (sampleLabels !== undefined && sampleLabels !== null && (typeof sampleLabels !== "object" || Array.isArray(sampleLabels))) {
        throw new UnsupportedFindingError(finding.ruleId, finding.signal);
      }
      const labelsRecord = (sampleLabels as Record<string, unknown> | undefined) ?? {};
      const sampleMetricName = sampleRecord.metricName ?? labelsRecord.__name__;
      if (sampleMetricName === undefined || sampleMetricName === null) {
        throw new UnsupportedFindingError(finding.ruleId, finding.signal);
      }
      addMetricName(sampleMetricName);
      collectServiceAliases(labelsRecord);
      addRoute(labelsRecord.route);
      addMethod(labelsRecord.method);
    }
  }

  if (metricNames.size > 1 || services.size > 1 || routes.size > 1 || methods.size > 1) {
    throw new UnsupportedFindingError(finding.ruleId, finding.signal);
  }

  const hasStructuredMetricEvidence =
    hasSamplesArray ||
    metricNames.size > 0 ||
    services.size > 0 ||
    routes.size > 0 ||
    methods.size > 0 ||
    root.evidence !== undefined ||
    root.data !== undefined ||
    root.samples !== undefined ||
    root.labels !== undefined ||
    root.requiredLabels !== undefined ||
    root.requirement !== undefined;

  return {
    hasExplicitEvidence: hasStructuredMetricEvidence,
    hasSamplesArray,
    sampleCount,
    metricName: [...metricNames][0],
    service: [...services][0],
    route: [...routes][0],
    method: [...methods][0]
  };
}

export function resolveMetricTarget(finding: FindingSummary): ResolvedMetricTarget {
  const fromExpected = parseExpectedMetricTarget(finding);
  const fromEvidence = parseEvidenceMetricCandidate(finding);

  if (fromExpected) {
    if (fromEvidence.metricName && fromEvidence.metricName !== fromExpected.metricName) {
      throw new UnsupportedFindingError(finding.ruleId, finding.signal);
    }
    if (fromEvidence.service && fromEvidence.service !== fromExpected.labels?.service) {
      throw new UnsupportedFindingError(finding.ruleId, finding.signal);
    }
    if (fromEvidence.route && fromEvidence.route !== fromExpected.labels?.route) {
      throw new UnsupportedFindingError(finding.ruleId, finding.signal);
    }
    if (fromEvidence.method && fromExpected.labels?.method && fromEvidence.method !== fromExpected.labels.method) {
      throw new UnsupportedFindingError(finding.ruleId, finding.signal);
    }

    const method = fromExpected.labels?.method ?? fromEvidence.method;
    if (requiresHttpMethodSelector(finding, fromExpected.metricName) && !method) {
      throw new UnsupportedFindingError(finding.ruleId, finding.signal);
    }

    const labels: MetricSelectorLabels = {
      service: fromExpected.labels!.service,
      route: fromExpected.labels!.route,
      ...(method ? { method } : {})
    };
    return {
      metricName: fromExpected.metricName,
      labels
    };
  }

  if (fromEvidence.hasExplicitEvidence) {
    if (!fromEvidence.metricName || !fromEvidence.service || !fromEvidence.route) {
      throw new UnsupportedFindingError(finding.ruleId, finding.signal);
    }
    if (requiresHttpMethodSelector(finding, fromEvidence.metricName) && !fromEvidence.method) {
      throw new UnsupportedFindingError(finding.ruleId, finding.signal);
    }
    return {
      metricName: fromEvidence.metricName,
      labels: {
        service: fromEvidence.service,
        route: fromEvidence.route,
        ...(fromEvidence.method ? { method: fromEvidence.method } : {})
      }
    };
  }

  if (STRUCTURED_METRIC_RULE_IDS.has(finding.ruleId) || !finding.expected || !finding.expected.trim()) {
    throw new UnsupportedFindingError(finding.ruleId, finding.signal);
  }

  const fallbackName = finding.requirementId.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
  if (!isValidMetricName(fallbackName)) {
    throw new UnsupportedFindingError(finding.ruleId, finding.signal);
  }
  return { metricName: fallbackName };
}

function formatMetricSelectors(labels: MetricSelectorLabels): string {
  const parts = [`service=${labels.service}`, `route=${labels.route}`];
  if (labels.method) {
    parts.push(`method=${labels.method}`);
  }
  return parts.join(", ");
}

// ── Allowlisted patch generators ─────────────────────────────────────────────

function buildMetricPatch(finding: FindingSummary): RemediationPatch {
  const filePath = "config/observability/metrics.yaml";
  assertSafePatchPath(filePath);

  const target = resolveMetricTarget(finding);
  const { metricName, labels } = target;
  const selectorSummary = labels ? ` (${formatMetricSelectors(labels)})` : "";

  return {
    plannerVersion: "phase07-planner-v1",
    filePath,
    initialFileContent: [
      "# CloudPilot Observability — Metrics Configuration",
      "# cloudpilot:metrics",
      "metrics: []",
      ""
    ].join("\n"),
    prTitle: `fix(observability): add missing metric '${metricName}'`,
    prBody: [
      `## CloudPilot Remediation`,
      ``,
      `**Finding:** \`${finding.requirementId}\` (rule \`${finding.ruleId}\` v${finding.ruleVersion})`,
      `**Signal:** metric`,
      `**Gap:** ${finding.reason}`,
      ``,
      `### Expected`,
      `\`\`\``,
      finding.expected,
      `\`\`\``,
      ``,
      `### Observed`,
      `\`\`\``,
      finding.observed,
      `\`\`\``,
      ``,
      `### Change`,
      `This PR adds the missing metric configuration entry.`,
      `Review and adjust scrape intervals or label selectors as required for your environment.`,
      ``,
      `---`,
      `*Generated deterministically by CloudPilot Gap Engine. Do not merge without human review.*`
    ].join("\n"),
    commitMessage: `fix(metrics): add ${metricName} — ${finding.requirementId}`,
    summary: `Add metric '${metricName}'${selectorSummary} to metrics.yaml`,
    applyPatch(content: string): string {
      return patchObservabilityYaml(
        content,
        "metrics",
        "name",
        metricName,
        `cloudpilot:remediated:${finding.ruleId}`,
        labels ? { labels } : undefined
      );
    }
  };
}

function buildHealthPatch(finding: FindingSummary): RemediationPatch {
  const filePath = "config/observability/health-checks.yaml";
  assertSafePatchPath(filePath);

  const svcName = finding.requirementId.replace(/[^a-zA-Z0-9_\-]/g, "-").toLowerCase();

  return {
    plannerVersion: "phase07-planner-v1",
    filePath,
    initialFileContent: [
      "# CloudPilot Observability — Health Checks",
      "# cloudpilot:health-checks",
      "health_checks: []",
      ""
    ].join("\n"),
    prTitle: `fix(observability): add missing health check for '${svcName}'`,
    prBody: [
      `## CloudPilot Remediation`,
      ``,
      `**Finding:** \`${finding.requirementId}\` (rule \`${finding.ruleId}\` v${finding.ruleVersion})`,
      `**Signal:** health`,
      `**Gap:** ${finding.reason}`,
      ``,
      `### Expected`,
      `\`\`\``,
      finding.expected,
      `\`\`\``,
      ``,
      `### Observed`,
      `\`\`\``,
      finding.observed,
      `\`\`\``,
      ``,
      `### Change`,
      `This PR registers the missing health-check endpoint in the CloudPilot observability configuration.`,
      `Verify the endpoint URL and probe intervals before merging.`,
      ``,
      `---`,
      `*Generated deterministically by CloudPilot Gap Engine. Do not merge without human review.*`
    ].join("\n"),
    commitMessage: `fix(health): add health check for ${svcName} — ${finding.requirementId}`,
    summary: `Add health check for '${svcName}'`,
    applyPatch(content: string): string {
      return patchObservabilityYaml(
        content,
        "health_checks",
        "service",
        svcName,
        `cloudpilot:remediated:${finding.ruleId}`
      );
    }
  };
}

export interface PrometheusAlertRuleInput {
  alert: string;
  expr: string;
  forDuration?: string;
  severity: "warning" | "critical";
  requirementId: string;
  summary: string;
}

const PROMETHEUS_GROUP_NAME = "cloudpilot_alerts";

function isSafePromqlExpr(expr: unknown): expr is string {
  return typeof expr === "string" && expr.trim().length > 0 && expr.length <= 512 && !/[\r\n\0]/.test(expr);
}

/**
 * Validates that a YAML string conforms to Prometheus rule_files structure:
 * { groups: [ { name: string, rules: [ { alert: string, expr: string, ... } ] } ] }.
 */
export function validatePrometheusAlertRulesYaml(content: string): void {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new UnsupportedYamlStructureError("Prometheus alert rules YAML cannot be empty.");
  }
  const doc = YAML.parseDocument(content);
  if (doc.errors.length > 0) {
    throw new MalformedYamlError(`Malformed YAML document: ${doc.errors[0].message}`);
  }
  const parsed = doc.toJSON();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UnsupportedYamlStructureError("Prometheus alert rules root must be a mapping.");
  }
  const groups = (parsed as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) {
    throw new UnsupportedYamlStructureError("Prometheus alert rules must contain a 'groups' sequence.");
  }
  for (const group of groups) {
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      throw new UnsupportedYamlStructureError("Each Prometheus rule group must be a mapping.");
    }
    const g = group as { name?: unknown; rules?: unknown };
    if (typeof g.name !== "string" || !g.name.trim()) {
      throw new UnsupportedYamlStructureError("Each Prometheus rule group must have a non-empty 'name'.");
    }
    if (!Array.isArray(g.rules)) {
      throw new UnsupportedYamlStructureError(`Prometheus rule group '${g.name}' must have a 'rules' sequence.`);
    }
    for (const rule of g.rules) {
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
        throw new UnsupportedYamlStructureError(`Each rule in group '${g.name}' must be a mapping.`);
      }
      const r = rule as { alert?: unknown; expr?: unknown };
      if (!isValidMetricName(r.alert)) {
        throw new UnsupportedYamlStructureError(`Invalid Prometheus alert name '${String(r.alert)}' in group '${g.name}'.`);
      }
      if (!isSafePromqlExpr(r.expr)) {
        throw new UnsupportedYamlStructureError(`Alert '${r.alert}' in group '${g.name}' must have a valid non-empty 'expr'.`);
      }
    }
  }
}

/**
 * Idempotently patches a Prometheus rule_files YAML document with an alerting rule
 * inside the `cloudpilot_alerts` group, preserving unrelated groups and comments.
 */
export function patchPrometheusAlertRulesYaml(
  content: string,
  rule: PrometheusAlertRuleInput,
  comment?: string
): string {
  if (!isValidMetricName(rule.alert)) {
    throw new UnsupportedFindingError("alert-rule", `invalid alert name '${rule.alert}'`);
  }
  if (!isSafePromqlExpr(rule.expr)) {
    throw new UnsupportedFindingError("alert-rule", "invalid PromQL expr");
  }

  const trimmed = content.trim();
  const doc = trimmed.length === 0 ? new YAML.Document({ groups: [] }) : YAML.parseDocument(content);

  if (doc.errors.length > 0) {
    throw new MalformedYamlError(`Malformed YAML document: ${doc.errors[0].message}`);
  }
  if (!doc.contents) {
    doc.contents = doc.createNode({ groups: [] });
  }
  if (!YAML.isMap(doc.contents)) {
    throw new UnsupportedYamlStructureError("Prometheus alert rules root must be a YAML mapping.");
  }

  const rootMap = doc.contents as YAML.YAMLMap;
  let groupsNode: unknown = rootMap.get("groups", true);
  if (groupsNode === undefined || groupsNode === null) {
    groupsNode = doc.createNode([]);
    rootMap.set("groups", groupsNode);
  }
  if (!YAML.isSeq(groupsNode)) {
    throw new UnsupportedYamlStructureError("Property 'groups' must be a sequence.");
  }

  const groupsSeq = groupsNode as YAML.YAMLSeq;
  if (groupsSeq.flow) {
    groupsSeq.flow = false;
  }

  // Validate any pre-existing groups/rules before modifying
  if (trimmed.length > 0 && rootMap.has("groups")) {
    validatePrometheusAlertRulesYaml(content);
  }

  let targetGroupMap: YAML.YAMLMap | null = null;
  for (const item of groupsSeq.items) {
    const json = item && typeof (item as any).toJSON === "function" ? (item as any).toJSON() : item;
    if (json && typeof json === "object" && (json as { name?: unknown }).name === PROMETHEUS_GROUP_NAME && YAML.isMap(item)) {
      targetGroupMap = item as YAML.YAMLMap;
      break;
    }
  }

  if (!targetGroupMap) {
    targetGroupMap = doc.createNode({ name: PROMETHEUS_GROUP_NAME, rules: [] }) as YAML.YAMLMap;
    groupsSeq.items.push(targetGroupMap);
  }

  let rulesNode: unknown = targetGroupMap.get("rules", true);
  if (rulesNode === undefined || rulesNode === null) {
    rulesNode = doc.createNode([]);
    targetGroupMap.set("rules", rulesNode);
  }
  if (!YAML.isSeq(rulesNode)) {
    throw new UnsupportedYamlStructureError("Group 'rules' must be a sequence.");
  }
  const rulesSeq = rulesNode as YAML.YAMLSeq;
  if (rulesSeq.flow) {
    rulesSeq.flow = false;
  }

  for (const existingRule of rulesSeq.items) {
    const json = existingRule && typeof (existingRule as any).toJSON === "function" ? (existingRule as any).toJSON() : existingRule;
    if (json && typeof json === "object" && (json as { alert?: unknown }).alert === rule.alert) {
      return content;
    }
  }

  const ruleNode = doc.createNode({
    alert: rule.alert,
    expr: rule.expr,
    for: rule.forDuration ?? "1m",
    labels: {
      severity: rule.severity,
      requirement_id: rule.requirementId
    },
    annotations: {
      summary: rule.summary
    }
  });
  if (comment) {
    ruleNode.comment = ` ${comment}`;
  }
  rulesSeq.items.push(ruleNode);

  const result = doc.toString();
  validatePrometheusAlertRulesYaml(result);
  return result;
}

function resolveAlertRuleSpec(finding: FindingSummary): PrometheusAlertRuleInput {
  let alertName = finding.requirementId.replace(/[^a-zA-Z0-9_:]/g, "_").toLowerCase();
  if (!/^[a-zA-Z_:]/.test(alertName)) {
    alertName = `_${alertName}`;
  }
  if (!isValidMetricName(alertName)) {
    throw new UnsupportedFindingError(finding.ruleId, finding.signal);
  }

  const ev = finding.evidenceJson && typeof finding.evidenceJson === "object" && !Array.isArray(finding.evidenceJson)
    ? (finding.evidenceJson as Record<string, unknown>)
    : null;

  let expr = "up == 0";
  if (ev && isSafePromqlExpr(ev.expr)) {
    expr = ev.expr.trim();
  } else if (ev && isValidMetricName(ev.metricName)) {
    expr = `absent(${ev.metricName}) == 1`;
  }

  const severity: "warning" | "critical" =
    ev?.severity === "critical" || /\bcritical\b/i.test(finding.expected)
      ? "critical"
      : "warning";

  return {
    alert: alertName,
    expr,
    forDuration: "1m",
    severity,
    requirementId: finding.requirementId,
    summary: `CloudPilot alert rule for ${finding.requirementId}`
  };
}

function buildAlertPatch(finding: FindingSummary): RemediationPatch {
  const filePath = "config/observability/alert-rules.yaml";
  assertSafePatchPath(filePath);

  const ruleSpec = resolveAlertRuleSpec(finding);

  return {
    plannerVersion: "phase07-planner-v1",
    filePath,
    initialFileContent: [
      "# CloudPilot Observability — Alert Rules",
      "# cloudpilot:alerts",
      "groups: []",
      ""
    ].join("\n"),
    prTitle: `fix(observability): add missing alert rule '${ruleSpec.alert}'`,
    prBody: [
      `## CloudPilot Remediation`,
      ``,
      `**Finding:** \`${finding.requirementId}\` (rule \`${finding.ruleId}\` v${finding.ruleVersion})`,
      `**Signal:** alert`,
      `**Gap:** ${finding.reason}`,
      ``,
      `### Expected`,
      `\`\`\``,
      finding.expected,
      `\`\`\``,
      ``,
      `### Observed`,
      `\`\`\``,
      finding.observed,
      `\`\`\``,
      ``,
      `### Change`,
      `Adds Prometheus alerting rule \`${ruleSpec.alert}\` (\`expr: ${ruleSpec.expr}\`, \`severity: ${ruleSpec.severity}\`) to \`groups[].rules\`.`,
      ``,
      `---`,
      `*Generated deterministically by CloudPilot Gap Engine. Do not merge without human review.*`
    ].join("\n"),
    commitMessage: `fix(alerts): add alert rule ${ruleSpec.alert} — ${finding.requirementId}`,
    summary: `Add Prometheus alert rule '${ruleSpec.alert}'`,
    applyPatch(content: string): string {
      return patchPrometheusAlertRulesYaml(
        content,
        ruleSpec,
        `cloudpilot:remediated:${finding.ruleId}`
      );
    }
  };
}

export function validateTracingConfigYaml(content: string): void {
  const doc = YAML.parseDocument(content, { strict: true });
  if (doc.errors.length > 0) {
    throw new MalformedYamlError(`Malformed YAML document: ${doc.errors[0].message}`);
  }
  const parsed = doc.toJSON() as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UnsupportedYamlStructureError("Tracing config root must be a YAML mapping.");
  }
  const tracing = (parsed as { tracing?: unknown }).tracing;
  if (!tracing || typeof tracing !== "object" || Array.isArray(tracing)) {
    throw new UnsupportedYamlStructureError("Property 'tracing' must be a YAML mapping.");
  }
  const record = tracing as Record<string, unknown>;
  if (typeof record.enabled !== "boolean") {
    throw new UnsupportedYamlStructureError("Property 'tracing.enabled' must be a boolean.");
  }
  if (record.propagators !== undefined && !Array.isArray(record.propagators)) {
    throw new UnsupportedYamlStructureError("Property 'tracing.propagators' must be a sequence.");
  }
}

export function patchTracingYaml(
  content: string,
  serviceName: string
): string {
  const trimmed = content.trim();
  const doc = trimmed.length === 0
    ? new YAML.Document({ tracing: { enabled: true, service_name: serviceName, propagators: ["tracecontext", "baggage"], sample_ratio: 1.0 } })
    : YAML.parseDocument(content, { strict: true });

  if (doc.errors.length > 0) {
    throw new MalformedYamlError(`Malformed YAML document: ${doc.errors[0].message}`);
  }
  if (!doc.contents) {
    doc.contents = doc.createNode({
      tracing: {
        enabled: true,
        service_name: serviceName,
        propagators: ["tracecontext", "baggage"],
        sample_ratio: 1.0
      }
    });
  }
  if (!YAML.isMap(doc.contents)) {
    throw new UnsupportedYamlStructureError("Tracing config root must be a YAML mapping.");
  }

  const rootMap = doc.contents as YAML.YAMLMap;
  let tracingNode: unknown = rootMap.get("tracing", true);
  if (tracingNode === undefined || tracingNode === null) {
    tracingNode = doc.createNode({});
    rootMap.set("tracing", tracingNode);
  }
  if (!YAML.isMap(tracingNode)) {
    throw new UnsupportedYamlStructureError("Property 'tracing' must be a YAML mapping.");
  }

  const tracingMap = tracingNode as YAML.YAMLMap;
  const currentEnabled = tracingMap.get("enabled");
  const currentPropNode = tracingMap.get("propagators");
  const currentProps = currentPropNode && typeof (currentPropNode as any).toJSON === "function"
    ? (currentPropNode as any).toJSON()
    : currentPropNode;

  const hasTraceContext = Array.isArray(currentProps) && currentProps.includes("tracecontext");
  const hasBaggage = Array.isArray(currentProps) && currentProps.includes("baggage");
  if (currentEnabled === true && hasTraceContext && hasBaggage && trimmed.length > 0) {
    return content;
  }

  tracingMap.set("enabled", true);
  if (!tracingMap.has("service_name")) {
    tracingMap.set("service_name", serviceName);
  }
  tracingMap.set("propagators", doc.createNode(["tracecontext", "baggage"]));
  if (!tracingMap.has("sample_ratio")) {
    tracingMap.set("sample_ratio", 1.0);
  }

  const output = doc.toString({ indent: 2 });
  validateTracingConfigYaml(output);
  return output;
}

function resolveTraceServiceName(finding: FindingSummary): string {
  const match = finding.expected.match(/service\s+['"]?([a-zA-Z0-9_.\-]+)['"]?/i);
  if (match && match[1]) {
    return match[1];
  }
  return "demo-service";
}

function buildTracePatch(finding: FindingSummary): RemediationPatch {
  const filePath = "config/observability/tracing.yaml";
  assertSafePatchPath(filePath);
  const serviceName = resolveTraceServiceName(finding);

  return {
    plannerVersion: "phase07-planner-v1",
    filePath,
    initialFileContent: [
      "# CloudPilot Observability — Distributed Tracing",
      "# cloudpilot:tracing",
      "tracing:",
      "  enabled: false",
      `  service_name: ${serviceName}`,
      "  propagators: []",
      ""
    ].join("\n"),
    prTitle: `fix(observability): enable OpenTelemetry tracing & W3C propagation for '${serviceName}'`,
    prBody: [
      `## CloudPilot Remediation`,
      ``,
      `**Finding:** \`${finding.requirementId}\` (rule \`${finding.ruleId}\` v${finding.ruleVersion})`,
      `**Signal:** trace`,
      `**Gap:** ${finding.reason}`,
      ``,
      `### Expected`,
      `\`\`\``,
      finding.expected,
      `\`\`\``,
      ``,
      `### Observed`,
      `\`\`\``,
      finding.observed,
      `\`\`\``,
      ``,
      `### Change`,
      `Enables OpenTelemetry SDK tracing (\`tracing.enabled: true\`) and W3C \`tracecontext\` / \`baggage\` propagation for \`${serviceName}\` in \`config/observability/tracing.yaml\`.`,
      ``,
      `---`,
      `*Generated deterministically by CloudPilot Gap Engine. Do not merge without human review.*`
    ].join("\n"),
    commitMessage: `fix(tracing): enable OTel tracing and propagation for ${serviceName} — ${finding.requirementId}`,
    summary: `Enable OpenTelemetry tracing and W3C propagation for '${serviceName}'`,
    applyPatch(content: string): string {
      return patchTracingYaml(content, serviceName);
    }
  };
}

// ── Signal dispatch ───────────────────────────────────────────────────────────

const SIGNAL_BUILDERS: Record<string, (f: FindingSummary) => RemediationPatch> = {
  metric: buildMetricPatch,
  health: buildHealthPatch,
  alert:  buildAlertPatch,
  trace:  buildTracePatch
};

/**
 * Returns a deterministic patch for the given gap finding, or throws
 * UnsupportedFindingError if the signal/rule is not in the allowlist.
 *
 * Only `gap` outcome findings are patchable; pass/unknown/inconclusive findings
 * should be filtered by the caller before invoking this function.
 */
export function planRemediation(finding: FindingSummary): RemediationPatch {
  if (finding.outcome !== "gap") {
    throw new UnsupportedFindingError(finding.ruleId, finding.signal);
  }

  const builder = SIGNAL_BUILDERS[finding.signal];
  if (!builder) {
    throw new UnsupportedFindingError(finding.ruleId, finding.signal);
  }

  return builder(finding);
}

/**
 * Returns true if the given signal is supported for remediation.
 */
export function isRemediationSupported(signal: string, outcome: string): boolean {
  return outcome === "gap" && signal in SIGNAL_BUILDERS;
}

/**
 * Builds a stable idempotency key for a finding → patch combination.
 * Same finding + ruleId + ruleVersion always maps to the same key.
 */
export function buildIdempotencyKey(
  tenantId: string,
  findingId: string,
  ruleId: string,
  ruleVersion: string
): string {
  return `${tenantId}:${findingId}:${ruleId}:${ruleVersion}`;
}
