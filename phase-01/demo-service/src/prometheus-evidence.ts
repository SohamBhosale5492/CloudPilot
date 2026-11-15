import type { MetricSample, RequestMetricRequirement, TelemetryEvidence } from "./evaluation";

export interface PrometheusEvidenceOptions {
  baseUrl: string;
  requirement: RequestMetricRequirement;
  collectionWindowSeconds: number;
  timeoutMs: number;
  evaluatedAt?: Date;
  collectedAt?: Date;
  scrapeStepSeconds?: number;
  fetchImpl?: typeof fetch;
}

interface PrometheusQueryResponse {
  status?: unknown;
  error?: unknown;
  data?: {
    resultType?: unknown;
    result?: unknown;
  };
}

type PrometheusApiResult =
  | { ok: true; body: PrometheusQueryResponse }
  | { ok: false };

type CoverageResult = "complete" | "incomplete" | "unavailable";

export type PrometheusServiceLabel = "exported_job" | "service_name";

const PROMETHEUS_SERVICE_LABEL = "exported_job";
const PROMETHEUS_SERVICE_NAME_LABEL = "service_name";
const PROMETHEUS_ROUTE_LABEL = "route";
const PROMETHEUS_METHOD_LABEL = "method";
const PROMETHEUS_STATUS_LABEL = "status_code";
const PROMETHEUS_SCRAPE_JOB = "otel-collector";
const DEFAULT_SCRAPE_STEP_SECONDS = 5;
const PROMETHEUS_METRIC_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const SUPPORTED_RESULT_LABELS = new Set([
  PROMETHEUS_SERVICE_LABEL,
  PROMETHEUS_SERVICE_NAME_LABEL,
  PROMETHEUS_ROUTE_LABEL,
  PROMETHEUS_METHOD_LABEL,
  PROMETHEUS_STATUS_LABEL,
  "job",
  "instance",
  "__name__"
]);

export async function collectPrometheusRequestMetricEvidence(options: PrometheusEvidenceOptions): Promise<TelemetryEvidence> {
  const queryTime = validDateOrUndefined(options?.evaluatedAt) ?? new Date();
  const validation = validateOptions(options);

  if (validation !== undefined) {
    return unavailableEvidence(collectedAtIso(queryTime, validDateOrUndefined(options?.collectedAt)));
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const coverage = await collectScrapeCoverage(options, queryTime, fetchImpl, controller.signal);
    const collectedAt = collectedAtIso(queryTime, validDateOrUndefined(options.collectedAt) ?? new Date());

    if (coverage === "unavailable") {
      return unavailableEvidence(collectedAt);
    }

    const primaryQuery = await queryMetricVector(
      options,
      queryTime,
      PROMETHEUS_SERVICE_LABEL,
      fetchImpl,
      controller.signal
    );

    if (!primaryQuery.ok) {
      return unavailableEvidence(collectedAt);
    }

    let rawResults = primaryQuery.result;

    // Fallback to OpenTelemetry resource service_name only when the primary exported_job query yields zero series.
    if (rawResults.length === 0) {
      const fallbackQuery = await queryMetricVector(
        options,
        queryTime,
        PROMETHEUS_SERVICE_NAME_LABEL,
        fetchImpl,
        controller.signal
      );

      if (!fallbackQuery.ok) {
        return unavailableEvidence(collectedAt);
      }

      rawResults = fallbackQuery.result;
    }

    const samples: MetricSample[] = [];

    for (const item of rawResults) {
      const sample = normalizePrometheusResult(item, options.requirement);

      if (sample === undefined) {
        return partialEvidence(collectedAt);
      }

      samples.push(sample);
    }

    return {
      source: "prometheus",
      collectedAt,
      available: true,
      complete: coverage === "complete",
      samples
    };
  } catch {
    return unavailableEvidence(collectedAtIso(queryTime, validDateOrUndefined(options?.collectedAt)));
  } finally {
    clearTimeout(timeout);
  }
}

