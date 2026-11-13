import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { runObservabilityDemo } from "../../src/remediation/observability-demo";

test("end-to-end observability demo discovers, inspects, evaluates and validates review-only YAML", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cloudpilot-demo-"));
  try {
    await mkdir(path.join(root, "prometheus"));
    await mkdir(path.join(root, "collector"));
    await writeFile(path.join(root, "compose.yaml"), [
      "services:",
      "  demo-service:",
      "    image: cloudpilot-demo:local",
      "    ports: [\"3000:3000\"]",
      "    depends_on: [otel-collector]",
      "  otel-collector:",
      "    image: otel/opentelemetry-collector-contrib:0.111.0"
    ].join("\n"));
    await writeFile(path.join(root, "prometheus", "prometheus.yml"), "scrape_configs:\n  - job_name: otel-collector\n");
    await writeFile(path.join(root, "collector", "otel-collector-config.yml"), "service:\n  pipelines:\n    metrics: {}\n    traces: {}\n");

    const evaluatedAt = new Date("2026-11-10T12:00:00.000Z");
    const model = {
      schemaVersion: "cloudpilot.expected-observability.v1",
      serviceId: "demo-service",
      requirements: {
        metrics: [
          { id: "request-count", signal: "metric", metricName: "demo_http_server_requests_total", dimensions: ["route", "method"] },
          { id: "cloudpilot_demo_queue_depth", signal: "metric", metricName: "cloudpilot_demo_queue_depth", dimensions: ["exported_job"] }
        ],
        logs: [{ id: "logs", signal: "log", fields: ["level", "message"] }],
        traces: [{ id: "traces", signal: "trace", serviceName: "demo-service" }],
        healthChecks: [{ id: "health", signal: "health", kind: "http", endpoint: "/health" }],
        alerts: [{ id: "alerts", signal: "alert", associatedSignal: "metric", condition: "rate > 0", severity: "warning" }]
      }
    };

    const report = await runObservabilityDemo({
      workloadRoot: root,
      includePaths: ["compose.yaml"],
      expectedObservability: model,
      evaluatedAt,
      gapEngine: {
        maxHealthEvidenceAgeMs: 30_000,
        metricConfigs: {
          "request-count": { serviceName: "demo-service", route: "/api/demo", minimumCount: 1, maxEvidenceAgeMs: 60_000 },
          "cloudpilot_demo_queue_depth": { serviceName: "demo-service", route: "/api/demo", minimumCount: 1, maxEvidenceAgeMs: 60_000 }
        }
      },
      inspector: {
        prometheusBaseUrl: "http://127.0.0.1:9090",
        traceBackendUrl: "http://127.0.0.1:16686",
        healthBaseUrl: "http://127.0.0.1:3000",
        allowPrivateIps: true,
        collectionWindowSeconds: 60,
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/api/traces")) {
            return Response.json({ data: [{ spans: [{ operationName: "GET /api/demo" }], processes: { p1: { serviceName: "demo-service" } } }] });
          }
          if (url.pathname.endsWith("query_range")) {
            const start = Number(url.searchParams.get("start"));
            const end = Number(url.searchParams.get("end"));
            const values: Array<[number, string]> = [];
            for (let timestamp = start; timestamp <= end; timestamp += 5) values.push([timestamp, String(timestamp)]);
            return Response.json({ status: "success", data: { resultType: "matrix", result: [{ metric: { job: "otel-collector", instance: "localhost:8889" }, values }] } });
          }
          if (url.pathname.endsWith("/health")) return new Response("healthy", { status: 200 });
          const query = url.searchParams.get("query") ?? "";
          const result = query.includes("demo_http_server_requests_total")
            ? [{ metric: { exported_job: "demo-service", route: "/api/demo", method: "GET", status_code: "200", job: "otel-collector", instance: "localhost:8889" }, value: [evaluatedAt.getTime() / 1000, "3"] }]
            : [];
          return Response.json({ status: "success", data: { resultType: "vector", result } });
        }
      }
    });

    assert.equal(report.discovery.status, "success");
    assert.ok(report.discovery.model.services.some((service) => service.name === "demo-service"));
    assert.deepEqual(report.configuration.prometheusJobs, ["otel-collector"]);
    assert.deepEqual(report.configuration.collectorPipelines, ["metrics", "traces"]);
    assert.equal(report.findings.find((finding) => finding.requirementId === "request-count")?.outcome, "pass");
    assert.equal(report.findings.find((finding) => finding.requirementId === "cloudpilot_demo_queue_depth")?.outcome, "gap");
    assert.equal(report.findings.find((finding) => finding.requirementId === "traces")?.outcome, "pass");
    assert.equal(report.findings.find((finding) => finding.requirementId === "health")?.outcome, "pass");
    assert.equal(report.findings.find((finding) => finding.requirementId === "logs")?.outcome, "unknown");
    assert.equal(report.findings.find((finding) => finding.requirementId === "alerts")?.outcome, "unknown");
    assert.equal(report.generatedConfigurations.length, 1);
    assert.equal(report.generatedConfigurations[0].filePath, "config/observability/metrics.yaml");
    assert.equal(report.generatedConfigurations[0].validation, "valid");
    const generated = YAML.parse(report.generatedConfigurations[0].content) as { metrics: Array<{ name: string }> };
    assert.ok(generated.metrics.some((metric) => metric.name === "cloudpilot_demo_queue_depth"));
    assert.ok(report.recommendations.some((item) => item.findingId.includes("cloudpilot_demo_queue_depth")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
