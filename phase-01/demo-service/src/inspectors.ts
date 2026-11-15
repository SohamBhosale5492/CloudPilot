import type {
  ExpectedAlertRequirement,
  ExpectedHealthCheckRequirement,
  ExpectedLogRequirement,
  ExpectedMetricRequirement,
  ExpectedRequirement,
  ExpectedTraceRequirement
} from "./expected-observability";
import type { MetricSample, RequestMetricRequirement, TelemetryEvidence } from "./evaluation";
import { collectPrometheusRequestMetricEvidence } from "./prometheus-evidence";

export type InspectorSignal = "metric" | "log" | "trace" | "health" | "alert";
export type InspectorDiagnosticSeverity = "info" | "warning" | "error";

export type InspectorDiagnosticCode =
  | "BACKEND_UNCONFIGURED"
  | "UNSUPPORTED_ADAPTER"
  | "TARGET_INVALID"
  | "PROBE_TIMEOUT"
  | "PROBE_FAILED"
  | "SSRF_BLOCKED"
  | "RESPONSE_TOO_LARGE"
  | "STATUS_ERROR"
  | "SCRAPE_INCOMPLETE"
  | "METRIC_UNAVAILABLE"
  | "REDIRECT_LIMIT_EXCEEDED"
  | "REDIRECT_DISALLOWED";

export interface InspectorDiagnostic {
  code: InspectorDiagnosticCode;
  severity: InspectorDiagnosticSeverity;
  message: string;
  path?: string;
}

export interface InspectorProvenance {
  target: string;
  adapter: string;
  source?: string;
}

export interface InspectorEvidence<T = unknown> {
  signal: InspectorSignal;
  requirementId: string;
  collectedAt: string;
  available: boolean;
  complete: boolean;
  provenance: InspectorProvenance;
  data?: T;
  diagnostics: InspectorDiagnostic[];
}

export interface HealthEvidenceData {
  endpoint: string;
  statusCode?: number;
  statusText?: string;
  latencyMs?: number;
  probeOutcome: "healthy" | "unhealthy" | "error" | "timeout";
}

export interface MetricEvidenceData {
  samples: MetricSample[];
  source: TelemetryEvidence["source"];
}

export interface UnconfiguredEvidenceData {
  reason: string;
}

export interface TraceEvidenceData {
  serviceName: string;
  traceCount: number;
}

export interface AlertRuleMatch {
  name: string;
  group: string;
  state: string;
  health: string;
  query: string;
  activeAlerts?: number;
  lastEvaluation?: string;
}

export interface AlertEvidenceData {
  matchedRules: AlertRuleMatch[];
  totalLoadedRules: number;
  ruleHealthy: boolean;
  firingAlertCount?: number;
}

export interface LogEvidenceData {
  totalEntries: number;
  validJsonEntries: number;
  observedFields: string[];
  missingFields: string[];
}

export interface HealthInspectorOptions {
  baseUrl: string;
  requirement: ExpectedHealthCheckRequirement;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  allowPrivateIps?: boolean;
  collectedAt?: Date;
  fetchImpl?: typeof fetch;
}

export interface MetricInspectorOptions {
  baseUrl: string;
  requirement: ExpectedMetricRequirement | RequestMetricRequirement;
  serviceName?: string;
  route?: string;
  method?: string;
  minimumCount?: number;
  maxEvidenceAgeMs?: number;
  collectionWindowSeconds?: number;
  timeoutMs?: number;
  scrapeStepSeconds?: number;
  allowPrivateIps?: boolean;
  evaluatedAt?: Date;
  collectedAt?: Date;
  fetchImpl?: typeof fetch;
}

export interface TraceInspectorOptions {
  requirement: ExpectedTraceRequirement;
  backendUrl?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  allowPrivateIps?: boolean;
  fetchImpl?: typeof fetch;
  collectedAt?: Date;
}

export interface LogInspectorOptions {
  requirement: ExpectedLogRequirement;
  backendUrl?: string;
  serviceName?: string;
  lookbackMinutes?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  allowPrivateIps?: boolean;
  fetchImpl?: typeof fetch;
  collectedAt?: Date;
}

export interface AlertInspectorOptions {
  requirement: ExpectedAlertRequirement;
  backendUrl?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  allowPrivateIps?: boolean;
  fetchImpl?: typeof fetch;
  collectedAt?: Date;
}

export interface InspectorConfiguration {
  prometheusBaseUrl?: string;
  healthBaseUrl?: string;
  traceBackendUrl?: string;
  logBackendUrl?: string;
  alertBackendUrl?: string;
  timeoutMs?: number;
  collectionWindowSeconds?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  allowPrivateIps?: boolean;
  fetchImpl?: typeof fetch;
  metricConfigs?: Record<string, {
    serviceName: string;
    route: string;
    method?: string;
    minimumCount?: number;
    maxEvidenceAgeMs?: number;
  }>;
  collectedAt?: Date;
  evaluatedAt?: Date;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

const SENSITIVE_QUERY_PATTERNS = [
  "token",
  "secret",
  "key",
  "auth",
  "pass",
  "pwd",
  "credential",
  "sig",
  "session",
  "bearer"
];

interface UrlValidationResult {
  valid: boolean;
  sanitizedUrl?: string;
  reason?: string;
  diagnosticCode?: InspectorDiagnosticCode;
}

export interface UrlValidationOptions {
  allowPrivateIps?: boolean;
}

export function validateAndSanitizeUrl(rawUrl: string, options: UrlValidationOptions = {}): UrlValidationResult {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    return {
      valid: false,
      reason: "URL must be a non-empty string.",
      diagnosticCode: "TARGET_INVALID"
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      valid: false,
      reason: `Malformed URL: ${rawUrl}`,
      diagnosticCode: "TARGET_INVALID"
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      valid: false,
      reason: `Unsupported protocol ${parsed.protocol}. Only http and https are allowed.`,
      diagnosticCode: "TARGET_INVALID"
    };
  }

