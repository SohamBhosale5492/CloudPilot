import { createHash } from "node:crypto";
import type { ExpectedObservabilityModel, ExpectedRequirement } from "./expected-observability";

export interface SourceSnapshotFile { path: string; content: string }
export interface SourceLineEvidence { path: string; line: number; claim: string }
export interface SourceObservabilityFinding {
  id: string;
  ruleId: string;
  severity: "low" | "medium" | "high";
  status: "gap" | "incomplete";
  title: string;
  expected: string;
  observed: string;
  risk: string;
  evidence: SourceLineEvidence[];
}
export interface SourceObservabilityAnalysis {
  status: "success" | "partial" | "unsupported" | "invalid";
  sourceDigest: string;
  serviceName?: string;
  routes: Array<{ method: string; path: string; evidence: SourceLineEvidence }>;
  expectedModel: ExpectedObservabilityModel;
  metricConfigs: Record<string, { serviceName: string; route: string; method: string; minimumCount: number; maxEvidenceAgeMs: number }>;
  evidenceByRequirement: Record<string, SourceLineEvidence[]>;
  findings: SourceObservabilityFinding[];
  diagnostics: string[];
}

const MAX_FILES = 120;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".json", ".yaml", ".yml"]);

/** Deterministic, bounded static rules. It reports only source-backed facts and explicit rule-based gaps. */
export function analyzeNodeExpressSource(files: SourceSnapshotFile[]): SourceObservabilityAnalysis {
  const invalidModel = emptyModel("express-service");
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) {
    return invalidResult(invalidModel, `Select between 1 and ${MAX_FILES} supported source/configuration files.`);
  }
  const normalized = new Map<string, string>();
  let totalBytes = 0;
  for (const file of files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") return invalidResult(invalidModel, "Each source file must include a relative path and text content.");
    const filePath = file.path.replace(/\\/g, "/");
    const segments = filePath.split("/");
    const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
    if (!filePath || filePath.length > 512 || filePath.startsWith("/") || filePath.includes(":") ||
        segments.some((part) => !part || part === "." || part === ".." || /[\u0000-\u001f]/.test(part)) || !ALLOWED_EXTENSIONS.has(extension) ||
        /(^|\/)(\.env(?:\.|$)|node_modules|\.git)(\/|$)/i.test(filePath)) {
      return invalidResult(invalidModel, "Source paths must be relative supported files without traversal, secret files, or dependency directories.");
    }
    if (normalized.has(filePath)) return invalidResult(invalidModel, `Duplicate source path: ${filePath}.`);
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > MAX_FILE_BYTES) return invalidResult(invalidModel, `Source file ${filePath} exceeds the ${MAX_FILE_BYTES}-byte limit.`);
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) return invalidResult(invalidModel, `Combined source content exceeds the ${MAX_TOTAL_BYTES}-byte limit.`);
    normalized.set(filePath, file.content);
  }

  const entries = [...normalized.entries()].sort(([a], [b]) => a.localeCompare(b));
  const sourceDigest = sha256(entries.map(([filePath, content]) => `${filePath}\0${content}`).join("\0"));
  const expressFiles = entries.filter(([, content]) => /require\s*\(\s*["']express["']\s*\)|from\s*["']express["']|express\s*\(/.test(content));
  if (!expressFiles.length) return {
    status: "unsupported", sourceDigest, routes: [], expectedModel: invalidModel, metricConfigs: {}, evidenceByRequirement: {}, findings: [],
    diagnostics: ["No Node.js Express application evidence was found in the supplied snapshot."]
  };

  const serviceName = findServiceName(entries) ?? "express-service";
  const routes = discoverRoutes(entries);
  const health = routes.filter((route) => route.path === "/health" || route.path === "/healthz" || route.path === "/ready" || route.path === "/readyz");
  const databaseEvidence = findLine(entries, /mongoose\.(?:connect|createConnection)\s*\(|new\s+PrismaClient\s*\(|new\s+Pool\s*\(/i, "Source initializes a database client.");
  const databaseStartupEvidence = findLine(entries, /await\s+connectDB\s*\(/, "Application waits for its database connection before starting the HTTP listener.");
  const healthCheckEvaluated = health.some((route) => {
    const content = normalized.get(route.evidence.path) ?? "";
    const lines = content.split(/\r?\n/);
    return lines.slice(Math.max(0, route.evidence.line - 1), Math.min(lines.length, route.evidence.line + 30))
      .some((line) => /readyState|\.ping\s*\(|connection\.state|isConnected|SELECT\s+1/i.test(line));
  });

  const metricInstruments = discoverMetrics(entries);
  const requestMetric = metricInstruments.find((item) => item.kind === "counter");
  const durationMetric = metricInstruments.find((item) => item.kind === "histogram");
  const telemetryMiddleware = findLine(entries, /app\.use\s*\(\s*observabilityMiddleware\s*\)/, "Express application installs request observability middleware.");
  const modeledRoutes = routes.filter((route) => route.method !== "USE");
  const requirements: ExpectedRequirement[] = [];
  const metricConfigs: SourceObservabilityAnalysis["metricConfigs"] = {};
  const evidenceByRequirement: Record<string, SourceLineEvidence[]> = {};
  const findings: SourceObservabilityFinding[] = [];
  const routeExpected = modeledRoutes.length > 0;

  if (routeExpected && !telemetryMiddleware) {
    findings.push(sourceFinding("http-request-middleware-missing", "CP-RULE-SOURCE-EXPRESS-REQUEST-INSTRUMENTATION", "medium", "gap",
      "Express routes have no detected request observability middleware.", "The observed HTTP route handlers are wrapped by request metric and trace instrumentation.",
      "The supplied source snapshot contains routes but no application-level observability middleware installation.",
      "Request volume, latency, and request-level traces may be absent from runtime telemetry.", modeledRoutes.slice(0, 8).map((r) => r.evidence)));
  }
  if (routeExpected && !requestMetric) findings.push(sourceFinding("http-request-counter-missing", "CP-RULE-SOURCE-EXPRESS-REQUEST-COUNTER", "medium", "gap",
    "No request counter instrument was found.", "HTTP request counts are recorded for discovered Express routes.",
    "No meter.createCounter declaration with an observed request recording call was found.",
    "Request-rate changes and traffic volume cannot be correlated from application metrics.", modeledRoutes.slice(0, 8).map((r) => r.evidence)));
  if (routeExpected && !durationMetric) findings.push(sourceFinding("http-duration-histogram-missing", "CP-RULE-SOURCE-EXPRESS-DURATION-HISTOGRAM", "medium", "gap",
    "No request-duration histogram instrument was found.", "HTTP request duration is recorded for discovered Express routes.",
    "No meter.createHistogram declaration with an observed duration recording call was found.",
    "Latency distributions cannot be assessed from application metrics.", modeledRoutes.slice(0, 8).map((r) => r.evidence)));

  const requestCounterRouteLabeled = Boolean(requestMetric?.dimensions.includes("route") && requestMetric.dimensions.includes("method"));
  const durationRouteLabeled = Boolean(durationMetric?.dimensions.includes("route") && durationMetric.dimensions.includes("method"));
  if (routeExpected && serviceName !== "express-service" && requestMetric && !requestCounterRouteLabeled) {
    findings.push(sourceFinding("http-request-counter-route-labels-missing", "CP-RULE-SOURCE-EXPRESS-REQUEST-LABELS", "medium", "incomplete",
      "The request counter is recorded without both route and method labels.", "Request counts can be isolated for each discovered route and HTTP method.",
      `The request counter's observed dimensions are ${requestMetric.dimensions.join(", ") || "none"}.`,
      "Runtime request counts cannot be reliably attributed to each route and method.", [requestMetric.evidence]));
  }
  if (routeExpected && serviceName !== "express-service" && durationMetric && !durationRouteLabeled) {
    findings.push(sourceFinding("http-duration-route-labels-missing", "CP-RULE-SOURCE-EXPRESS-DURATION-LABELS", "medium", "incomplete",
      "The request-duration histogram is recorded without both route and method labels.", "Request durations can be isolated for each discovered route and HTTP method.",
      `The duration histogram's observed dimensions are ${durationMetric.dimensions.join(", ") || "none"}.`,
      "Latency results cannot be reliably correlated to individual routes and methods.", [durationMetric.evidence]));
  }
  if (routeExpected && serviceName !== "express-service" && ((requestMetric && requestCounterRouteLabeled) || (durationMetric && durationRouteLabeled))) {
    for (const route of modeledRoutes) {
      if (requestMetric && requestCounterRouteLabeled) {
        const countId = requirementId("http-requests", route);
        requirements.push({ id: countId, signal: "metric", metricName: prometheusMetricName(requestMetric.name, "counter"), dimensions: requestMetric.dimensions });
        metricConfigs[countId] = { serviceName, route: route.path, method: route.method, minimumCount: 1, maxEvidenceAgeMs: 86_400_000 };
        evidenceByRequirement[countId] = [requestMetric.evidence, route.evidence];
      }
      if (durationMetric && durationRouteLabeled) {
        const durationId = requirementId("http-duration", route);
        requirements.push({ id: durationId, signal: "metric", metricName: prometheusMetricName(durationMetric.name, "histogram", durationMetric.unit), dimensions: durationMetric.dimensions });
        metricConfigs[durationId] = { serviceName, route: route.path, method: route.method, minimumCount: 1, maxEvidenceAgeMs: 86_400_000 };
        evidenceByRequirement[durationId] = [durationMetric.evidence, route.evidence];
      }
    }
  }

  const traceInstrument = findLine(entries, /(?:trace\.getTracer|startSpan\s*\()/, "Source contains OpenTelemetry span creation.");
  const traceExporter = findLine(entries, /OTLPTraceExporter|OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/, "Source/configuration declares an OTLP trace exporter endpoint.");
  const metricExporter = findLine(entries, /OTLPMetricExporter|OTEL_EXPORTER_OTLP_METRICS_ENDPOINT|PrometheusExporter/, "Source/configuration declares a metrics export endpoint.");
  if ((requestMetric || durationMetric) && !metricExporter) findings.push(sourceFinding("metric-exporter-not-found", "CP-RULE-SOURCE-METRIC-EXPORT", "medium", "incomplete",
    "Metric instruments are present, but no metrics exporter was found in the source snapshot.", "Application metrics are exported to a reachable Prometheus or OpenTelemetry Collector endpoint.",
    "A metric instrument is recorded, but this snapshot contains no recognized Prometheus/OTLP metric exporter declaration.",
    "Instrumented measurements may not leave the process for runtime scanning.", [requestMetric?.evidence, durationMetric?.evidence].filter((item): item is SourceLineEvidence => Boolean(item))));
  if (traceInstrument && !traceExporter) findings.push(sourceFinding("trace-exporter-not-found", "CP-RULE-SOURCE-TRACE-EXPORT", "medium", "incomplete",
    "Spans are created, but no trace exporter was found in the source snapshot.", "Application spans are exported to a reachable Jaeger-compatible collector.",
    "A tracer/span call is present, but no OTLP trace exporter or endpoint declaration was found in the supplied files.",
    "Spans may exist only in process memory and may not appear in Jaeger.", [traceInstrument]));
  if (routeExpected && traceInstrument && telemetryMiddleware && serviceName !== "express-service") {
    const id = `http-traces-${slug(serviceName)}`;
    requirements.push({ id, signal: "trace", serviceName });
    evidenceByRequirement[id] = [...(traceInstrument ? [traceInstrument] : modeledRoutes.slice(0, 1).map((r) => r.evidence)), ...(traceExporter ? [traceExporter] : [])];
  }
  if (routeExpected && (!traceInstrument || !telemetryMiddleware)) {
    findings.push(sourceFinding("http-tracing-missing", "CP-RULE-SOURCE-EXPRESS-HTTP-TRACING", "medium", "gap",
      "No HTTP request span instrumentation was found.", "HTTP requests create spans under a stable service name.",
      "No tracer acquisition or startSpan call was detected in the supplied source snapshot.",
      "Requests cannot be correlated with distributed traces for this service.", modeledRoutes.slice(0, 8).map((r) => r.evidence)));
  }

  for (const route of health) {
    const id = `health-${slug(route.path)}`;
    requirements.push({ id, signal: "health", kind: "http", endpoint: route.path });
    evidenceByRequirement[id] = [route.evidence];
  }
  if (databaseEvidence && health.length && !healthCheckEvaluated) {
    findings.push(sourceFinding("health-dependency-readiness", "CP-RULE-SOURCE-HEALTH-DEPENDENCY-READINESS", "medium", "incomplete",
      "The health response does not visibly report ongoing database readiness.", "A dependency-backed readiness response reflects Mongo/PostgreSQL connection health.",
      databaseStartupEvidence
        ? "The server waits for database connection before listening, but the health handler itself returns status without checking the live connection."
        : "Database client initialization and an HTTP health handler were found, but no connection-state or ping check was found in the health handler.",
      "After startup, the health URL could remain HTTP-healthy if the database connection is later lost.", [databaseEvidence, ...(databaseStartupEvidence ? [databaseStartupEvidence] : []), ...health.map((r) => r.evidence)]));
  }

  const stdoutLogger = findLine(entries, /morgan\s*\(|console\.(?:log|warn|error)\s*\(/, "Application writes request or application logs to process output.");
  const otlpLogExporter = findLine(entries, /OTLPLogExporter|OTEL_EXPORTER_OTLP_LOGS_ENDPOINT/, "Source/configuration declares an OTLP log exporter.");
  if (stdoutLogger && !otlpLogExporter) findings.push(sourceFinding("central-log-export-missing", "CP-RULE-SOURCE-LOG-EXPORT", "low", "incomplete",
    "Application logs are written to process output but no OTLP log exporter was found.", "Application log records are available in a configured central log backend.",
    "A stdout logger was detected; the supplied telemetry source snapshot contains no OTLP log exporter declaration.",
    "Logs may remain available only through container/runtime logs and cannot be correlated in a central log backend by this source evidence.", [stdoutLogger]));

  const monitoringFiles = entries.filter(([filePath]) => /prometheus|alert|monitoring/i.test(filePath));
  const scrapeConfig = findLine(monitoringFiles, /scrape_configs\s*:/, "Prometheus scrape configuration is declared.");
  if (scrapeConfig) {
    // Monitoring declarations are reported as source evidence; absence of alert rules is not treated as a universal gap.
    evidenceByRequirement.__monitoring = [scrapeConfig];
  }
  const alertRules = findLine(entries, /alert:\s*[A-Za-z_][\w]*/, "A named Prometheus alert rule is declared.");
  if (alertRules) evidenceByRequirement.__alerts = [alertRules];

  const model: ExpectedObservabilityModel = {
    schemaVersion: "cloudpilot.expected-observability.v1", serviceId: serviceName,
    requirements: requirements.sort((a, b) => a.id.localeCompare(b.id))
  };
  return {
    status: findings.length ? "partial" : "success", sourceDigest, serviceName, routes: modeledRoutes, expectedModel: model,
    metricConfigs, evidenceByRequirement, findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics: [
      ...(routes.length ? [] : ["Express was detected, but no statically recognizable route declarations were found."]),
      ...(serviceName === "express-service" ? ["No stable service name was found; route requirements that need a runtime service label were not generated."] : [])
    ]
  };
}

export function expectedModelDigest(model: ExpectedObservabilityModel): string {
  return sha256(canonical(model));
}

function discoverRoutes(entries: Array<[string, string]>): SourceObservabilityAnalysis["routes"] {
  const mounts: Array<{ prefix: string; fileSuffix: string; evidence: SourceLineEvidence }> = [];
  for (const [filePath, content] of entries) {
    const imports = new Map<string, string>();
    for (const match of content.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)|import\s+(\w+)\s+from\s+["']([^"']+)["']/g)) {
      const alias = match[1] ?? match[3]; const source = match[2] ?? match[4];
      if (alias && source) imports.set(alias, source.replace(/\\/g, "/"));
    }
    for (const match of content.matchAll(/(?:app|server)\.use\s*\(\s*["']([^"']*)["']\s*,\s*(\w+)\s*\)/g)) {
      const alias = match[2] as string; const source = imports.get(alias);
      if (source) mounts.push({ prefix: match[1] as string, fileSuffix: pathSuffix(source), evidence: lineEvidence(filePath, content, match.index ?? 0, "Application mounts an Express router at this prefix.") });
    }
  }
  const output: SourceObservabilityAnalysis["routes"] = [];
  for (const [filePath, content] of entries) {
    const routerFile = mounts.some((item) => filePath.replace(/\.(?:js|cjs|mjs|ts)$/i, "").endsWith(item.fileSuffix));
    for (const match of content.matchAll(/\b(app|router)\.(get|post|put|patch|delete|head|options)\s*\(\s*["']([^"']+)["']/gi)) {
      const method = (match[2] as string).toUpperCase(); const routePath = match[3] as string;
      const mount = routerFile ? mounts.find((item) => filePath.replace(/\.(?:js|cjs|mjs|ts)$/i, "").endsWith(item.fileSuffix)) : undefined;
      if (routePath === "*" || routePath === "/*") continue;
      const combined = normalizeRoute(`${mount?.prefix ?? ""}/${routePath}`);
      const evidence = lineEvidence(filePath, content, match.index ?? 0, `Express ${method} route is declared.`);
      output.push({ method, path: combined, evidence });
    }
  }
  const seen = new Set<string>();
  return output.filter((route) => { const key = `${route.method} ${route.path}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function discoverMetrics(entries: Array<[string, string]>): Array<{ kind: "counter" | "histogram"; name: string; unit?: string; dimensions: string[]; evidence: SourceLineEvidence }> {
  const metrics: Array<{ kind: "counter" | "histogram"; name: string; unit?: string; dimensions: string[]; evidence: SourceLineEvidence }> = [];
  for (const [filePath, content] of entries) {
    for (const [kind, regex] of [["counter", /(?:const|let|var)\s+(\w+)\s*=\s*meter\.createCounter\s*\(\s*["']([^"']+)["'][\s\S]{0,500}?\)/g], ["histogram", /(?:const|let|var)\s+(\w+)\s*=\s*meter\.createHistogram\s*\(\s*["']([^"']+)["'][\s\S]{0,500}?\)/g]] as const) {
      for (const match of content.matchAll(regex)) {
        const metricVar = match[1] as string;
        const name = match[2] as string;
        const remaining = content.slice((match.index ?? 0) + match[0].length);
        const recorder = kind === "counter" ? new RegExp(`${metricVar}\\.add\\s*\\(`) : new RegExp(`${metricVar}\\.record\\s*\\(`);
        if (!recorder.test(remaining)) continue;
        const callPattern = new RegExp(`${metricVar}\\.(?:add|record)\\s*\\(`);
        const callStart = remaining.search(callPattern);
        const semicolon = remaining.indexOf(";", callStart);
        const statement = remaining.slice(callStart, semicolon >= 0 ? semicolon : Math.min(remaining.length, callStart + 800));
        const inlineLabels = statement.match(/,\s*\{([^}]*)\}\s*\)\s*$/);
        const labelVariables = [...statement.matchAll(/,\s*(\w+)\s*\)/g)];
        const labelVariable = labelVariables.at(-1)?.[1];
        const labelText = inlineLabels?.[1] ?? (labelVariable ? content.match(new RegExp(`(?:const|let|var)\\s+${labelVariable}\\s*=\\s*\\{([^}]*)\\}`))?.[1] : undefined) ?? "";
        const dimensions = labelText.split(",").map((field) => field.trim().match(/^([A-Za-z_][\w]*)/)?.[1]).filter((value): value is string => Boolean(value));
        const uniqueDimensions = [...new Set(dimensions)].sort();
        const unitMatch = kind === "histogram" ? match[0].match(/unit\s*:\s*["']([^"']+)["']/) : null;
        metrics.push({ kind, name, ...(unitMatch ? { unit: unitMatch[1] } : {}), dimensions: uniqueDimensions, evidence: lineEvidence(filePath, content, match.index ?? 0, `OpenTelemetry ${kind} instrument '${name}' is declared and recorded with dimensions: ${uniqueDimensions.join(", ") || "none"}.`) });
      }
    }
  }
  return metrics.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

function findServiceName(entries: Array<[string, string]>): string | undefined {
  for (const [, content] of entries) {
    const match = content.match(/OTEL_SERVICE_NAME\s*\|\|\s*["']([^"']+)["']|OTEL_SERVICE_NAME\s*=\s*["']([^"']+)["']/);
    if (match) return match[1] ?? match[2];
  }
  for (const [filePath, content] of entries) {
    const match = content.match(/["']service\.name["']\s*:\s*["']([^"']+)["']/);
    if (match) return match[1];
  }
  for (const [filePath, content] of entries) {
    if (filePath.endsWith("package.json")) {
      try { const parsed = JSON.parse(content) as { name?: unknown }; if (typeof parsed.name === "string") return parsed.name; } catch { /* invalid package manifests are not service-name evidence */ }
    }
  }
  return undefined;
}

function findLine(entries: Array<[string, string]>, regex: RegExp, claim: string): SourceLineEvidence | undefined {
  for (const [filePath, content] of entries) { const match = regex.exec(content); if (match) return lineEvidence(filePath, content, match.index, claim); }
  return undefined;
}
function lineEvidence(filePath: string, content: string, offset: number, claim: string): SourceLineEvidence {
  return { path: filePath, line: content.slice(0, offset).split("\n").length, claim };
}
function normalizeRoute(value: string): string { const normalized = `/${value.split("/").filter(Boolean).join("/")}`; return normalized === "/" ? "/" : normalized; }
function pathSuffix(value: string): string { return value.replace(/^\.+\//, "").replace(/\.(?:js|cjs|mjs|ts)$/i, ""); }
function requirementId(prefix: string, route: { method: string; path: string }): string { return `${prefix}-${slug(route.method)}-${slug(route.path)}`.slice(0, 120); }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "root"; }
function prometheusMetricName(name: string, kind: "counter" | "histogram", unit?: string): string {
  if (kind === "counter") return name.endsWith("_total") ? name : `${name}_total`;
  const unitSuffix = unit === "s" && !name.endsWith("_seconds") ? "_seconds" : "";
  const normalized = `${name}${unitSuffix}`;
  return normalized.endsWith("_count") ? normalized : `${normalized}_count`;
}
function sourceFinding(id: string, ruleId: string, severity: SourceObservabilityFinding["severity"], status: SourceObservabilityFinding["status"], title: string, expected: string, observed: string, risk: string, evidence: SourceLineEvidence[]): SourceObservabilityFinding {
  return { id, ruleId, severity, status, title, expected, observed, risk, evidence };
}
function emptyModel(serviceId: string): ExpectedObservabilityModel { return { schemaVersion: "cloudpilot.expected-observability.v1", serviceId, requirements: [] }; }
function invalidResult(model: ExpectedObservabilityModel, message: string): SourceObservabilityAnalysis {
  return { status: "invalid", sourceDigest: "", routes: [], expectedModel: model, metricConfigs: {}, evidenceByRequirement: {}, findings: [], diagnostics: [message] };
}
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