export function buildPrometheusRequestMetricQuery(
  requirement: RequestMetricRequirement,
  collectionWindowSeconds: number,
  serviceLabel: PrometheusServiceLabel = PROMETHEUS_SERVICE_LABEL
): string {
  if (!isValidPrometheusMetricName(requirement.metricName)) {
    throw new Error("Invalid Prometheus metric name.");
  }

  if (serviceLabel !== PROMETHEUS_SERVICE_LABEL && serviceLabel !== PROMETHEUS_SERVICE_NAME_LABEL) {
    throw new Error("Invalid Prometheus service label.");
  }

  const matchers = [
    `${serviceLabel}="${escapePrometheusLabelValue(requirement.serviceName)}"`,
    `job="${PROMETHEUS_SCRAPE_JOB}"`,
    `${PROMETHEUS_ROUTE_LABEL}="${escapePrometheusLabelValue(requirement.route)}"`
  ];

  if (requirement.method !== undefined) {
    matchers.push(`${PROMETHEUS_METHOD_LABEL}="${escapePrometheusLabelValue(requirement.method)}"`);
  }

  return `sum by (${serviceLabel},${PROMETHEUS_ROUTE_LABEL},${PROMETHEUS_METHOD_LABEL},${PROMETHEUS_STATUS_LABEL},job,instance) ` +
    `(increase(${requirement.metricName}{${matchers.join(",")}}[${collectionWindowSeconds}s]))`;
}

function validateOptions(options: PrometheusEvidenceOptions): string | undefined {
  if (!isObject(options)) {
    return "Options must be an object.";
  }

  if (!isHttpUrl(options.baseUrl)) {
    return "Prometheus baseUrl must be an HTTP(S) URL.";
  }

  if (!isValidPrometheusMetricName(options.requirement?.metricName)) {
    return "Requirement metricName must be a valid Prometheus metric name.";
  }

  if (!Number.isInteger(options.collectionWindowSeconds) || options.collectionWindowSeconds <= 0) {
    return "collectionWindowSeconds must be a positive integer.";
  }

  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    return "timeoutMs must be a positive integer.";
  }

  if (options.evaluatedAt !== undefined && validDateOrUndefined(options.evaluatedAt) === undefined) {
    return "evaluatedAt must be a valid Date.";
  }

  if (options.collectedAt !== undefined && validDateOrUndefined(options.collectedAt) === undefined) {
    return "collectedAt must be a valid Date.";
  }

  if (options.scrapeStepSeconds !== undefined &&
    (!Number.isInteger(options.scrapeStepSeconds) || options.scrapeStepSeconds <= 0)
  ) {
    return "scrapeStepSeconds must be a positive integer.";
  }

  return undefined;
}