  if (parsed.port !== "") {
    const port = Number.parseInt(parsed.port, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return {
        valid: false,
        reason: `Invalid port ${parsed.port}.`,
        diagnosticCode: "TARGET_INVALID"
      };
    }
  }

  const hostname = parsed.hostname.toLowerCase();
  const restriction = checkRestrictedHost(hostname, Boolean(options.allowPrivateIps));

  if (restriction.restricted) {
    return {
      valid: false,
      reason: restriction.reason ?? "Target destination rejected by SSRF policy.",
      diagnosticCode: "SSRF_BLOCKED"
    };
  }

  // Redact authority credentials
  parsed.username = "";
  parsed.password = "";

  // Redact sensitive query parameters
  for (const key of Array.from(parsed.searchParams.keys())) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_QUERY_PATTERNS.some((pattern) => lowerKey.includes(pattern))) {
      parsed.searchParams.set(key, "REDACTED");
    }
  }

  return {
    valid: true,
    sanitizedUrl: parsed.toString()
  };
}

function checkRestrictedHost(rawHostname: string, allowPrivateIps: boolean): { restricted: boolean; reason?: string } {
  const cleanHost = rawHostname.replace(/^\[|\]$/g, "");

  // Hostname matching
  if (cleanHost === "metadata.google.internal" || cleanHost.endsWith(".metadata.google.internal")) {
    return { restricted: true, reason: "Cloud metadata service is blocked by SSRF policy." };
  }

  if (cleanHost === "localhost" || cleanHost.endsWith(".localhost")) {
    if (!allowPrivateIps) {
      return { restricted: true, reason: "Loopback destination (localhost) is blocked by SSRF policy." };
    }
    return { restricted: false };
  }

  // IPv6 checks
  if (cleanHost.includes(":")) {
    if (cleanHost === "::1" || cleanHost === "0:0:0:0:0:0:0:1") {
      if (!allowPrivateIps) {
        return { restricted: true, reason: "IPv6 loopback (::1) is blocked by SSRF policy." };
      }
      return { restricted: false };
    }

    if (cleanHost === "::" || cleanHost === "0:0:0:0:0:0:0:0") {
      return { restricted: true, reason: "IPv6 unspecified address is blocked by SSRF policy." };
    }

    if (
      cleanHost.startsWith("fe8") ||
      cleanHost.startsWith("fe9") ||
      cleanHost.startsWith("fea") ||
      cleanHost.startsWith("feb")
    ) {
      return { restricted: true, reason: "IPv6 link-local address is blocked by SSRF policy." };
    }

    if (cleanHost.startsWith("fc") || cleanHost.startsWith("fd")) {
      if (!allowPrivateIps) {
        return { restricted: true, reason: "IPv6 unique local address is blocked by SSRF policy." };
      }
      return { restricted: false };
    }

    if (cleanHost.startsWith("::ffff:")) {
      const v4Part = cleanHost.slice(7);
      if (v4Part.includes(":")) {
        const hexParts = v4Part.split(":");
        if (hexParts.length === 2) {
          const h1 = Number.parseInt(hexParts[0], 16);
          const h2 = Number.parseInt(hexParts[1], 16);
          if (Number.isInteger(h1) && Number.isInteger(h2)) {
            const a = (h1 >> 8) & 255;
            const b = h1 & 255;
            const c = (h2 >> 8) & 255;
            const d = h2 & 255;
            return checkIPv4Components(a, b, c, d, allowPrivateIps);
          }
        }
      }
      return checkIPv4(v4Part, allowPrivateIps);
    }

    return { restricted: false };
  }

  return checkIPv4(cleanHost, allowPrivateIps);
}

function checkIPv4Components(a: number, b: number, c: number, d: number, allowPrivateIps: boolean): { restricted: boolean; reason?: string } {
  // Link-local / Cloud Metadata (169.254.0.0/16) - always blocked
  if (a === 169 && b === 254) {
    return { restricted: true, reason: `IPv4 link-local/metadata address (${a}.${b}.${c}.${d}) is blocked by SSRF policy.` };
  }

  // 0.0.0.0/8 current network
  if (a === 0) {
    return { restricted: true, reason: `IPv4 current network address (${a}.${b}.${c}.${d}) is blocked by SSRF policy.` };
  }

  // 255.255.255.255 broadcast
  if (a === 255 && b === 255 && c === 255 && d === 255) {
    return { restricted: true, reason: `IPv4 broadcast address (${a}.${b}.${c}.${d}) is blocked by SSRF policy.` };
  }

  if (!allowPrivateIps) {
    // Loopback 127.0.0.0/8
    if (a === 127) {
      return { restricted: true, reason: `IPv4 loopback address (${a}.${b}.${c}.${d}) is blocked by SSRF policy.` };
    }

    // Private RFC 1918 (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
    if (a === 10) {
      return { restricted: true, reason: `Private IPv4 address (${a}.${b}.${c}.${d}) is blocked by SSRF policy.` };
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return { restricted: true, reason: `Private IPv4 address (${a}.${b}.${c}.${d}) is blocked by SSRF policy.` };
    }
    if (a === 192 && b === 168) {
      return { restricted: true, reason: `Private IPv4 address (${a}.${b}.${c}.${d}) is blocked by SSRF policy.` };
    }

    // Carrier-grade NAT 100.64.0.0/10
    if (a === 100 && b >= 64 && b <= 127) {
      return { restricted: true, reason: `Carrier-grade NAT address (${a}.${b}.${c}.${d}) is blocked by SSRF policy.` };
    }
  }

  return { restricted: false };
}

