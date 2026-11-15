import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export interface TracingConfig {
  readonly enabled: boolean;
  readonly serviceName?: string;
  readonly propagators: readonly string[];
  readonly otlpEndpoint?: string;
  readonly sampleRatio: number;
  readonly configured: boolean;
}

const DEFAULT_TRACING_CONFIG: TracingConfig = {
  enabled: true,
  propagators: ["tracecontext", "baggage"],
  sampleRatio: 1.0,
  configured: false
};

const VALID_PROPAGATORS = new Set(["tracecontext", "baggage"]);

/**
 * Parses and validates tracing YAML configuration.
 */
export function parseTracingConfig(yamlText: string): TracingConfig {
  if (!yamlText || !yamlText.trim()) {
    return DEFAULT_TRACING_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText);
  } catch (err) {
    console.warn("Failed to parse tracing configuration YAML:", err);
    return DEFAULT_TRACING_CONFIG;
  }

  if (!parsed || typeof parsed !== "object") {
    return DEFAULT_TRACING_CONFIG;
  }

  const tracing = (parsed as { tracing?: unknown }).tracing;
  if (!tracing || typeof tracing !== "object" || Array.isArray(tracing)) {
    return DEFAULT_TRACING_CONFIG;
  }

  const record = tracing as Record<string, unknown>;
  const enabled = typeof record.enabled === "boolean" ? record.enabled : true;
  const serviceName =
    typeof record.service_name === "string" && record.service_name.trim().length > 0
      ? record.service_name.trim()
      : undefined;
  const otlpEndpoint =
    typeof record.otlp_endpoint === "string" && record.otlp_endpoint.trim().length > 0
      ? record.otlp_endpoint.trim()
      : undefined;

  let sampleRatio = 1.0;
  if (typeof record.sample_ratio === "number" && Number.isFinite(record.sample_ratio)) {
    sampleRatio = Math.max(0, Math.min(1, record.sample_ratio));
  }

  const propagators: string[] = [];
  if (Array.isArray(record.propagators)) {
    for (const item of record.propagators) {
      if (typeof item === "string" && VALID_PROPAGATORS.has(item.trim().toLowerCase())) {
        const normalized = item.trim().toLowerCase();
        if (!propagators.includes(normalized)) {
          propagators.push(normalized);
        }
      }
    }
  } else {
    propagators.push("tracecontext", "baggage");
  }

  return {
    enabled,
    ...(serviceName ? { serviceName } : {}),
    propagators,
    ...(otlpEndpoint ? { otlpEndpoint } : {}),
    sampleRatio,
    configured: true
  };
}

/**
 * Resolves the tracing configuration file path from explicit path, env, or well-known locations.
 */
export function resolveTracingConfigPath(explicitPath?: string): string | null {
  if (explicitPath !== undefined) {
    return fs.existsSync(explicitPath) ? explicitPath : null;
  }

  const envPath = process.env.TRACING_CONFIG_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const candidates = [
    path.resolve(process.cwd(), "config/observability/tracing.yaml"),
    path.resolve(__dirname, "../../config/observability/tracing.yaml"),
    path.resolve(__dirname, "../../../config/observability/tracing.yaml"),
    path.resolve(process.cwd(), "../../config/observability/tracing.yaml")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Loads tracing configuration from YAML file, or returns safe defaults if absent.
 */
export function loadTracingConfig(filePath?: string): TracingConfig {
  const resolved = resolveTracingConfigPath(filePath);
  if (!resolved) {
    return DEFAULT_TRACING_CONFIG;
  }

  try {
    const content = fs.readFileSync(resolved, "utf8");
    return parseTracingConfig(content);
  } catch (error) {
    console.warn("Failed to load tracing config:", error);
    return DEFAULT_TRACING_CONFIG;
  }
}
