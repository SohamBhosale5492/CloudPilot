import test from "node:test";
import assert from "node:assert/strict";
import { validateProjectCreatePayload, sanitizeErrorDetails } from "../../src/api/validation.js";

test("validateProjectCreatePayload: valid project payload", () => {
  const result = validateProjectCreatePayload({
    name: "payment-service",
    repositoryUrl: "https://github.com/cloudpilot/payment-service",
    targetConfig: {
      healthBaseUrl: "http://localhost:8080",
      prometheusBaseUrl: "http://localhost:9090"
    },
    expectedModel: {
      service: "payment-service",
      version: "1.0.0",
      requirements: []
    }
  });

  assert.equal(result.valid, true);
  assert.equal(result.data?.name, "payment-service");
  assert.equal(result.data?.repositoryUrl, "https://github.com/cloudpilot/payment-service");
  assert.equal(result.data?.targetConfig?.healthBaseUrl, "http://localhost:8080/");
});

test("validateProjectCreatePayload: rejects missing or empty name", () => {
  const res1 = validateProjectCreatePayload({ name: "" });
  assert.equal(res1.valid, false);
  assert.match(res1.error ?? "", /Field 'name' is required/i);

  const res2 = validateProjectCreatePayload({});
  assert.equal(res2.valid, false);

  const res3 = validateProjectCreatePayload({ name: "   " });
  assert.equal(res3.valid, false);
});

test("validateProjectCreatePayload: rejects name longer than 100 chars", () => {
  const res = validateProjectCreatePayload({ name: "a".repeat(101) });
  assert.equal(res.valid, false);
  assert.match(res.error ?? "", /cannot exceed 100 characters/i);
});

test("validateProjectCreatePayload: rejects invalid repositoryUrl", () => {
  const res = validateProjectCreatePayload({
    name: "test-svc",
    repositoryUrl: "not-a-valid-url"
  });
  assert.equal(res.valid, false);
  assert.match(res.error ?? "", /Invalid 'repositoryUrl'/i);
});

test("validateProjectCreatePayload: redacts credentials from repositoryUrl", () => {
  const res = validateProjectCreatePayload({
    name: "test-svc",
    repositoryUrl: "https://user:secretpass@github.com/org/repo.git"
  });
  assert.equal(res.valid, true);
  // Redacted userinfo
  assert.ok(!res.data?.repositoryUrl?.includes("secretpass"));
});

test("sanitizeErrorDetails: strips bearer tokens and query credentials", () => {
  const err1 = new Error("Failed connecting with Bearer eyJhbGciOi... secret token");
  const sanitized1 = sanitizeErrorDetails(err1);
  assert.ok(!sanitized1.includes("eyJhbGciOi"));
  assert.ok(sanitized1.includes("[REDACTED]"));

  const err2 = "Error at https://example.com/api?token=secret123&key=abc456";
  const sanitized2 = sanitizeErrorDetails(err2);
  assert.ok(!sanitized2.includes("secret123"));
  assert.ok(!sanitized2.includes("abc456"));
});