function checkIPv4(host: string, allowPrivateIps: boolean): { restricted: boolean; reason?: string } {
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 0;

  const parts = host.split(".");
  if (parts.length === 4) {
    const numbers: number[] = [];
    for (const part of parts) {
      let num: number;
      if (part.startsWith("0x") || part.startsWith("0X")) {
        num = Number.parseInt(part, 16);
      } else if (part.startsWith("0") && part.length > 1) {
        num = Number.parseInt(part, 8);
      } else {
        num = Number.parseInt(part, 10);
      }
      if (!Number.isInteger(num) || num < 0 || num > 255) {
        return { restricted: false };
      }
      numbers.push(num);
    }
    [a, b, c, d] = numbers;
  } else if (parts.length === 1 && /^(0x[0-9a-fA-F]+|\d+)$/.test(parts[0])) {
    let num: number;
    if (parts[0].startsWith("0x") || parts[0].startsWith("0X")) {
      num = Number.parseInt(parts[0], 16);
    } else if (parts[0].startsWith("0") && parts[0].length > 1) {
      num = Number.parseInt(parts[0], 8);
    } else {
      num = Number.parseInt(parts[0], 10);
    }
    if (!Number.isFinite(num) || num < 0 || num > 0xffffffff) {
      return { restricted: false };
    }
    a = (num >>> 24) & 255;
    b = (num >>> 16) & 255;
    c = (num >>> 8) & 255;
    d = num & 255;
  } else {
    return { restricted: false };
  }

  return checkIPv4Components(a, b, c, d, allowPrivateIps);
}

export async function inspectHealthCheck(options: HealthInspectorOptions): Promise<InspectorEvidence<HealthEvidenceData>> {
  const requirementId = options?.requirement?.id ?? "<unknown>";
  const endpoint = options?.requirement?.endpoint ?? "/";
  const now = options?.collectedAt ?? new Date();
  const collectedAt = now.toISOString();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRedirects = options?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowPrivateIps = Boolean(options?.allowPrivateIps);
  const fetchImpl = options?.fetchImpl ?? fetch;

  const resolvedUrl = resolveEndpoint(options?.baseUrl, endpoint);
  const validation = validateAndSanitizeUrl(resolvedUrl, { allowPrivateIps });

  if (!validation.valid || !validation.sanitizedUrl) {
    return {
      signal: "health",
      requirementId,
      collectedAt,
      available: false,
      complete: false,
      provenance: {
        target: validation.sanitizedUrl ?? "<invalid-url>",
        adapter: "http-health-probe"
      },
      data: {
        endpoint,
        probeOutcome: "error"
      },
      diagnostics: [
        {
          code: validation.diagnosticCode ?? "TARGET_INVALID",
          severity: "error",
          message: validation.reason ?? "Invalid target URL."
        }
      ]
    };
  }

  const targetUrl = validation.sanitizedUrl;
  let currentUrl = targetUrl;
  let redirectsRemaining = maxRedirects;
  const startTime = Date.now();

  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    while (true) {
      const response = await fetchImpl(currentUrl, {
        method: "GET",
        signal: controller.signal,
        redirect: "manual"
      });

      if (response.status >= 300 && response.status < 400) {
        if (maxRedirects === 0) {
          clearTimeout(timeoutTimer);
          return {
            signal: "health",
            requirementId,
            collectedAt,
            available: true,
            complete: false,
            provenance: { target: currentUrl, adapter: "http-health-probe" },
            data: {
              endpoint,
              statusCode: response.status,
              statusText: response.statusText,
              latencyMs: Date.now() - startTime,
              probeOutcome: "unhealthy"
            },
            diagnostics: [
              {
                code: "REDIRECT_DISALLOWED",
                severity: "warning",
                message: `Redirect received (${response.status}) but redirects are disallowed.`
              }
            ]
          };
        }

        const locationHeader = response.headers.get("location");
        if (!locationHeader) {
          clearTimeout(timeoutTimer);
          return {
            signal: "health",
            requirementId,
            collectedAt,
            available: true,
            complete: false,
            provenance: { target: currentUrl, adapter: "http-health-probe" },
            data: {
              endpoint,
              statusCode: response.status,
              statusText: response.statusText,
              latencyMs: Date.now() - startTime,
              probeOutcome: "error"
            },
            diagnostics: [
              {
                code: "STATUS_ERROR",
                severity: "error",
                message: "Redirect response missing Location header."
              }
            ]
          };
        }

        redirectsRemaining -= 1;
        if (redirectsRemaining < 0) {
          clearTimeout(timeoutTimer);
          return {
            signal: "health",
            requirementId,
            collectedAt,
            available: false,
            complete: false,
            provenance: { target: currentUrl, adapter: "http-health-probe" },
            data: {
              endpoint,
              statusCode: response.status,
              statusText: response.statusText,
              latencyMs: Date.now() - startTime,
              probeOutcome: "error"
            },
            diagnostics: [
              {
                code: "REDIRECT_LIMIT_EXCEEDED",
                severity: "error",
                message: `Exceeded maximum redirect limit of ${maxRedirects}.`
              }
            ]
          };
        }

        const nextResolved = new URL(locationHeader, currentUrl).toString();
        const nextValidation = validateAndSanitizeUrl(nextResolved, { allowPrivateIps });
        if (!nextValidation.valid || !nextValidation.sanitizedUrl) {
          clearTimeout(timeoutTimer);
          return {
            signal: "health",
            requirementId,
            collectedAt,
            available: false,
            complete: false,
            provenance: { target: nextValidation.sanitizedUrl ?? nextResolved, adapter: "http-health-probe" },
            data: {
              endpoint,
              probeOutcome: "error"
            },
            diagnostics: [
              {
                code: nextValidation.diagnosticCode ?? "SSRF_BLOCKED",
                severity: "error",
                message: nextValidation.reason ?? "Redirect destination rejected by security policy."
              }
            ]
          };
        }

        currentUrl = nextValidation.sanitizedUrl;
        continue;
      }

      const latencyMs = Date.now() - startTime;
      const sizeCheck = await readBoundedBody(response, maxBytes);
      clearTimeout(timeoutTimer);

      if (!sizeCheck.ok) {
        return {
          signal: "health",
          requirementId,
          collectedAt,
          available: true,
          complete: false,
          provenance: { target: currentUrl, adapter: "http-health-probe" },
          data: {
            endpoint,
            statusCode: response.status,
            statusText: response.statusText,
            latencyMs,
            probeOutcome: "error"
          },
          diagnostics: [
            {
              code: "RESPONSE_TOO_LARGE",
              severity: "warning",
              message: `Response body exceeded bounded limit of ${maxBytes} bytes.`
            }
          ]
        };
      }

      const is2xx = response.status >= 200 && response.status < 300;
      const diagnostics: InspectorDiagnostic[] = [];
      if (!is2xx) {
        diagnostics.push({
          code: "STATUS_ERROR",
          severity: "warning",
          message: `Health probe returned non-2xx status code ${response.status}.`
        });
      }

      return {
        signal: "health",
        requirementId,
        collectedAt,
        available: true,
        complete: is2xx,
        provenance: { target: currentUrl, adapter: "http-health-probe" },
        data: {
          endpoint,
          statusCode: response.status,
          statusText: response.statusText,
          latencyMs,
          probeOutcome: is2xx ? "healthy" : "unhealthy"
        },
        diagnostics
      };
    }
  } catch (error: unknown) {
    clearTimeout(timeoutTimer);
    const latencyMs = Date.now() - startTime;
    const isTimeout = error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));

    return {
      signal: "health",
      requirementId,
      collectedAt,
      available: false,
      complete: false,
      provenance: { target: currentUrl, adapter: "http-health-probe" },
      data: {
        endpoint,
        latencyMs,
        probeOutcome: isTimeout ? "timeout" : "error"
      },
      diagnostics: [
        {
          code: isTimeout ? "PROBE_TIMEOUT" : "PROBE_FAILED",
          severity: "error",
          message: isTimeout
            ? `Health probe timed out after ${timeoutMs}ms.`
            : `Health probe network request failed: ${error instanceof Error ? error.message : String(error)}`
        }
      ]
    };
  }
}