function isValidPrometheusMetricName(value: unknown): value is string {
  return typeof value === "string" && PROMETHEUS_METRIC_NAME_PATTERN.test(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);

    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function queryMetricVector(
  options: PrometheusEvidenceOptions,
  queryTime: Date,
  serviceLabel: PrometheusServiceLabel,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<{ ok: true; result: unknown[] } | { ok: false }> {
  const metricResult = await queryPrometheus(
    buildPrometheusQueryUrl(options, queryTime, serviceLabel),
    fetchImpl,
    signal
  );

  if (!metricResult.ok) {
    return { ok: false };
  }

  const body = metricResult.body;

  if (body.status !== "success" || body.data?.resultType !== "vector" || !Array.isArray(body.data.result)) {
    return { ok: false };
  }

  return { ok: true, result: body.data.result };
}

function buildPrometheusQueryUrl(
  options: PrometheusEvidenceOptions,
  queryTime: Date,
  serviceLabel: PrometheusServiceLabel = PROMETHEUS_SERVICE_LABEL
): URL {
  const url = buildPrometheusApiUrl(options.baseUrl, "/api/v1/query");
  url.searchParams.set(
    "query",
    buildPrometheusRequestMetricQuery(options.requirement, options.collectionWindowSeconds, serviceLabel)
  );
  url.searchParams.set("time", String(queryTime.getTime() / 1000));

  return url;
}

function buildPrometheusCoverageUrl(options: PrometheusEvidenceOptions, queryTime: Date): URL {
  const url = buildPrometheusApiUrl(options.baseUrl, "/api/v1/query_range");
  const endSeconds = queryTime.getTime() / 1000;
  const startSeconds = endSeconds - options.collectionWindowSeconds;
  const upSelector = `up{job="${PROMETHEUS_SCRAPE_JOB}"}`;
  const query = `timestamp(${upSelector} == 1)`;

  url.searchParams.set("query", query);
  url.searchParams.set("start", String(startSeconds));
  url.searchParams.set("end", String(endSeconds));
  url.searchParams.set("step", `${options.scrapeStepSeconds ?? DEFAULT_SCRAPE_STEP_SECONDS}s`);

  return url;
}

function buildPrometheusApiUrl(baseUrl: string, apiPath: string): URL {
  const base = new URL(baseUrl);
  const basePath = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  const pathSuffix = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;

  base.pathname = `${basePath}${pathSuffix}`;
  base.search = "";
  base.hash = "";

  return base;
}

async function collectScrapeCoverage(
  options: PrometheusEvidenceOptions,
  queryTime: Date,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<CoverageResult> {
  // This is a bounded coverage check for the lab's configured Prometheus target.
  // timestamp(up == 1) exposes the underlying scrape sample timestamp at each
  // evaluation step. This avoids accepting Prometheus lookback-repeated samples
  // as fresh scrapes, but still does not prove perfect historical completeness
  // or that the demo service emitted every metric.
  const result = await queryPrometheus(buildPrometheusCoverageUrl(options, queryTime), fetchImpl, signal);

  if (!result.ok) {
    return "unavailable";
  }

  const body = result.body;

  if (body.status !== "success" || body.data?.resultType !== "matrix" || !Array.isArray(body.data.result)) {
    return "unavailable";
  }

  if (body.data.result.length === 0) {
    return "incomplete";
  }

  const endSeconds = queryTime.getTime() / 1000;
  const startSeconds = endSeconds - options.collectionWindowSeconds;
  const stepSeconds = options.scrapeStepSeconds ?? DEFAULT_SCRAPE_STEP_SECONDS;

  for (const series of body.data.result) {
    if (!hasCompleteCoverageSeries(series, startSeconds, endSeconds, stepSeconds)) {
      return "incomplete";
    }
  }

  return "complete";
}

function hasCompleteCoverageSeries(series: unknown, startSeconds: number, endSeconds: number, stepSeconds: number): boolean {
  if (!isObject(series) || !isObject(series.metric) || !Array.isArray(series.values) || series.values.length === 0) {
    return false;
  }

  if (
    series.metric.job !== PROMETHEUS_SCRAPE_JOB ||
    !isNonEmptyString(series.metric.instance)
  ) {
    return false;
  }

  const samples = series.values.map(parseCoverageSample);

  if (samples.some((sample) => sample === undefined)) {
    return false;
  }

  const typedSamples = samples as Array<{ timestamp: number; value: number }>;

  if (!approximatelyEqual(typedSamples[0].timestamp, startSeconds) ||
    !approximatelyEqual(typedSamples[typedSamples.length - 1].timestamp, endSeconds)
  ) {
    return false;
  }

  for (let index = 0; index < typedSamples.length; index += 1) {
    const evaluationTimestamp = typedSamples[index].timestamp;
    const underlyingSampleTimestamp = typedSamples[index].value;

    if (
      underlyingSampleTimestamp > evaluationTimestamp ||
      underlyingSampleTimestamp < startSeconds ||
      evaluationTimestamp - underlyingSampleTimestamp > stepSeconds
    ) {
      return false;
    }

    if (index > 0 && !approximatelyEqual(typedSamples[index].timestamp - typedSamples[index - 1].timestamp, stepSeconds)) {
      return false;
    }
  }

  return true;
}

function parseCoverageSample(value: unknown): { timestamp: number; value: number } | undefined {
  if (!Array.isArray(value) || value.length < 2) {
    return undefined;
  }

  const timestamp = Number(value[0]);
  const sampleValue = Number(value[1]);

  if (!Number.isFinite(timestamp) || !Number.isFinite(sampleValue)) {
    return undefined;
  }

  return {
    timestamp,
    value: sampleValue
  };
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.001;
}

async function queryPrometheus(url: URL, fetchImpl: typeof fetch, signal: AbortSignal): Promise<PrometheusApiResult> {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal
    });

    if (!response.ok) {
      return { ok: false };
    }

    const body = await readPrometheusJson(response, signal);

    return { ok: true, body };
  } catch {
    return { ok: false };
  }
}

