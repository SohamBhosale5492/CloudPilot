import { validateAndSanitizeUrl } from "../../../phase-01/demo-service/src/inspectors.js";
import type { ExpectedObservabilityModel } from "../../../phase-01/demo-service/src/expected-observability.js";

export interface ProjectPayload {
  name: string;
  repositoryUrl?: string;
  expectedModel?: unknown;
  targetConfig?: {
    baseUrl?: string;
    prometheusBaseUrl?: string;
    healthBaseUrl?: string;
    traceBackendUrl?: string;
    logBackendUrl?: string;
    alertBackendUrl?: string;
    metricConfigs?: Record<string, unknown>;
  };
}

export interface ValidationResult<T> {
  valid: boolean;
  data?: T;
  error?: string;
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
    if (typeof b.targetConfig !== "object") {
      return { valid: false, error: "Field 'targetConfig' must be an object." };
    }
    const tc = b.targetConfig as Record<string, unknown>;
    targetConfig = {};

    for (const [key, val] of Object.entries(tc)) {
      if (typeof val === "string") {
        const urlRes = validateAndSanitizeUrl(val, { allowPrivateIps: true });
        if (!urlRes.valid || !urlRes.sanitizedUrl) {
          return { valid: false, error: `Invalid URL for targetConfig.${key}: ${urlRes.reason ?? "malformed URL"}.` };
        }
        (targetConfig as Record<string, unknown>)[key] = urlRes.sanitizedUrl;
      } else if (key === "metricConfigs" && typeof val === "object" && val !== null) {
        targetConfig.metricConfigs = val as Record<string, unknown>;
      }
    }
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