export async function inspectMetric(options: MetricInspectorOptions): Promise<InspectorEvidence<MetricEvidenceData>> {
  const requirement = options?.requirement;
  const requirementId = requirement?.id ?? "<unknown>";
  const now = options?.collectedAt ?? new Date();
  const collectedAt = now.toISOString();
  const allowPrivateIps = Boolean(options?.allowPrivateIps);

  const validation = validateAndSanitizeUrl(options?.baseUrl, { allowPrivateIps });
  if (!validation.valid || !validation.sanitizedUrl) {
    return {
      signal: "metric",
      requirementId,
      collectedAt,
      available: false,
      complete: false,
      provenance: {
        target: validation.sanitizedUrl ?? options?.baseUrl ?? "<invalid-url>",
        adapter: "prometheus"
      },
      diagnostics: [
        {
          code: validation.diagnosticCode ?? "TARGET_INVALID",
          severity: "error",
          message: validation.reason ?? "Invalid Prometheus base URL."
        }
      ]
    };
  }

  const targetUrl = validation.sanitizedUrl;

  const requestRequirement: RequestMetricRequirement = isRequestMetricRequirement(requirement)
    ? requirement
    : {
        id: requirement.id,
        serviceName: options?.serviceName ?? "demo-service",
        metricName: requirement.metricName,
        route: options?.route ?? "/api/demo",
        method: options?.method,
        minimumCount: options?.minimumCount ?? 1,
        maxEvidenceAgeMs: options?.maxEvidenceAgeMs ?? 60_000
      };

  const telemetryEvidence = await collectPrometheusRequestMetricEvidence({
    baseUrl: targetUrl,
    requirement: requestRequirement,
    collectionWindowSeconds: options?.collectionWindowSeconds ?? 60,
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    evaluatedAt: options?.evaluatedAt ?? now,
    collectedAt: options?.collectedAt ?? now,
    scrapeStepSeconds: options?.scrapeStepSeconds,
    fetchImpl: options?.fetchImpl
  });

  const diagnostics: InspectorDiagnostic[] = [];

  if (!telemetryEvidence.available) {
    diagnostics.push({
      code: "METRIC_UNAVAILABLE",
      severity: "warning",
      message: "Prometheus metric evidence is unavailable."
    });
  } else if (!telemetryEvidence.complete) {
    diagnostics.push({
      code: "SCRAPE_INCOMPLETE",
      severity: "warning",
      message: "Prometheus scrape coverage is incomplete or unverified."
    });
  }

  return {
    signal: "metric",
    requirementId,
    collectedAt: telemetryEvidence.collectedAt,
    available: telemetryEvidence.available,
    complete: telemetryEvidence.available && telemetryEvidence.complete,
    provenance: {
      target: targetUrl,
      adapter: "prometheus",
      source: telemetryEvidence.source
    },
    data: {
      samples: telemetryEvidence.samples,
      source: telemetryEvidence.source
    },
    diagnostics
  };
}

