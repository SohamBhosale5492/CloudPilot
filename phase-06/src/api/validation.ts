import { validateAndSanitizeUrl } from "../../../phase-01/demo-service/src/inspectors.js";
import type { ExpectedObservabilityModel } from "../../../phase-01/demo-service/src/expected-observability.js";

export interface ProjectPayload {
  name: string;
  repositoryUrl?: string;
  expectedModel?: unknown;
  targetConfig?: ProjectTargetConfig;
}

export interface ValidationResult<T> {
  valid: boolean;
  data?: T;
  error?: string;
}

export interface MetricTargetConfig {
  serviceName: string;
  route: string;
  method?: string;
  minimumCount: number;
  maxEvidenceAgeMs: number;
}

export interface ProjectTargetConfig {
  prometheusBaseUrl?: string;
  healthBaseUrl?: string;
  traceBackendUrl?: string;
  metricConfigs?: Record<string, MetricTargetConfig>;
}

const TARGET_CONFIG_KEYS = new Set(["prometheusBaseUrl", "healthBaseUrl", "traceBackendUrl", "metricConfigs"]);
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export function validateProjectTargetConfig(value: unknown): ValidationResult<ProjectTargetConfig> {
  if (!isRecord(value)) return { valid: false, error: "targetConfig must be a JSON object." };
  for (const key of Object.keys(value)) {
    if (!TARGET_CONFIG_KEYS.has(key)) return { valid: false, error: `Unsupported telemetry targetConfig field '${key}'.` };
  }

  const result: ProjectTargetConfig = {};
  for (const key of ["prometheusBaseUrl", "healthBaseUrl", "traceBackendUrl"] as const) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string") return { valid: false, error: `targetConfig.${key} must be a URL string.` };
    let parsed: URL;
    try { parsed = new URL(raw); }
    catch { return { valid: false, error: `targetConfig.${key} must be a valid HTTP or HTTPS URL.` }; }
    if (parsed.username || parsed.password || Array.from(parsed.searchParams.keys()).some((item) => /token|secret|key|auth|pass|pwd|credential|sig|session|bearer/i.test(item))) {
      return { valid: false, error: `targetConfig.${key} must not contain credentials or secret query parameters.` };
    }
    const validated = validateAndSanitizeUrl(raw, { allowPrivateIps: true });
    if (!validated.valid || !validated.sanitizedUrl) return { valid: false, error: `Invalid targetConfig.${key}: ${validated.reason ?? "invalid URL"}.` };
    result[key] = validated.sanitizedUrl;
  }

  if (value.metricConfigs !== undefined) {
    if (!isRecord(value.metricConfigs)) return { valid: false, error: "targetConfig.metricConfigs must be an object keyed by metric requirement ID." };
    const metricConfigs: Record<string, MetricTargetConfig> = {};
    for (const [id, raw] of Object.entries(value.metricConfigs)) {
      if (!id.trim() || !isRecord(raw)) return { valid: false, error: "Each metricConfigs entry must have a non-empty requirement ID and object value." };
      const allowed = new Set(["serviceName", "route", "method", "minimumCount", "maxEvidenceAgeMs"]);
      if (Object.keys(raw).some((key) => !allowed.has(key))) return { valid: false, error: `Unsupported field in metricConfigs.${id}.` };
      if (typeof raw.serviceName !== "string" || !raw.serviceName.trim() || typeof raw.route !== "string" ||
          !raw.route.startsWith("/") || raw.route.length > 256 || /[\r\n]/.test(raw.route) ||
          typeof raw.minimumCount !== "number" || !Number.isFinite(raw.minimumCount) || raw.minimumCount < 0 ||
          typeof raw.maxEvidenceAgeMs !== "number" || !Number.isFinite(raw.maxEvidenceAgeMs) || raw.maxEvidenceAgeMs <= 0 || raw.maxEvidenceAgeMs > 86_400_000 ||
          (raw.method !== undefined && (typeof raw.method !== "string" || !HTTP_METHODS.has(raw.method)))) {
        return { valid: false, error: `Invalid metric configuration for requirement '${id}'.` };
      }
      metricConfigs[id] = {
        serviceName: raw.serviceName,
        route: raw.route,
        ...(raw.method === undefined ? {} : { method: raw.method as string }),
        minimumCount: raw.minimumCount,
        maxEvidenceAgeMs: raw.maxEvidenceAgeMs
      };
    }
    result.metricConfigs = metricConfigs;
  }
  return { valid: true, data: result };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateProjectCreatePayload(body: unknown): ValidationResult<ProjectPayload> {
  if (typeof body !== "object" || body === null) {
    return { valid: false, error: "Request body must be a JSON object." };
  }

  const b = body as Record<string, unknown>;

  if (typeof b.name !== "string" || b.name.trim().length === 0) {
    return { valid: false, error: "Field 'name' is required and must be a non-empty string." };
  }

  if (b.name.trim().length > 100) {
    return { valid: false, error: "Field 'name' cannot exceed 100 characters." };
  }

  let repositoryUrl: string | undefined = undefined;
  if (b.repositoryUrl !== undefined && b.repositoryUrl !== null) {
    if (typeof b.repositoryUrl !== "string") {
      return { valid: false, error: "Field 'repositoryUrl' must be a string." };
    }
    const urlRes = validateAndSanitizeUrl(b.repositoryUrl);
    if (!urlRes.valid || !urlRes.sanitizedUrl) {
      return { valid: false, error: `Invalid 'repositoryUrl': ${urlRes.reason ?? "malformed URL"}.` };
    }
    repositoryUrl = urlRes.sanitizedUrl;
  }

  let expectedModel: unknown = undefined;
  if (b.expectedModel !== undefined && b.expectedModel !== null) {
    if (typeof b.expectedModel !== "object") {
      return { valid: false, error: "Field 'expectedModel' must be a valid JSON object." };
    }
    const model = b.expectedModel as Partial<ExpectedObservabilityModel>;
    if (!Array.isArray(model.requirements)) {
      return { valid: false, error: "Field 'expectedModel.requirements' must be an array." };
    }
    expectedModel = b.expectedModel;
  }

  let targetConfig: ProjectPayload["targetConfig"] = undefined;
  if (b.targetConfig !== undefined && b.targetConfig !== null) {
    const validated = validateProjectTargetConfig(b.targetConfig);
    if (!validated.valid || !validated.data) return { valid: false, error: validated.error };
    targetConfig = validated.data;
  }

  return {
    valid: true,
    data: {
      name: b.name.trim(),
      repositoryUrl,
      expectedModel,
      targetConfig
    }
  };
}

export function sanitizeErrorDetails(error: unknown): string {
  if (!error) {
    return "Unknown error";
  }
  const msg = error instanceof Error ? error.message : String(error);
  // Redact token/secret/password patterns
  return msg
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|key|secret|password|sig|auth)=)[^&]*/gi, "$1[REDACTED]");
}
