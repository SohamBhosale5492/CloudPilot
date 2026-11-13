import assert from "node:assert/strict";
import test from "node:test";
import { analyzeNodeExpressSource, expectedModelDigest } from "./source-observability-analysis.js";

const alumniSnapshot = [
  { path: "backend/src/app.js", content: [
    'const express = require("express");',
    'const authRoutes = require("./routes/auth.routes");',
    'const { observabilityMiddleware } = require("./telemetry");',
    "app.use(observabilityMiddleware);",
    'app.get("/health", (req, res) => { res.json({ status: "ok" }); });',
    'app.use("/api/auth", authRoutes);'
  ].join("\n") },
  { path: "backend/src/routes/auth.routes.js", content: 'router.post("/forgot-password", handler);' },
  { path: "backend/src/telemetry.js", content: [
    'const serviceName = process.env.OTEL_SERVICE_NAME || "secure-alumni-backend";',
    'const requestCounter = meter.createCounter("alumni_http_server_requests", { unit: "{request}" });',
    'const requestDuration = meter.createHistogram("alumni_http_server_duration", { unit: "s" });',
    'const tracer = trace.getTracer("secure-alumni-backend");',
    'requestCounter.add(1, { method, route, status_code });',
    'requestDuration.record(0.1, { method, route, status_code });',
    'tracer.startSpan("HTTP POST");'
  ].join("\n") },
  { path: "docker-compose.yml", content: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://otel-collector:4318/v1/traces" },
  { path: "backend/src/config/db.js", content: "return mongoose.connect(env.mongoUri);" }
];

test("derives a deterministic route-specific model and line evidence from Express and OTel source", () => {
  const result = analyzeNodeExpressSource(alumniSnapshot);
  assert.equal(result.status, "partial");
  assert.equal(result.serviceName, "secure-alumni-backend");
  assert.deepEqual(result.routes.map(({ method, path }) => `${method} ${path}`), ["POST /api/auth/forgot-password", "GET /health"]);
  const request = result.expectedModel.requirements.find((item) => item.id === "http-requests-post-api-auth-forgot-password");
  assert.deepEqual(request, {
    id: "http-requests-post-api-auth-forgot-password", signal: "metric",
    metricName: "alumni_http_server_requests_total", dimensions: ["method", "route", "status_code"]
  });
  const duration = result.expectedModel.requirements.find((item) => item.id === "http-duration-post-api-auth-forgot-password");
  assert.equal(duration?.signal === "metric" ? duration.metricName : "", "alumni_http_server_duration_seconds_count");
  assert.equal(result.metricConfigs[request!.id as string]?.route, "/api/auth/forgot-password");
  const trace = result.expectedModel.requirements.find((item) => item.signal === "trace");
  assert.equal(trace?.signal === "trace" ? trace.serviceName : "", "secure-alumni-backend");
  const readiness = result.findings.find((finding) => finding.id === "health-dependency-readiness");
  assert.equal(readiness?.status, "incomplete");
  assert.ok(readiness?.evidence.some((item) => item.path === "backend/src/config/db.js" && item.line === 1));
  assert.ok(readiness?.evidence.some((item) => item.path === "backend/src/app.js" && item.line === 5));
  assert.equal(result.sourceDigest, analyzeNodeExpressSource([...alumniSnapshot].reverse()).sourceDigest);
  assert.equal(expectedModelDigest(result.expectedModel), expectedModelDigest(result.expectedModel));
});

test("reports missing request telemetry from route evidence without inventing observed metric names", () => {
  const result = analyzeNodeExpressSource([
    { path: "src/app.js", content: 'const express = require("express"); app.get("/orders", handler);' },
    { path: "package.json", content: '{"name":"orders-api"}' }
  ]);
  assert.equal(result.status, "partial");
  assert.ok(result.findings.some((finding) => finding.id === "http-request-counter-missing"));
  assert.ok(result.findings.some((finding) => finding.id === "http-duration-histogram-missing"));
  assert.equal(result.expectedModel.requirements.some((item) => item.signal === "metric"), false);
  assert.equal(result.expectedModel.serviceId, "orders-api");
});

test("does not infer alert requirements without alert declarations and rejects unsafe paths", () => {
  const result = analyzeNodeExpressSource(alumniSnapshot);
  assert.equal(result.expectedModel.requirements.some((item) => item.signal === "alert"), false);
  const traversal = analyzeNodeExpressSource([{ path: "../src/app.js", content: 'require("express")' }]);
  assert.equal(traversal.status, "invalid");
  const secret = analyzeNodeExpressSource([{ path: ".env", content: "not-uploaded" }]);
  assert.equal(secret.status, "invalid");
});
