import assert from "node:assert/strict";
import test from "node:test";
import { buildResponse, classifyRoute } from "./routes";

test("classifies only bounded route labels", () => {
  assert.equal(classifyRoute("/health"), "/health");
  assert.equal(classifyRoute("/api/demo"), "/api/demo");
  assert.equal(classifyRoute("/api/demo/123"), "unmatched");
});

test("builds deterministic demo response", () => {
  const response = buildResponse("/api/demo");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    service: "demo-service",
    phase: "01",
    message: "deterministic demo response"
  });
});
