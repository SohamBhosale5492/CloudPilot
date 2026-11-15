import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { metrics, type Counter } from "@opentelemetry/api";

const PROMETHEUS_METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

export interface ConfiguredMetricLabels {
  readonly service?: string;
  readonly route?: string;
  readonly method?: string;
  readonly [key: string]: string | undefined;
}

export interface ConfiguredMetricEntry {
  readonly name: string;
  readonly labels?: ConfiguredMetricLabels;
}

export interface ConfiguredMetricRuntime {
  readonly definition: ConfiguredMetricEntry;
  readonly counter: Counter;
  readonly otelMetricName: string;
}

export interface RequestMetricContext {
  readonly route: string;
  readonly method: string;
  readonly statusCode: number;
}

/**
 * Validates a metric name according to Prometheus / OpenTelemetry naming rules.
 */
export function isValidMetricName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 200 &&
    PROMETHEUS_METRIC_NAME_RE.test(name)
  );
}

/**
 * Strips terminal `_total` suffix if present so OpenTelemetry metric counters
 * export to Prometheus with the standard single `_total` suffix.
 */
export function normalizeOtelCounterName(metricName: string): string {
  return metricName.endsWith("_total") ? metricName.slice(0, -6) : metricName;
}

/**
 * Parses and validates metrics YAML configuration string.
 * Returns valid ConfiguredMetricEntry objects. Malformed or invalid entries are skipped.
 */
export function parseMetricsConfig(yamlText: string): ConfiguredMetricEntry[] {
  if (!yamlText || !yamlText.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText);
  } catch (err) {
    console.warn("Failed to parse metrics configuration YAML:", err);
    return [];
  }

  if (!parsed || typeof parsed !== "object") {
    return [];
  }

  const rawMetrics = (parsed as { metrics?: unknown }).metrics;
  if (!Array.isArray(rawMetrics)) {
    return [];
  }

  const results: ConfiguredMetricEntry[] = [];
  for (const item of rawMetrics) {
    if (!item || typeof item !== "object") continue;
    const { name, labels } = item as { name?: unknown; labels?: unknown };

    if (!isValidMetricName(name)) {
      console.warn(`Skipping invalid metric name in metrics config: ${String(name)}`);
      continue;
    }

    let parsedLabels: ConfiguredMetricLabels | undefined;
    if (labels && typeof labels === "object" && !Array.isArray(labels)) {
      const labelObj: Record<string, string> = {};
      for (const [key, value] of Object.entries(labels as Record<string, unknown>)) {
        if (typeof value === "string") {
          labelObj[key] = value;
        }
      }
      parsedLabels = labelObj;
    }

    results.push({
      name,
      ...(parsedLabels ? { labels: parsedLabels } : {})
    });
  }

  return results;
}

/**
 * Resolves the configuration file path from environment or well-known locations.
 */
export function resolveMetricsConfigPath(explicitPath?: string): string | null {
  if (explicitPath !== undefined) {
    return fs.existsSync(explicitPath) ? explicitPath : null;
  }

  const envPath = process.env.METRICS_CONFIG_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const candidates = [
    path.resolve(process.cwd(), "config/observability/metrics.yaml"),
    path.resolve(__dirname, "../../config/observability/metrics.yaml"),
    path.resolve(__dirname, "../../../config/observability/metrics.yaml"),
    path.resolve(process.cwd(), "../../config/observability/metrics.yaml")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

const registeredCounters = new Map<string, Counter>();

/**
 * Loads and initializes configured metric counters from a YAML file.
 */
export function loadMetricsConfig(filePath?: string): ConfiguredMetricRuntime[] {
  const resolved = resolveMetricsConfigPath(filePath);
  if (!resolved) {
    return [];
  }

  try {
    const content = fs.readFileSync(resolved, "utf8");
    const entries = parseMetricsConfig(content);
    const meter = metrics.getMeter("cloudpilot-demo-service", "0.1.0");

    const runtimes: ConfiguredMetricRuntime[] = [];
    for (const entry of entries) {
      const otelName = normalizeOtelCounterName(entry.name);
      let counter = registeredCounters.get(otelName);
      if (!counter) {
        counter = meter.createCounter(otelName, {
          description: `CloudPilot dynamic remediation metric: ${entry.name}`
        });
        registeredCounters.set(otelName, counter);
      }
      runtimes.push({
        definition: entry,
        counter,
        otelMetricName: otelName
      });
    }

    return runtimes;
  } catch (error) {
    console.warn("Failed to load metrics config:", error);
    return [];
  }
}

/**
 * Records an increment for any configured metric whose selector labels match the request context.
 */
export function recordMatchingMetrics(
  configured: ReadonlyArray<ConfiguredMetricRuntime>,
  context: RequestMetricContext
): void {
  for (const item of configured) {
    const labels = item.definition.labels;

    // If route selector is specified, it must match
    if (labels?.route && labels.route !== context.route) {
      continue;
    }

    // If method selector is specified, it must match (case-insensitive)
    if (labels?.method && labels.method.toUpperCase() !== context.method.toUpperCase()) {
      continue;
    }

    const metricAttributes: Record<string, string> = {
      method: context.method,
      route: context.route,
      status_code: String(context.statusCode)
    };

    if (labels) {
      for (const [key, val] of Object.entries(labels)) {
        if (val !== undefined && key !== "route" && key !== "method") {
          metricAttributes[key] = val;
        }
      }
    }

    item.counter.add(1, metricAttributes);
  }
}
