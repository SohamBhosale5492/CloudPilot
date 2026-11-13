import test from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { CloudPilotApiServer } from "../../src/api/server.js";
import { isDevelopmentEnvironment, logDevelopmentIssuerMismatch, type JwtVerifierConfig } from "../../src/auth/jwt-verifier.js";
import type { BoundedScanRunner } from "../../src/jobs/scan-runner.js";
import { mintTestJwt, TEST_AUDIENCE, TEST_ISSUER, TEST_PUBLIC_KEY } from "../jwt-signer.js";

const jwtConfig: JwtVerifierConfig = {
  expectedIssuer: TEST_ISSUER,
  expectedAudience: TEST_AUDIENCE,
  publicKeyOrSecret: TEST_PUBLIC_KEY,
  allowedAlgorithms: ["RS256"]
};

async function createTestServer(): Promise<{ server: CloudPilotApiServer; port: number }> {
  const server = new CloudPilotApiServer({
    prisma: {} as PrismaClient,
    jwtConfig,
    scanRunner: { initialize: async () => undefined, shutdown: async () => undefined } as unknown as BoundedScanRunner,
    routeExtensions: [{
      handle: async (context) => {
        if (context.pathname !== "/api/v1/test") return false;
        context.sendJson(200, { userId: context.identity.userId });
        return true;
      }
    }]
  });
  const port = await server.start(0, "127.0.0.1");
  return { server, port };
}

test("development issuer diagnostic logs only issuer values and request ID; response remains generic", async () => {
  const token = mintTestJwt({
    iss: "https://sensitive-invalid-issuer.example",
    sub: "must-not-be-logged-user",
    email: "must-not-be-logged@example.test"
  });
  const originalWarn = console.warn;
  const logged: unknown[][] = [];
  console.warn = (...args: unknown[]) => { logged.push(args); };

  try {
    logDevelopmentIssuerMismatch(token, TEST_ISSUER, "request-correlation-id", "development");
    assert.equal(logged.length, 1);
    assert.equal(logged[0].length, 1);
    const record = JSON.parse(String(logged[0][0])) as Record<string, unknown>;
    assert.deepEqual(Object.keys(record).sort(), ["actualIssuer", "category", "expectedIssuer", "requestId"]);
    assert.equal(record.category, "issuer_mismatch");
    assert.equal(record.actualIssuer, "https://sensitive-invalid-issuer.example");
    assert.equal(record.expectedIssuer, TEST_ISSUER);
    assert.equal(record.requestId, "request-correlation-id");
    assert.ok(!String(logged[0][0]).includes(token));
    assert.ok(!String(logged[0][0]).includes("must-not-be-logged"));
  } finally {
    console.warn = originalWarn;
  }
});

test("issuer diagnostic is silent outside development", () => {
  const originalWarn = console.warn;
  const logged: unknown[][] = [];
  console.warn = (...args: unknown[]) => { logged.push(args); };
  try {
    logDevelopmentIssuerMismatch(
      mintTestJwt({ iss: "https://invalid.example" }),
      TEST_ISSUER,
      "request-correlation-id",
      "production"
    );
    assert.equal(logged.length, 0);
  } finally {
    console.warn = originalWarn;
  }
});

test("development mode detection tolerates casing and surrounding whitespace", () => {
  assert.equal(isDevelopmentEnvironment(" Development "), true);
  assert.equal(isDevelopmentEnvironment(undefined), false);
  assert.equal(isDevelopmentEnvironment("production"), false);
});

test("successful JWT authentication still reaches authenticated route extensions", async () => {
  const { server, port } = await createTestServer();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/test`, {
      headers: { Authorization: `Bearer ${mintTestJwt({ sub: "auth-user" })}` }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { userId: "auth-user" });
    assert.match(response.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/i);
  } finally {
    await server.stop();
  }
});
