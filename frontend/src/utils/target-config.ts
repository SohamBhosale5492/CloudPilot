import type { ProjectTargetConfig } from "../types/api";

const ALLOWED_TARGETS = new Set(["prometheusBaseUrl", "healthBaseUrl", "traceBackendUrl", "metricConfigs"]);
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export function validateTelemetryTargetConfig(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Target configuration must be a JSON object.";
  const config = value as Record<string, unknown>;
  const unsupported = Object.keys(config).find((key) => !ALLOWED_TARGETS.has(key));
  if (unsupported) return `Unsupported target type or field: ${unsupported}.`;
  for (const key of ["prometheusBaseUrl", "healthBaseUrl", "traceBackendUrl"] as const) {
    const raw = config[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string") return `${key} must be a URL string.`;
    try {
      const url = new URL(raw);
      if (!(["http:", "https:"].includes(url.protocol)) || !url.hostname || url.username || url.password ||
          Array.from(url.searchParams.keys()).some((name) => /token|secret|key|auth|pass|pwd|credential|sig|session|bearer/i.test(name))) {
        return `${key} must be an HTTP(S) URL without embedded credentials.`;
      }
    } catch { return `${key} must be a valid HTTP(S) URL.`; }
  }
  if (config.metricConfigs !== undefined) {
    if (!config.metricConfigs || typeof config.metricConfigs !== "object" || Array.isArray(config.metricConfigs)) return "metricConfigs must be an object keyed by requirement ID.";
    for (const [id, raw] of Object.entries(config.metricConfigs)) {
      if (!id.trim() || !raw || typeof raw !== "object" || Array.isArray(raw)) return "Each metric config must be an object keyed by requirement ID.";
      const item = raw as Record<string, unknown>;
      const allowed = new Set(["serviceName", "route", "method", "minimumCount", "maxEvidenceAgeMs"]);
      if (Object.keys(item).some((key) => !allowed.has(key))) return `Unsupported metricConfigs.${id} field.`;
      if (typeof item.serviceName !== "string" || !item.serviceName.trim() || typeof item.route !== "string" || !item.route.startsWith("/") ||
          (item.method !== undefined && (typeof item.method !== "string" || !HTTP_METHODS.has(item.method))) ||
          typeof item.minimumCount !== "number" || !Number.isFinite(item.minimumCount) || item.minimumCount < 0 ||
          typeof item.maxEvidenceAgeMs !== "number" || !Number.isFinite(item.maxEvidenceAgeMs) || item.maxEvidenceAgeMs <= 0 || item.maxEvidenceAgeMs > 86_400_000) {
        return `Invalid metric config for requirement ${id}.`;
      }
    }
  }
  return null;
}

export function localPhase01TargetExample(expectedModel: unknown): ProjectTargetConfig {
  const requirements = expectedModel && typeof expectedModel === "object" && "requirements" in expectedModel &&
    Array.isArray(expectedModel.requirements) ? expectedModel.requirements : [];
  const metricConfigs: NonNullable<ProjectTargetConfig["metricConfigs"]> = {};
  for (const requirement of requirements) {
    if (!requirement || typeof requirement !== "object" || !("id" in requirement) || !("signal" in requirement) || requirement.signal !== "metric" || typeof requirement.id !== "string") continue;
    metricConfigs[requirement.id] = {
      serviceName: "demo-service", route: "/api/demo", method: "GET", minimumCount: 1, maxEvidenceAgeMs: 60_000
    };
  }
  return {
    prometheusBaseUrl: "http://127.0.0.1:9090",
    healthBaseUrl: "http://127.0.0.1:3000",
    metricConfigs
  };
}
