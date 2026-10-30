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
}

export interface RemediationPatch {
  /** Repository-relative file path to modify. */
  filePath: string;
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
 * Idempotent: does not insert duplicates if `itemKey: itemValue` is already present.
 * Fails safely on malformed YAML or unsupported document structures.
 * Validates the output YAML before returning.
 */
export function patchObservabilityYaml(
  content: string,
  topKey: string,
  itemKey: string,
  itemValue: string,
  comment?: string
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

  // Check for duplicate requirement
  for (const item of seq.items) {
    const json = item && typeof (item as any).toJSON === "function" ? (item as any).toJSON() : item;
    if (json && typeof json === "object" && json[itemKey] === itemValue) {
      return content;
    }
  }

  if (seq.flow) {
    seq.flow = false;
  }

  const newItemNode = doc.createNode({ [itemKey]: itemValue });
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

// ── Allowlisted patch generators ─────────────────────────────────────────────

function buildMetricPatch(finding: FindingSummary): RemediationPatch {
  const filePath = "config/observability/metrics.yaml";
  assertSafePatchPath(filePath);

  const metricName = finding.requirementId.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();

  return {
    filePath,
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
    summary: `Add metric '${metricName}' to metrics.yaml`,
    applyPatch(content: string): string {
      return patchObservabilityYaml(
        content,
        "metrics",
        "name",
        metricName,
        `cloudpilot:remediated:${finding.ruleId}`
      );
    }
  };
}

function buildHealthPatch(finding: FindingSummary): RemediationPatch {
  const filePath = "config/observability/health-checks.yaml";
  assertSafePatchPath(filePath);

  const svcName = finding.requirementId.replace(/[^a-zA-Z0-9_\-]/g, "-").toLowerCase();

  return {
    filePath,
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

function buildAlertPatch(finding: FindingSummary): RemediationPatch {
  const filePath = "config/observability/alert-rules.yaml";
  assertSafePatchPath(filePath);

  const alertName = finding.requirementId.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();

  return {
    filePath,
    prTitle: `fix(observability): add missing alert rule '${alertName}'`,
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
      `Adds the missing alert rule definition. Tune thresholds and severity labels before merging.`,
      ``,
      `---`,
      `*Generated deterministically by CloudPilot Gap Engine. Do not merge without human review.*`
    ].join("\n"),
    commitMessage: `fix(alerts): add alert rule ${alertName} — ${finding.requirementId}`,
    summary: `Add alert rule '${alertName}'`,
    applyPatch(content: string): string {
      return patchObservabilityYaml(
        content,
        "alerts",
        "alert",
        alertName,
        `cloudpilot:remediated:${finding.ruleId}`
      );
    }
  };
}

// ── Signal dispatch ───────────────────────────────────────────────────────────

const SIGNAL_BUILDERS: Record<string, (f: FindingSummary) => RemediationPatch> = {
  metric: buildMetricPatch,
  health: buildHealthPatch,
  alert:  buildAlertPatch
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