export async function inspectTrace(options: TraceInspectorOptions): Promise<InspectorEvidence<TraceEvidenceData | UnconfiguredEvidenceData>> {
  const requirementId = options?.requirement?.id ?? "<unknown>";
  const collectedAt = (options?.collectedAt ?? new Date()).toISOString();
  const backendUrl = options?.backendUrl;
  if (!backendUrl) return {
    signal: "trace", requirementId, collectedAt, available: false, complete: false,
    provenance: { target: options?.requirement?.serviceName ?? "<unconfigured>", adapter: "jaeger-query" },
    data: { reason: "Jaeger trace backend is not configured for this project." },
    diagnostics: [{ code: "BACKEND_UNCONFIGURED", severity: "info", message: "Jaeger trace inspection backend is not configured." }]
  };

  const base = validateAndSanitizeUrl(backendUrl, { allowPrivateIps: Boolean(options?.allowPrivateIps) });
  if (!base.valid || !base.sanitizedUrl) return traceUnavailable(requirementId, collectedAt, "<invalid-url>", base.diagnosticCode ?? "TARGET_INVALID", base.reason ?? "Invalid Jaeger target URL.");
  const url = new URL(base.sanitizedUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/traces`;
  url.searchParams.set("service", options.requirement.serviceName);
  url.searchParams.set("lookback", "1h");
  url.searchParams.set("limit", "20");
  const validatedTarget = validateAndSanitizeUrl(url.toString(), { allowPrivateIps: Boolean(options?.allowPrivateIps) });
  if (!validatedTarget.valid || !validatedTarget.sanitizedUrl) return traceUnavailable(requirementId, collectedAt, "<invalid-url>", validatedTarget.diagnosticCode ?? "TARGET_INVALID", validatedTarget.reason ?? "Invalid Jaeger query URL.");

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? 256 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(validatedTarget.sanitizedUrl, { method: "GET", signal: controller.signal, redirect: "manual", headers: { accept: "application/json" } });
    if (response.status >= 300 && response.status < 400) return traceUnavailable(requirementId, collectedAt, validatedTarget.sanitizedUrl, "REDIRECT_DISALLOWED", "Jaeger query redirects are not followed.", true);
    if (!response.ok) return traceUnavailable(requirementId, collectedAt, validatedTarget.sanitizedUrl, "STATUS_ERROR", `Jaeger query returned HTTP ${response.status}.`, true);
    const body = await readBoundedText(response, maxBytes);
    if (!body.ok) return traceUnavailable(requirementId, collectedAt, validatedTarget.sanitizedUrl, "RESPONSE_TOO_LARGE", "Jaeger response exceeded the configured size limit.", true);
    let parsed: unknown;
    try { parsed = JSON.parse(body.text); } catch { return traceUnavailable(requirementId, collectedAt, validatedTarget.sanitizedUrl, "STATUS_ERROR", "Jaeger returned malformed JSON.", true); }
    if (!isRecord(parsed) || !Array.isArray(parsed.data)) return traceUnavailable(requirementId, collectedAt, validatedTarget.sanitizedUrl, "STATUS_ERROR", "Jaeger response did not contain a trace data array.", true);
    let traceCount = 0;
    for (const item of parsed.data) {
      if (!isRecord(item) || !Array.isArray(item.spans) || !isRecord(item.processes)) continue;
      const serviceMatches = Object.values(item.processes).some((process) => isRecord(process) && process.serviceName === options.requirement.serviceName);
      if (serviceMatches && item.spans.length > 0) traceCount += 1;
    }
    return {
      signal: "trace", requirementId, collectedAt, available: true, complete: true,
      provenance: { target: validatedTarget.sanitizedUrl, adapter: "jaeger-query" },
      data: { serviceName: options.requirement.serviceName, traceCount }, diagnostics: []
    };
  } catch {
    return traceUnavailable(requirementId, collectedAt, validatedTarget.sanitizedUrl, "PROBE_FAILED", "Jaeger query could not be completed.");
  } finally { clearTimeout(timer); }
}

function traceUnavailable(requirementId: string, collectedAt: string, target: string, code: InspectorDiagnosticCode, message: string, available = false): InspectorEvidence<UnconfiguredEvidenceData> {
  return { signal: "trace", requirementId, collectedAt, available, complete: false,
    provenance: { target, adapter: "jaeger-query" }, data: { reason: message },
    diagnostics: [{ code, severity: code === "BACKEND_UNCONFIGURED" ? "info" : "warning", message }] };
}

export async function inspectLog(
  options: LogInspectorOptions
): Promise<InspectorEvidence<LogEvidenceData | UnconfiguredEvidenceData>> {
  const requirementId = options?.requirement?.id ?? "<unknown>";
  const collectedAtDate = options?.collectedAt ?? new Date();
  const collectedAt = collectedAtDate.toISOString();
  const backendUrl = options?.backendUrl;

  if (!backendUrl) {
    return {
      signal: "log",
      requirementId,
      collectedAt,
      available: false,
      complete: false,
      provenance: {
        target: "<unconfigured>",
        adapter: "loki-query"
      },
      data: {
        reason: "Loki log backend adapter is not configured in this environment."
      },
      diagnostics: [
        {
          code: "BACKEND_UNCONFIGURED",
          severity: "info",
          message: "Log inspection backend is not configured for this project."
        }
      ]
    };
  }

  const base = validateAndSanitizeUrl(backendUrl, { allowPrivateIps: Boolean(options?.allowPrivateIps) });
  if (!base.valid || !base.sanitizedUrl) {
    return logUnavailable(
      requirementId,
      collectedAt,
      "<invalid-url>",
      base.diagnosticCode ?? "TARGET_INVALID",
      base.reason ?? "Invalid Loki target URL."
    );
  }

  const serviceName = options.serviceName ?? "demo-service";
  const lookbackMinutes = options.lookbackMinutes ?? 15;
  const endNs = BigInt(collectedAtDate.getTime()) * 1_000_000n;
  const startNs = endNs - BigInt(lookbackMinutes * 60 * 1000) * 1_000_000n;

  const url = new URL(base.sanitizedUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/loki/api/v1/query_range`;
  url.searchParams.set("query", `{service_name="${serviceName}"}`);
  url.searchParams.set("limit", "25");
  url.searchParams.set("start", startNs.toString());
  url.searchParams.set("end", endNs.toString());

  const validatedTarget = validateAndSanitizeUrl(url.toString(), { allowPrivateIps: Boolean(options?.allowPrivateIps) });
  if (!validatedTarget.valid || !validatedTarget.sanitizedUrl) {
    return logUnavailable(
      requirementId,
      collectedAt,
      "<invalid-url>",
      validatedTarget.diagnosticCode ?? "TARGET_INVALID",
      validatedTarget.reason ?? "Invalid Loki query URL."
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? 256 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await (options.fetchImpl ?? fetch)(validatedTarget.sanitizedUrl, {
      method: "GET",
      signal: controller.signal,
      redirect: "manual",
      headers: { accept: "application/json" }
    });
    if (response.status >= 300 && response.status < 400) {
      return logUnavailable(requirementId, collectedAt, validatedTarget.sanitizedUrl, "REDIRECT_DISALLOWED", "Loki query redirects are not followed.", true);
    }
    if (!response.ok) {
      return logUnavailable(requirementId, collectedAt, validatedTarget.sanitizedUrl, "STATUS_ERROR", `Loki query returned HTTP ${response.status}.`, true);
    }
    const body = await readBoundedText(response, maxBytes);
    if (!body.ok) {
      return logUnavailable(requirementId, collectedAt, validatedTarget.sanitizedUrl, "RESPONSE_TOO_LARGE", "Loki response exceeded the configured size limit.", true);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return logUnavailable(requirementId, collectedAt, validatedTarget.sanitizedUrl, "STATUS_ERROR", "Loki returned malformed JSON.", true);
    }
    if (!isRecord(parsed) || parsed.status !== "success" || !isRecord(parsed.data) || !Array.isArray(parsed.data.result)) {
      return logUnavailable(requirementId, collectedAt, validatedTarget.sanitizedUrl, "STATUS_ERROR", "Loki response did not contain a valid streams result array.", true);
    }

    let totalEntries = 0;
    let validJsonEntries = 0;
    const observedFieldSet = new Set<string>();

    for (const stream of parsed.data.result) {
      if (!isRecord(stream) || !Array.isArray(stream.values)) continue;
      for (const pair of stream.values) {
        if (!Array.isArray(pair) || pair.length < 2 || typeof pair[1] !== "string") continue;
        totalEntries += 1;
        try {
          const lineObj = JSON.parse(pair[1]);
          if (isRecord(lineObj)) {
            validJsonEntries += 1;
            for (const [k, v] of Object.entries(lineObj)) {
              if (v !== undefined && v !== null && String(v).length > 0) {
                observedFieldSet.add(k);
              }
            }
          }
        } catch {
          // Non-JSON log line; counted in totalEntries but not validJsonEntries.
        }
      }
    }

    const requiredFields = Array.isArray(options.requirement?.fields) ? options.requirement.fields : [];
    const observedFields = Array.from(observedFieldSet).sort();
    const missingFields = requiredFields.filter((f) => !observedFieldSet.has(f));

    return {
      signal: "log",
      requirementId,
      collectedAt,
      available: true,
      complete: true,
      provenance: {
        target: validatedTarget.sanitizedUrl,
        adapter: "loki-query"
      },
      data: {
        totalEntries,
        validJsonEntries,
        observedFields,
        missingFields
      },
      diagnostics: []
    };
  } catch {
    return logUnavailable(requirementId, collectedAt, validatedTarget.sanitizedUrl, "PROBE_FAILED", "Loki log query could not be completed.");
  } finally {
    clearTimeout(timer);
  }
}

function logUnavailable(
  requirementId: string,
  collectedAt: string,
  target: string,
  code: InspectorDiagnosticCode,
  message: string,
  available = false
): InspectorEvidence<UnconfiguredEvidenceData> {
  return {
    signal: "log",
    requirementId,
    collectedAt,
    available,
    complete: false,
    provenance: { target, adapter: "loki-query" },
    data: { reason: message },
    diagnostics: [{ code, severity: code === "BACKEND_UNCONFIGURED" ? "info" : "warning", message }]
  };
}

function alertUnavailable(
  requirementId: string,
  collectedAt: string,
  target: string,
  code: InspectorDiagnosticCode,
  message: string,
  available = false
): InspectorEvidence<UnconfiguredEvidenceData> {
  return {
    signal: "alert",
    requirementId,
    collectedAt,
    available,
    complete: false,
    provenance: { target, adapter: "prometheus-rules" },
    data: { reason: message },
    diagnostics: [{ code, severity: code === "BACKEND_UNCONFIGURED" ? "info" : "warning", message }]
  };
}

export async function inspectAlert(
  options: AlertInspectorOptions
): Promise<InspectorEvidence<AlertEvidenceData | UnconfiguredEvidenceData>> {
  const requirementId = options?.requirement?.id ?? "<unknown>";
  const collectedAt = (options?.collectedAt ?? new Date()).toISOString();
  const backendUrl = options?.backendUrl;

  if (!backendUrl) {
    return {
      signal: "alert",
      requirementId,
      collectedAt,
      available: false,
      complete: false,
      provenance: {
        target: "<unconfigured>",
        adapter: "unconfigured-alert-adapter"
      },
      data: {
        reason: "Alert backend adapter is not configured in this environment."
      },
      diagnostics: [
        {
          code: "BACKEND_UNCONFIGURED",
          severity: "info",
          message: "Alert inspection backend is not configured."
        }
      ]
    };
  }

  const base = validateAndSanitizeUrl(backendUrl, { allowPrivateIps: Boolean(options?.allowPrivateIps) });
  if (!base.valid || !base.sanitizedUrl) {
    return alertUnavailable(
      requirementId,
      collectedAt,
      "<invalid-url>",
      base.diagnosticCode ?? "TARGET_INVALID",
      base.reason ?? "Invalid Prometheus alert rules target URL."
    );
  }

  const url = new URL(base.sanitizedUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/v1/rules`;
  url.searchParams.set("type", "alert");
  const validatedTarget = validateAndSanitizeUrl(url.toString(), { allowPrivateIps: Boolean(options?.allowPrivateIps) });
  if (!validatedTarget.valid || !validatedTarget.sanitizedUrl) {
    return alertUnavailable(
      requirementId,
      collectedAt,
      "<invalid-url>",
      validatedTarget.diagnosticCode ?? "TARGET_INVALID",
      validatedTarget.reason ?? "Invalid Prometheus alert rules query URL."
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? 256 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await (options.fetchImpl ?? fetch)(validatedTarget.sanitizedUrl, {
      method: "GET",
      signal: controller.signal,
      redirect: "manual",
      headers: { accept: "application/json" }
    });
    if (response.status >= 300 && response.status < 400) {
      return alertUnavailable(requirementId, collectedAt, validatedTarget.sanitizedUrl, "REDIRECT_DISALLOWED", "Prometheus rules query redirects are not followed.", true);
    }
    if (!response.ok) {
      return alertUnavailable(requirementId, collectedAt, validatedTarget.sanitizedUrl, "STATUS_ERROR", `Prometheus rules query returned HTTP ${response.status}.`, true);
    }
    const body = await readBoundedText(response, maxBytes);
    if (!body.ok) {
      return alertUnavailable(requirementId, collectedAt, validatedTarget.sanitizedUrl, "RESPONSE_TOO_LARGE", "Prometheus rules response exceeded the configured size limit.", true);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return alertUnavailable(requirementId, collectedAt, validatedTarget.sanitizedUrl, "STATUS_ERROR", "Prometheus rules endpoint returned malformed JSON.", true);
    }
    if (!isRecord(parsed) || parsed.status !== "success" || !isRecord(parsed.data) || !Array.isArray(parsed.data.groups)) {
      return alertUnavailable(requirementId, collectedAt, validatedTarget.sanitizedUrl, "STATUS_ERROR", "Prometheus rules response did not contain a valid groups array.", true);
    }

    let expectedAlertName = requirementId.replace(/[^a-zA-Z0-9_:]/g, "_").toLowerCase();
    if (!/^[a-zA-Z_:]/.test(expectedAlertName)) {
      expectedAlertName = `_${expectedAlertName}`;
    }

    const matchedRules: AlertRuleMatch[] = [];
    let totalLoadedRules = 0;

    for (const group of parsed.data.groups) {
      if (!isRecord(group) || typeof group.name !== "string" || !Array.isArray(group.rules)) continue;
      for (const rule of group.rules) {
        if (!isRecord(rule) || rule.type !== "alerting" || typeof rule.name !== "string") continue;
        totalLoadedRules += 1;
        const labels = isRecord(rule.labels) ? rule.labels : {};
        if (rule.name.toLowerCase() === expectedAlertName || labels.requirement_id === requirementId) {
          const state = typeof rule.state === "string" ? rule.state : "unknown";
          const alertsArr = Array.isArray(rule.alerts) ? rule.alerts : [];
          const activeAlerts = alertsArr.filter((a) => isRecord(a) && a.state === "firing").length;
          matchedRules.push({
            name: rule.name,
            group: group.name,
            state,
            health: typeof rule.health === "string" ? rule.health : "unknown",
            query: typeof rule.query === "string" ? rule.query : "",
            activeAlerts: state === "firing" ? Math.max(1, activeAlerts) : activeAlerts,
            ...(typeof rule.lastEvaluation === "string" ? { lastEvaluation: rule.lastEvaluation } : {})
          });
        }
      }
    }

    const ruleHealthy = matchedRules.length > 0 && matchedRules.every((r) => r.health === "ok");
    const firingAlertCount = matchedRules.reduce((sum, r) => sum + (r.activeAlerts ?? 0), 0);

    return {
      signal: "alert",
      requirementId,
      collectedAt,
      available: true,
      complete: true,
      provenance: {
        target: validatedTarget.sanitizedUrl,
        adapter: "prometheus-rules"
      },
      data: {
        matchedRules,
        totalLoadedRules,
        ruleHealthy,
        firingAlertCount
      },
      diagnostics: []
    };
  } catch {
    return alertUnavailable(requirementId, collectedAt, validatedTarget.sanitizedUrl, "PROBE_FAILED", "Prometheus alert rules query could not be completed.");
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectExpectedObservabilityRequirement(
  requirement: ExpectedRequirement,
  config: InspectorConfiguration
): Promise<InspectorEvidence> {
  switch (requirement.signal) {
    case "metric":
      if (!config.prometheusBaseUrl) {
        return {
          signal: "metric", requirementId: requirement.id, collectedAt: (config.collectedAt ?? new Date()).toISOString(),
          available: false, complete: false, provenance: { target: "<unconfigured>", adapter: "prometheus" },
          diagnostics: [{ code: "BACKEND_UNCONFIGURED", severity: "info", message: "Prometheus target is not configured for this project." }]
        };
      }
      return inspectMetric({
        baseUrl: config.prometheusBaseUrl,
        requirement: requirement.signal === "metric" && !isRequestMetricRequirement(requirement)
          ? { ...requirement, ...config.metricConfigs?.[requirement.id] }
          : requirement,
        collectionWindowSeconds: config.collectionWindowSeconds,
        timeoutMs: config.timeoutMs,
        allowPrivateIps: config.allowPrivateIps,
        fetchImpl: config.fetchImpl,
        collectedAt: config.collectedAt,
        evaluatedAt: config.evaluatedAt
      });

    case "health":
      if (!config.healthBaseUrl) {
        return {
          signal: "health", requirementId: requirement.id, collectedAt: (config.collectedAt ?? new Date()).toISOString(),
          available: false, complete: false, provenance: { target: "<unconfigured>", adapter: "http-health-probe" },
          data: { endpoint: requirement.endpoint, probeOutcome: "error" },
          diagnostics: [{ code: "BACKEND_UNCONFIGURED", severity: "info", message: "HTTP health target is not configured for this project." }]
        };
      }
      return inspectHealthCheck({
        baseUrl: config.healthBaseUrl,
        requirement,
        timeoutMs: config.timeoutMs,
        maxResponseBytes: config.maxResponseBytes,
        maxRedirects: config.maxRedirects,
        allowPrivateIps: config.allowPrivateIps,
        fetchImpl: config.fetchImpl,
        collectedAt: config.collectedAt
      });

    case "trace":
      return inspectTrace({
        requirement,
        backendUrl: config.traceBackendUrl,
        timeoutMs: config.timeoutMs,
        maxResponseBytes: config.maxResponseBytes,
        allowPrivateIps: config.allowPrivateIps,
        fetchImpl: config.fetchImpl,
        collectedAt: config.collectedAt
      });

    case "log":
      return inspectLog({
        requirement,
        backendUrl: config.logBackendUrl,
        timeoutMs: config.timeoutMs,
        maxResponseBytes: config.maxResponseBytes,
        allowPrivateIps: config.allowPrivateIps,
        fetchImpl: config.fetchImpl,
        collectedAt: config.collectedAt
      });

    case "alert":
      return inspectAlert({
        requirement,
        backendUrl: config.alertBackendUrl ?? config.prometheusBaseUrl,
        timeoutMs: config.timeoutMs,
        maxResponseBytes: config.maxResponseBytes,
        allowPrivateIps: config.allowPrivateIps,
        fetchImpl: config.fetchImpl,
        collectedAt: config.collectedAt
      });

    default:
      return {
        signal: (requirement as { signal: InspectorSignal }).signal ?? "metric",
        requirementId: (requirement as { id: string }).id ?? "<unknown>",
        collectedAt: (config.collectedAt ?? new Date()).toISOString(),
        available: false,
        complete: false,
        provenance: { target: "<unknown>", adapter: "unknown" },
        diagnostics: [
          {
            code: "UNSUPPORTED_ADAPTER",
            severity: "error",
            message: `Unsupported requirement signal ${(requirement as { signal: string }).signal}.`
          }
        ]
      };
  }
}

function resolveEndpoint(baseUrl: string | undefined, endpoint: string): string {
  if (!baseUrl) {
    return endpoint;
  }
  const cleanBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${cleanBase}${cleanEndpoint}`;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<{ ok: boolean }> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch {
          // ignore
        }
      }
      return { ok: false };
    }
  }

  if (!response.body) {
    return { ok: true };
  }

  const reader = response.body.getReader();
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel("Response body exceeded maxResponseBytes");
          return { ok: false };
        }
      }
    }
    return { ok: true };
  } catch {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    return { ok: false };
  } finally {
    reader.releaseLock();
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<{ ok: boolean; text: string }> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number.isFinite(Number(contentLength)) && Number(contentLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, text: "" };
  }
  if (!response.body) return { ok: true, text: "" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel("Jaeger response exceeded the configured size limit."); return { ok: false, text: "" }; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, text: "" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestMetricRequirement(value: unknown): value is RequestMetricRequirement {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RequestMetricRequirement).serviceName === "string" &&
    typeof (value as RequestMetricRequirement).route === "string" &&
    typeof (value as RequestMetricRequirement).minimumCount === "number"
  );
}
