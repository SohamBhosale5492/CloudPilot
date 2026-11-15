import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { buildResponse } from "./routes";
import { createRequestHandler, type RequestMetrics } from "./server";
import { responseSizeBytes, shutdownTelemetry } from "./telemetry";

test.after(async () => {
  await shutdownTelemetry();
});

test("telemetry exports demo_http_server_response_size_bytes counter", () => {
  assert.equal(typeof responseSizeBytes.add, "function");
});

test("records UTF-8 response body size and bounded labels for /api/demo", async () => {
  const counterCalls: Array<{ value: number; attributes?: Record<string, string> }> = [];
  const durationCalls: Array<{ value: number; attributes?: Record<string, string> }> = [];
  const sizeCalls: Array<{ value: number; attributes?: Record<string, string> }> = [];

  const metrics: RequestMetrics = {
    requestCounter: { add: (value, attributes) => counterCalls.push({ value, attributes }) },
    requestDuration: { record: (value, attributes) => durationCalls.push({ value, attributes }) },
    responseSizeBytes: { add: (value, attributes) => sizeCalls.push({ value, attributes }) }
  };

  const server = http.createServer(createRequestHandler(metrics));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert(address && typeof address === "object");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/demo`);
    const body = await response.text();
    const expectedBody = buildResponse("/api/demo").body;

    assert.equal(response.status, 200);
    assert.equal(body, expectedBody);

    assert.equal(counterCalls.length, 1);
    assert.equal(durationCalls.length, 1);
    assert.equal(sizeCalls.length, 1);

    const expectedLabels = {
      method: "GET",
      route: "/api/demo",
      status_code: "200"
    };
    assert.deepEqual(counterCalls[0], { value: 1, attributes: expectedLabels });
    assert.deepEqual(durationCalls[0].attributes, expectedLabels);
    assert.equal(typeof durationCalls[0].value, "number");
    assert.ok(durationCalls[0].value >= 0);
    assert.deepEqual(sizeCalls[0], {
      value: Buffer.byteLength(expectedBody, "utf8"),
      attributes: expectedLabels
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("records bounded unmatched route and 404 status_code for unknown paths", async () => {
  const sizeCalls: Array<{ value: number; attributes?: Record<string, string> }> = [];

  const metrics: RequestMetrics = {
    requestCounter: { add: () => undefined },
    requestDuration: { record: () => undefined },
    responseSizeBytes: { add: (value, attributes) => sizeCalls.push({ value, attributes }) }
  };

  const server = http.createServer(createRequestHandler(metrics));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert(address && typeof address === "object");

    const response = await fetch(`http://127.0.0.1:${address.port}/unknown/123`);
    await response.text();
    const expectedBody = buildResponse("unmatched").body;

    assert.equal(response.status, 404);
    assert.deepEqual(sizeCalls, [
      {
        value: Buffer.byteLength(expectedBody, "utf8"),
        attributes: {
          method: "GET",
          route: "unmatched",
          status_code: "404"
        }
      }
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("server records configured remediation metrics on matching HTTP requests", async () => {
  const dynamicCalls: Array<{ value: number; attributes?: Record<string, string> }> = [];
  const fakeCounter = {
    add: (val: number, attr?: Record<string, string>) => dynamicCalls.push({ value: val, attributes: attr })
  };

  const configured = [
    {
      definition: {
        name: "cloudpilot_pr_test_heartbeat_total",
        labels: { service: "demo-service", route: "/api/demo", method: "GET" }
      },
      counter: fakeCounter as any,
      otelMetricName: "cloudpilot_pr_test_heartbeat"
    }
  ];

  const metrics: RequestMetrics = {
    requestCounter: { add: () => undefined },
    requestDuration: { record: () => undefined },
    responseSizeBytes: { add: () => undefined }
  };

  const server = http.createServer(createRequestHandler(metrics, configured));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert(address && typeof address === "object");

    // Request /api/demo -> matches configured remediation metric
    const res = await fetch(`http://127.0.0.1:${address.port}/api/demo`);
    assert.equal(res.status, 200);

    assert.equal(dynamicCalls.length, 1);
    assert.deepEqual(dynamicCalls[0], {
      value: 1,
      attributes: {
        method: "GET",
        route: "/api/demo",
        status_code: "200",
        service: "demo-service"
      }
    });

    // Request /health -> should not increment /api/demo metric
    const healthRes = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(healthRes.status, 200);
    assert.equal(dynamicCalls.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("server serves configured health-checks.yaml endpoints with HTTP 200", async () => {
  const metrics: RequestMetrics = {
    requestCounter: { add: () => undefined },
    requestDuration: { record: () => undefined },
    responseSizeBytes: { add: () => undefined }
  };

  const server = http.createServer(
    createRequestHandler(metrics, [], [{ service: "demo-service", endpoint: "/ready" }])
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert(address && typeof address === "object");

    const readyRes = await fetch(`http://127.0.0.1:${address.port}/ready`);
    assert.equal(readyRes.status, 200);
    const body = await readyRes.json();
    assert.deepEqual(body, {
      status: "healthy",
      service: "demo-service",
      endpoint: "/ready"
    });

    const missingRes = await fetch(`http://127.0.0.1:${address.port}/nonexistent`);
    assert.equal(missingRes.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});