async function readPrometheusJson(response: Response, signal: AbortSignal): Promise<PrometheusQueryResponse> {
  const text = await withAbort(response.text(), signal);

  return JSON.parse(text) as PrometheusQueryResponse;
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error("aborted"));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));

    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function normalizePrometheusResult(result: unknown, requirement: RequestMetricRequirement): MetricSample | undefined {
  if (!isObject(result) || !isObject(result.metric) || !Array.isArray(result.value) || result.value.length < 2) {
    return undefined;
  }

  const metric = result.metric;
  const rawValue = result.value[1];

  if (!hasOnlySupportedPrometheusLabels(metric)) {
    return undefined;
  }

  // Prometheus aggregation drops the special __name__ label. The query's
  // selector still pins the requested metric; validate the label when present.
  if (metric.__name__ !== undefined && metric.__name__ !== requirement.metricName) {
    return undefined;
  }

  const serviceName = resolvePrometheusServiceLabel(metric);

  if (
    serviceName === undefined ||
    serviceName !== requirement.serviceName ||
    metric[PROMETHEUS_ROUTE_LABEL] !== requirement.route ||
    (requirement.method !== undefined && metric[PROMETHEUS_METHOD_LABEL] !== requirement.method) ||
    metric.job !== PROMETHEUS_SCRAPE_JOB ||
    !isNonEmptyString(metric.instance)
  ) {
    return undefined;
  }

  if (typeof rawValue !== "string") {
    return undefined;
  }

  const value = Number(rawValue);

  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }

  if (
    !isNonEmptyString(serviceName) ||
    !isNonEmptyString(metric[PROMETHEUS_ROUTE_LABEL]) ||
    !isNonEmptyString(metric[PROMETHEUS_METHOD_LABEL]) ||
    (PROMETHEUS_STATUS_LABEL in metric && !isNonEmptyString(metric[PROMETHEUS_STATUS_LABEL]))
  ) {
    return undefined;
  }

  return {
    metricName: requirement.metricName,
    labels: {
      serviceName,
      route: metric[PROMETHEUS_ROUTE_LABEL],
      method: metric[PROMETHEUS_METHOD_LABEL],
      statusCode: isNonEmptyString(metric[PROMETHEUS_STATUS_LABEL]) ? metric[PROMETHEUS_STATUS_LABEL] : undefined
    },
    value
  };
}

function resolvePrometheusServiceLabel(metric: Record<string, unknown>): string | undefined {
  const hasExportedJob = Object.prototype.hasOwnProperty.call(metric, PROMETHEUS_SERVICE_LABEL) &&
    metric[PROMETHEUS_SERVICE_LABEL] !== undefined;
  const hasServiceName = Object.prototype.hasOwnProperty.call(metric, PROMETHEUS_SERVICE_NAME_LABEL) &&
    metric[PROMETHEUS_SERVICE_NAME_LABEL] !== undefined;

  if (!hasExportedJob && !hasServiceName) {
    return undefined;
  }

  const exportedJob = metric[PROMETHEUS_SERVICE_LABEL];
  const serviceName = metric[PROMETHEUS_SERVICE_NAME_LABEL];

  if (hasExportedJob && !isNonEmptyString(exportedJob)) {
    return undefined;
  }

  if (hasServiceName && !isNonEmptyString(serviceName)) {
    return undefined;
  }

  // Reject conflicting service aliases rather than silently preferring one.
  if (hasExportedJob && hasServiceName && exportedJob !== serviceName) {
    return undefined;
  }

  return (hasExportedJob ? exportedJob : serviceName) as string;
}

function unavailableEvidence(collectedAt: string): TelemetryEvidence {
  return {
    source: "prometheus",
    collectedAt,
    available: false,
    complete: false,
    samples: []
  };
}

function partialEvidence(collectedAt: string): TelemetryEvidence {
  return {
    source: "prometheus",
    collectedAt,
    available: true,
    complete: false,
    samples: []
  };
}

function collectedAtIso(queryTime: Date, acquisitionTime: Date = new Date()): string {
  // The evaluator freshness check uses collectedAt. Use the earlier of the
  // telemetry query/window end and actual acquisition time so an old requested
  // window cannot appear fresh merely because it was fetched later.
  return new Date(Math.min(queryTime.getTime(), acquisitionTime.getTime())).toISOString();
}

function validDateOrUndefined(value: unknown): Date | undefined {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : undefined;
}

function escapePrometheusLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, "\\\"");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasOnlySupportedPrometheusLabels(labels: Record<string, unknown>): boolean {
  return Object.keys(labels).every((label) => SUPPORTED_RESULT_LABELS.has(label));
}
