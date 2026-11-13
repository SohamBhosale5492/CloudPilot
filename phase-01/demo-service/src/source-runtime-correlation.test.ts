import assert from "node:assert/strict";
import test from "node:test";
import { evaluateGap } from "./gap-engine.js";
import { inspectExpectedObservabilityRequirement } from "./inspectors.js";
import { analyzeNodeExpressSource } from "./source-observability-analysis.js";

function response(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }

test("source-derived request metric and trace requirements correlate to exact mocked Prometheus and Jaeger evidence", async () => {
  const analysis = analyzeNodeExpressSource([
    { path: "package.json", content: '{"name":"alumni-api"}' },
    { path: "src/app.js", content: 'const express = require("express"); app.use(observabilityMiddleware); app.get("/health", handler);' },
    { path: "src/telemetry.js", content: [
      'const requestCounter = meter.createCounter("alumni_http_server_requests");',
      'const tracer = trace.getTracer("alumni-api");',
      'requestCounter.add(1, { method, route });',
      'tracer.startSpan("request");',
      'new OTLPMetricExporter({ url: "http://collector:4318/v1/metrics" });',
      'new OTLPTraceExporter({ url: "http://collector:4318/v1/traces" });'
    ].join("\n") }
  ]);
  const metricRequirement = analysis.expectedModel.requirements.find((item) => item.signal === "metric");
  const traceRequirement = analysis.expectedModel.requirements.find((item) => item.signal === "trace");
  assert.ok(metricRequirement?.signal === "metric");
  assert.ok(traceRequirement?.signal === "trace");
  const metricConfig = analysis.metricConfigs[metricRequirement.id];
  assert.ok(metricConfig);
  const now = new Date("2026-10-13T12:00:00.000Z");
  const end = now.getTime() / 1000;
  const fetchPrometheus: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("query_range")) {
      const start = Number(url.searchParams.get("start"));
      const finish = Number(url.searchParams.get("end"));
      const values: Array<[number, string]> = [];
      for (let time = start; time <= finish; time += 5) values.push([time, String(time)]);
      assert.equal(values.length, 13);
      assert.deepEqual(values[0], [start, String(start)]);
      assert.deepEqual(values[12], [finish, String(finish)]);
      return response({ status: "success", data: { resultType: "matrix", result: [{ metric: { job: "otel-collector", instance: "collector:8889" }, values }] } });
    }
    return response({ status: "success", data: { resultType: "vector", result: [{
      metric: {
        __name__: metricRequirement.metricName,
        exported_job: metricConfig.serviceName,
        job: "otel-collector",
        instance: "collector:8889",
        route: metricConfig.route,
        method: metricConfig.method,
        status_code: "200"
      },
      value: [end, "1"]
    }] } });
  };
  const fetchJaeger: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("service"), "alumni-api");
    return response({ data: [{ spans: [{ operationName: "GET /health" }], processes: { p1: { serviceName: "alumni-api" } } }] });
  };
  const metricEvidence = await inspectExpectedObservabilityRequirement(metricRequirement, {
    prometheusBaseUrl: "http://prometheus:9090", metricConfigs: analysis.metricConfigs,
    fetchImpl: fetchPrometheus, allowPrivateIps: true, evaluatedAt: now, collectedAt: now
  });
  const traceEvidence = await inspectExpectedObservabilityRequirement(traceRequirement, {
    traceBackendUrl: "http://jaeger:16686", fetchImpl: fetchJaeger, allowPrivateIps: true, collectedAt: now
  });
  assert.equal(metricEvidence.available, true, JSON.stringify(metricEvidence));
  assert.equal(metricEvidence.complete, true, JSON.stringify(metricEvidence));
  assert.equal(traceEvidence.available, true, JSON.stringify(traceEvidence));
  const metricFinding = evaluateGap(metricRequirement, metricEvidence, { metricConfigs: analysis.metricConfigs, evaluatedAt: now });
  const traceFinding = evaluateGap(traceRequirement, traceEvidence, { evaluatedAt: now });
  assert.equal(metricFinding.outcome, "pass");
  assert.equal(traceFinding.outcome, "pass");
  assert.equal(metricEvidence.provenance.adapter, "prometheus");
  assert.equal(traceEvidence.provenance.adapter, "jaeger-query");
});
