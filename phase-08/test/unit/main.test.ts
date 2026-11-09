import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createProductionJwtConfig, installGracefulShutdown } from "../../src/main.js";

test("production identity configuration uses HTTPS OIDC and asymmetric algorithms", () => {
  const config = createProductionJwtConfig({
    OIDC_ISSUER: "https://login.microsoftonline.com/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/v2.0",
    OIDC_AUDIENCE: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    OIDC_TENANT_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    OIDC_ALLOWED_CLIENT_IDS: "cccccccc-cccc-4ccc-8ccc-cccccccccccc,dddddddd-dddd-4ddd-8ddd-dddddddddddd"
  });
  assert.equal(config.expectedIssuer, "https://login.microsoftonline.com/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/v2.0");
  assert.deepEqual(config.allowedAlgorithms, ["RS256", "ES256"]);
  assert.ok(config.claimsAdapter);
  assert.ok("keyResolver" in config);
});

test("production Entra configuration rejects missing, non-v2, and malformed values", () => {
  assert.throws(() => createProductionJwtConfig({}), /OIDC_ISSUER, OIDC_AUDIENCE, OIDC_TENANT_ID, and OIDC_ALLOWED_CLIENT_IDS/);
  const base = {
    OIDC_ISSUER: "https://login.microsoftonline.com/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/v2.0",
    OIDC_AUDIENCE: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    OIDC_TENANT_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    OIDC_ALLOWED_CLIENT_IDS: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
  };
  assert.throws(() => createProductionJwtConfig({ ...base, OIDC_ISSUER: "http://login.microsoftonline.com/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/v2.0" }), /exact single-tenant Entra v2 issuer/);
  assert.throws(() => createProductionJwtConfig({ ...base, OIDC_ISSUER: "https://login.microsoftonline.com/common/v2.0" }), /exact single-tenant Entra v2 issuer/);
  assert.throws(() => createProductionJwtConfig({ ...base, OIDC_TENANT_ID: "not-a-guid" }), /OIDC_TENANT_ID must be a GUID/);
  assert.throws(() => createProductionJwtConfig({ ...base, OIDC_ALLOWED_CLIENT_IDS: "" }), /OIDC_ISSUER, OIDC_AUDIENCE, OIDC_TENANT_ID, and OIDC_ALLOWED_CLIENT_IDS/);
  assert.throws(() => createProductionJwtConfig({ ...base, OIDC_ALLOWED_CLIENT_IDS: "not-a-guid" }), /comma-separated list/);
  assert.throws(() => createProductionJwtConfig({ ...base, OIDC_AUDIENCE: "not-a-guid" }), /API application ID GUID/);
  assert.throws(() => createProductionJwtConfig({ ...base, OIDC_JWKS_URI: "http://login.microsoftonline.com/keys" }), /HTTPS/);
});

test("SIGINT and SIGTERM share one graceful and idempotent host shutdown", async () => {
  const signals = new EventEmitter();
  let stopCount = 0;
  let release!: () => void;
  const stopGate = new Promise<void>((resolve) => { release = resolve; });
  const remove = installGracefulShutdown({ async stop() { stopCount++; await stopGate; } }, signals as never);
  signals.emit("SIGINT");
  signals.emit("SIGTERM");
  assert.equal(stopCount, 1);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  remove();
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});
