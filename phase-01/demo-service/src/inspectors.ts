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
  collectedAt?: Date;
}

export interface LogInspectorOptions {
  requirement: ExpectedLogRequirement;
  backendUrl?: string;
  collectedAt?: Date;
}

export interface AlertInspectorOptions {
  requirement: ExpectedAlertRequirement;
  backendUrl?: string;
  collectedAt?: Date;
}

export interface InspectorConfiguration {
  prometheusBaseUrl?: string;
  healthBaseUrl?: string;
  traceBackendUrl?: string;
  logBackendUrl?: string;
  alertBackendUrl?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  allowPrivateIps?: boolean;
  fetchImpl?: typeof fetch;
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

export function inspectTrace(options: TraceInspectorOptions): InspectorEvidence<UnconfiguredEvidenceData> {
  const requirementId = options?.requirement?.id ?? "<unknown>";
  const collectedAt = (options?.collectedAt ?? new Date()).toISOString();

  return {
    signal: "trace",
    requirementId,
    collectedAt,
    available: false,
    complete: false,
    provenance: {
      target: options?.backendUrl ?? options?.requirement?.serviceName ?? "<unconfigured>",
      adapter: "unconfigured-trace-adapter"
    },
    data: {
      reason: "Trace backend adapter is not configured in this environment."
    },
    diagnostics: [
      {
        code: "BACKEND_UNCONFIGURED",
        severity: "info",
        message: "Trace inspection backend is not configured in Phase 04."
      }
    ]
  };
}

export function inspectLog(options: LogInspectorOptions): InspectorEvidence<UnconfiguredEvidenceData> {
  const requirementId = options?.requirement?.id ?? "<unknown>";
  const collectedAt = (options?.collectedAt ?? new Date()).toISOString();

  return {
    signal: "log",
    requirementId,
    collectedAt,
    available: false,
    complete: false,
    provenance: {
      target: options?.backendUrl ?? "<unconfigured>",
      adapter: "unconfigured-log-adapter"
    },
    data: {
      reason: "Log backend adapter is not configured in this environment."
    },
    diagnostics: [
      {
        code: "BACKEND_UNCONFIGURED",
        severity: "info",
        message: "Log inspection backend is not configured in Phase 04."
      }
    ]
  };
}

export function inspectAlert(options: AlertInspectorOptions): InspectorEvidence<UnconfiguredEvidenceData> {
  const requirementId = options?.requirement?.id ?? "<unknown>";
  const collectedAt = (options?.collectedAt ?? new Date()).toISOString();

  return {
    signal: "alert",
    requirementId,
    collectedAt,
    available: false,
    complete: false,
    provenance: {
      target: options?.backendUrl ?? "<unconfigured>",
      adapter: "unconfigured-alert-adapter"
    },
    data: {
      reason: "Alert backend adapter is not configured in this environment."
    },
    diagnostics: [
      {
        code: "BACKEND_UNCONFIGURED",
        severity: "info",
        message: "Alert inspection backend is not configured in Phase 04."
      }
    ]
  };
}

export async function inspectExpectedObservabilityRequirement(
  requirement: ExpectedRequirement,
  config: InspectorConfiguration
): Promise<InspectorEvidence> {
  switch (requirement.signal) {
    case "metric":
      return inspectMetric({
        baseUrl: config.prometheusBaseUrl ?? "http://prometheus.example.internal:9090",
        requirement,
        timeoutMs: config.timeoutMs,
        allowPrivateIps: config.allowPrivateIps,
        fetchImpl: config.fetchImpl,
        collectedAt: config.collectedAt,
        evaluatedAt: config.evaluatedAt
      });

    case "health":
      return inspectHealthCheck({
        baseUrl: config.healthBaseUrl ?? "http://service.example.internal:8080",
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
        collectedAt: config.collectedAt
      });

    case "log":
      return inspectLog({
        requirement,
        backendUrl: config.logBackendUrl,
        collectedAt: config.collectedAt
      });

    case "alert":
      return inspectAlert({
        requirement,
        backendUrl: config.alertBackendUrl,
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

function isRequestMetricRequirement(value: unknown): value is RequestMetricRequirement {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RequestMetricRequirement).serviceName === "string" &&
    typeof (value as RequestMetricRequirement).route === "string" &&
    typeof (value as RequestMetricRequirement).minimumCount === "number"
  );
}
