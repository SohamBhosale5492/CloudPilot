import path from "node:path";
import type { ObservabilityDemoInput } from "./remediation/observability-demo";
import { runObservabilityDemo } from "./remediation/observability-demo";

const PROMETHEUS_URL = "http://127.0.0.1:9090";
const JAEGER_URL = "http://127.0.0.1:16686";
const FRONTEND_URL = "http://127.0.0.1:8080";
const SERVICE_NAME = "secure-alumni-backend";
const REQUEST_ROUTE = "/api/auth/forgot-password";

export function createSecureAlumniDemoInput(
  workloadRoot: string,
  healthUrl: string,
  evaluatedAt = new Date()
): ObservabilityDemoInput {
  const healthTarget = parseLoopbackHealthUrl(healthUrl);
  const metricId = "secure-alumni-forgot-password-count";
  const healthId = "secure-alumni-health";
  const metricConfig = {
    serviceName: SERVICE_NAME,
    route: REQUEST_ROUTE,
    method: "POST",
    minimumCount: 1,
    maxEvidenceAgeMs: 120_000
  };

  return {
    workloadRoot: path.resolve(workloadRoot),
    expectedObservability: {
      schemaVersion: "cloudpilot.expected-observability.v1",
      serviceId: SERVICE_NAME,
      requirements: {
        metrics: [{
          id: metricId,
          signal: "metric",
          metricName: "alumni_http_server_requests_total",
          dimensions: ["exported_job", "route", "method", "status_code"]
        }],
        logs: [{ id: "secure-alumni-log-backend", signal: "log", fields: [] }],
        traces: [{ id: "secure-alumni-http-traces", signal: "trace", serviceName: SERVICE_NAME }],
        healthChecks: [{ id: healthId, signal: "health", kind: "http", endpoint: healthTarget.pathname }],
        alerts: [{
          id: "secure-alumni-alert-backend",
          signal: "alert",
          associatedSignal: "metric",
          condition: "configured alert backend is inspectable",
          severity: "warning"
        }]
      }
    },
    evaluatedAt,
    gapEngine: {
      evaluatedAt,
      maxHealthEvidenceAgeMs: 30_000,
      metricConfigs: { [metricId]: metricConfig }
    },
    inspector: {
      prometheusBaseUrl: PROMETHEUS_URL,
      traceBackendUrl: JAEGER_URL,
      healthBaseUrl: healthTarget.origin,
      allowPrivateIps: true,
      timeoutMs: 5_000,
      collectionWindowSeconds: 60,
      metricConfigs: { [metricId]: metricConfig }
    }
  };
}

function parseLoopbackHealthUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CLOUDPILOT_SECURE_ALUMNI_HEALTH_URL must be a valid local HTTP(S) URL.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLoopback = hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (!isLoopback || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("CLOUDPILOT_SECURE_ALUMNI_HEALTH_URL must target loopback over HTTP(S), without credentials, query or fragment.");
  }
  return url;
}

async function main(): Promise<void> {
  const workloadRoot = process.env.CLOUDPILOT_SECURE_ALUMNI_ROOT;
  const healthUrl = process.env.CLOUDPILOT_SECURE_ALUMNI_HEALTH_URL;
  if (!workloadRoot) throw new Error("Set CLOUDPILOT_SECURE_ALUMNI_ROOT to the local Secure Alumni repository directory.");
  if (!healthUrl) throw new Error("Set CLOUDPILOT_SECURE_ALUMNI_HEALTH_URL to its verified loopback health endpoint URL.");

  console.log("Secure Alumni live observability inspection (read-only; no synthetic requests sent).");
  console.log(`Frontend: ${FRONTEND_URL}`);
  console.log(`Prometheus: ${PROMETHEUS_URL}; Jaeger: ${JAEGER_URL}`);
  console.log(`Inspecting service=${SERVICE_NAME}, route=POST ${REQUEST_ROUTE}`);

  const report = await runObservabilityDemo(createSecureAlumniDemoInput(workloadRoot, healthUrl));
  for (const service of report.discovery.model.services) {
    console.log(`Discovered workload: ${service.name} (${service.workloadType}) from ${service.source.file}`);
  }
  if (!report.discovery.model.services.some((service) => service.name === SERVICE_NAME)) {
    console.log(`Architecture discovery did not identify ${SERVICE_NAME} in the supplied repository configuration.`);
  }
  for (const finding of report.findings) {
    const evidence = report.evidence.find((item) => item.requirementId === finding.requirementId);
    console.log(`[${finding.outcome.toUpperCase()}] ${finding.signal} ${finding.requirementId}: ${finding.observed}`);
    console.log(`  evidence=${evidence?.provenance.adapter ?? "none"}; target=${evidence?.provenance.target ?? "unavailable"}; collectedAt=${evidence?.collectedAt ?? "unavailable"}`);
    for (const diagnostic of evidence?.diagnostics ?? []) console.log(`  diagnostic=${diagnostic.code}: ${diagnostic.message}`);
  }
  console.log("No remediation artifact was applied; this command only reads telemetry and configuration.");
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown Secure Alumni demo failure.";
    console.error(`Secure Alumni observability demo failed: ${message}`);
    process.exitCode = 1;
  });
}
