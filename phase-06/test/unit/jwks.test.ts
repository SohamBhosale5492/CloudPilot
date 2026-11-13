import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { JwksKeyResolver } from "../../src/auth/jwks-resolver.js";
import { verifyJwtToken, JwksJwtVerifierConfig } from "../../src/auth/jwt-verifier.js";
import {
  mintTestJwt,
  TEST_ISSUER,
  TEST_AUDIENCE,
  TEST_PUBLIC_KEY,
  TEST_PRIVATE_KEY,
  TEST_EC_PUBLIC_KEY,
  TEST_EC_PRIVATE_KEY
} from "../jwt-signer.js";

function getRsaJwk(kid = "test-rsa-key-1"): Record<string, unknown> {
  const jwk = crypto.createPublicKey(TEST_PUBLIC_KEY).export({ format: "jwk" });
  return {
    ...jwk,
    kid,
    alg: "RS256",
    use: "sig"
  };
}

function getEcJwk(kid = "test-ec-key-1"): Record<string, unknown> {
  const jwk = crypto.createPublicKey(TEST_EC_PUBLIC_KEY).export({ format: "jwk" });
  return {
    ...jwk,
    kid,
    alg: "ES256",
    use: "sig"
  };
}

test("JWKS: discovers OIDC metadata and resolves RS256 key", async () => {
  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u === `${TEST_ISSUER}/.well-known/openid-configuration`) {
      return new Response(JSON.stringify({
        issuer: TEST_ISSUER,
        jwks_uri: `${TEST_ISSUER}/jwks.json`
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u === `${TEST_ISSUER}/jwks.json`) {
      return new Response(JSON.stringify({
        keys: [getRsaJwk("key-rsa-1")]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  };

  const resolver = new JwksKeyResolver({
    expectedIssuer: TEST_ISSUER,
    allowHttp: true,
    allowPrivateIps: true,
    fetchImpl: mockFetch
  });

  const config: JwksJwtVerifierConfig = {
    expectedIssuer: TEST_ISSUER,
    expectedAudience: TEST_AUDIENCE,
    keyResolver: resolver
  };

  const token = mintTestJwt({
    kid: "key-rsa-1",
    sub: "usr-jwks-rsa",
    tenantId: "tnt-jwks",
    roles: ["operator"]
  });

  const res = await verifyJwtToken(token, config);
  assert.equal(res.valid, true);
  assert.ok(res.securityContext);
  assert.equal(res.securityContext.identity.userId, "usr-jwks-rsa");
  assert.deepEqual(res.securityContext.identity.roles, ["operator"]);
});

test("JWKS: verifies ES256 token using EC P-256 key from JWKS", async () => {
  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("openid-configuration")) {
      return new Response(JSON.stringify({
        issuer: TEST_ISSUER,
        jwks_uri: `${TEST_ISSUER}/jwks.json`
      }), { status: 200 });
    }
    if (u.includes("jwks.json")) {
      return new Response(JSON.stringify({
        keys: [getEcJwk("key-ec-1")]
      }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const resolver = new JwksKeyResolver({
    expectedIssuer: TEST_ISSUER,
    allowHttp: true,
    allowPrivateIps: true,
    fetchImpl: mockFetch
  });

  const config: JwksJwtVerifierConfig = {
    expectedIssuer: TEST_ISSUER,
    expectedAudience: TEST_AUDIENCE,
    keyResolver: resolver,
    allowedAlgorithms: ["ES256"]
  };

  const token = mintTestJwt({
    algorithm: "ES256",
    kid: "key-ec-1",
    sub: "usr-jwks-ec",
    tenantId: "tnt-jwks",
    roles: ["admin"]
  });

  const res = await verifyJwtToken(token, config);
  assert.equal(res.valid, true);
  assert.equal(res.securityContext?.identity.userId, "usr-jwks-ec");
});

test("JWKS: rejects a key whose declared algorithm differs from the token algorithm", async () => {
  const incompatible = { ...getRsaJwk("rsa-marked-es"), alg: "ES256" };
  const resolver = new JwksKeyResolver({
    expectedIssuer: TEST_ISSUER,
    jwksUri: `${TEST_ISSUER}/jwks.json`,
    allowHttp: true,
    allowPrivateIps: true,
    fetchImpl: async () => new Response(JSON.stringify({ keys: [incompatible] }), { status: 200 })
  });
  const result = await verifyJwtToken(mintTestJwt({ kid: "rsa-marked-es" }), {
    expectedIssuer: TEST_ISSUER,
    expectedAudience: TEST_AUDIENCE,
    keyResolver: resolver,
    allowedAlgorithms: ["RS256"]
  });
  assert.equal(result.valid, false);
  assert.match(result.error ?? "", /Signing key not found/i);
});

test("JWKS: rotates key when new token with new kid arrives", async () => {
  // Generate rotated RSA key
  const { privateKey: rotatedPriv, publicKey: rotatedPub } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });

  const rotatedJwk = {
    ...crypto.createPublicKey(rotatedPub).export({ format: "jwk" }),
    kid: "key-rsa-v2",
    alg: "RS256",
    use: "sig"
  };

  let keysServed = [getRsaJwk("key-rsa-v1")];

  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("openid-configuration")) {
      return new Response(JSON.stringify({
        issuer: TEST_ISSUER,
        jwks_uri: `${TEST_ISSUER}/jwks.json`
      }), { status: 200 });
    }
    if (u.includes("jwks.json")) {
      return new Response(JSON.stringify({ keys: keysServed }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const resolver = new JwksKeyResolver({
    expectedIssuer: TEST_ISSUER,
    allowHttp: true,
    allowPrivateIps: true,
    minRefreshIntervalMs: 0, // Disable throttle for rotation test
    fetchImpl: mockFetch
  });

  const config: JwksJwtVerifierConfig = {
    expectedIssuer: TEST_ISSUER,
    expectedAudience: TEST_AUDIENCE,
    keyResolver: resolver
  };

  // Verify first token
  const tokenV1 = mintTestJwt({ kid: "key-rsa-v1", sub: "usr-v1", tenantId: "tnt-1", roles: ["viewer"] });
  const res1 = await verifyJwtToken(tokenV1, config);
  assert.equal(res1.valid, true);

  // Rotate key in mock provider
  keysServed = [getRsaJwk("key-rsa-v1"), rotatedJwk];

  // Verify token signed with new key
  const tokenV2 = mintTestJwt({
    kid: "key-rsa-v2",
    signingKey: rotatedPriv,
    sub: "usr-v2",
    tenantId: "tnt-1",
    roles: ["viewer"]
  });

  const res2 = await verifyJwtToken(tokenV2, config);
  assert.equal(res2.valid, true);
  assert.equal(res2.securityContext?.identity.userId, "usr-v2");
});

test("JWKS: throttles unknown kid refreshes to prevent outbound fetch abuse", async () => {
  let fetchCount = 0;
  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("openid-configuration")) {
      return new Response(JSON.stringify({
        issuer: TEST_ISSUER,
        jwks_uri: `${TEST_ISSUER}/jwks.json`
      }), { status: 200 });
    }
    if (u.includes("jwks.json")) {
      fetchCount++;
      return new Response(JSON.stringify({ keys: [getRsaJwk("key-valid")] }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const resolver = new JwksKeyResolver({
    expectedIssuer: TEST_ISSUER,
    allowHttp: true,
    allowPrivateIps: true,
    minRefreshIntervalMs: 60000, // 60s throttle
    fetchImpl: mockFetch
  });

  const config: JwksJwtVerifierConfig = {
    expectedIssuer: TEST_ISSUER,
    expectedAudience: TEST_AUDIENCE,
    keyResolver: resolver
  };

  // 1st request with unknown kid -> triggers fetch
  const tokenUnknown1 = mintTestJwt({ kid: "key-random-1", sub: "u1", tenantId: "t1", roles: ["viewer"] });
  const res1 = await verifyJwtToken(tokenUnknown1, config);
  assert.equal(res1.valid, false);
  assert.equal(fetchCount, 1);

  // 2nd request immediately with different unknown kid -> throttled, NO new fetch
  const tokenUnknown2 = mintTestJwt({ kid: "key-random-2", sub: "u2", tenantId: "t1", roles: ["viewer"] });
  const res2 = await verifyJwtToken(tokenUnknown2, config);
  assert.equal(res2.valid, false);
  assert.match(res2.error ?? "", /throttled/i);
  assert.equal(fetchCount, 1); // Still 1 fetch!
});

test("JWKS: concurrent cache refreshes share single in-flight fetch", async () => {
  let jwksFetchCount = 0;
  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("openid-configuration")) {
      return new Response(JSON.stringify({
        issuer: TEST_ISSUER,
        jwks_uri: `${TEST_ISSUER}/jwks.json`
      }), { status: 200 });
    }
    if (u.includes("jwks.json")) {
      jwksFetchCount++;
      // Simulate 50ms latency
      await new Promise((r) => setTimeout(r, 50));
      return new Response(JSON.stringify({ keys: [getRsaJwk("key-shared")] }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const resolver = new JwksKeyResolver({
    expectedIssuer: TEST_ISSUER,
    allowHttp: true,
    allowPrivateIps: true,
    fetchImpl: mockFetch
  });

  const config: JwksJwtVerifierConfig = {
    expectedIssuer: TEST_ISSUER,
    expectedAudience: TEST_AUDIENCE,
    keyResolver: resolver
  };

  const token = mintTestJwt({ kid: "key-shared", sub: "u-shared", tenantId: "t1", roles: ["viewer"] });

  // Launch 5 simultaneous verifications
  const results = await Promise.all([
    verifyJwtToken(token, config),
    verifyJwtToken(token, config),
    verifyJwtToken(token, config),
    verifyJwtToken(token, config),
    verifyJwtToken(token, config)
  ]);

  for (const r of results) {
    assert.equal(r.valid, true);
  }
  // Exactly 1 fetch despite 5 concurrent callers
  assert.equal(jwksFetchCount, 1);
});

test("JWKS: rejects token with jku or x5u headers unconditionally", async () => {
  const resolver = new JwksKeyResolver({
    expectedIssuer: TEST_ISSUER,
    allowHttp: true,
    allowPrivateIps: true
  });

  const config: JwksJwtVerifierConfig = {
    expectedIssuer: TEST_ISSUER,
    expectedAudience: TEST_AUDIENCE,
    keyResolver: resolver
  };

  const tokenJku = mintTestJwt({
    jku: "https://attacker.com/jwks.json",
    sub: "u-jku",
    tenantId: "t1",
    roles: ["viewer"]
  });

  const res1 = await verifyJwtToken(tokenJku, config);
  assert.equal(res1.valid, false);
  assert.match(res1.error ?? "", /forbidden URL claim/i);

  const tokenX5u = mintTestJwt({
    x5u: "https://attacker.com/cert.pem",
    sub: "u-x5u",
    tenantId: "t1",
    roles: ["viewer"]
  });

  const res2 = await verifyJwtToken(tokenX5u, config);
  assert.equal(res2.valid, false);
  assert.match(res2.error ?? "", /forbidden URL claim/i);
});

test("JWKS: rejects HS256 algorithm unconditionally in JWKS mode", async () => {
  const resolver = new JwksKeyResolver({
    expectedIssuer: TEST_ISSUER,
    allowHttp: true,
    allowPrivateIps: true
  });

  const config: JwksJwtVerifierConfig = {
    expectedIssuer: TEST_ISSUER,
    expectedAudience: TEST_AUDIENCE,
    keyResolver: resolver,
    allowedAlgorithms: ["RS256", "HS256"] // Even if HS256 is erroneously requested
  };

  const tokenHs = mintTestJwt({
    algorithm: "HS256",
    sub: "u-hs",
    tenantId: "t1",
    roles: ["viewer"]
  });

  const res = await verifyJwtToken(tokenHs, config);
  assert.equal(res.valid, false);
  assert.match(res.error ?? "", /Symmetric algorithm HS256 is not permitted in JWKS mode/i);
});

test("JWKS: blocks cloud metadata service endpoints (SSRF)", async () => {
  // Discovery pointing to cloud metadata
  const resolverMetadata = new JwksKeyResolver({
    expectedIssuer: "http://169.254.169.254",
    allowHttp: true,
    allowPrivateIps: true
  });

  await assert.rejects(
    async () => resolverMetadata.refreshJwks(),
    /blocked by SSRF policy/i
  );
});

test("JWKS: handles unavailable provider or malformed metadata gracefully", async () => {
  const mockFetch: typeof fetch = async () => {
    return new Response("Internal Server Error", { status: 500 });
  };

  const resolver = new JwksKeyResolver({
    expectedIssuer: TEST_ISSUER,
    allowHttp: true,
    allowPrivateIps: true,
    fetchImpl: mockFetch
  });

  const config: JwksJwtVerifierConfig = {
    expectedIssuer: TEST_ISSUER,
    expectedAudience: TEST_AUDIENCE,
    keyResolver: resolver
  };

  const token = mintTestJwt({ kid: "key-1", sub: "u1", tenantId: "t1", roles: ["viewer"] });
  const res = await verifyJwtToken(token, config);
  assert.equal(res.valid, false);
  assert.match(res.error ?? "", /Key resolution error|returned HTTP 500/i);
});

function stalledResponse(signal?: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
    }
  });
  return new Response(body, { status: 200 });
}

test("JWKS body read is covered by the request timeout", async () => {
  const resolver = new JwksKeyResolver({
    expectedIssuer: TEST_ISSUER,
    jwksUri: `${TEST_ISSUER}/jwks.json`,
    allowHttp: true,
    allowPrivateIps: true,
    timeoutMs: 15,
    fetchImpl: async (_url, init) => stalledResponse(init?.signal ?? undefined)
  });
  await assert.rejects(resolver.refreshJwks(), /timed out/i);
});

test("OIDC discovery body read is covered by the request timeout", async () => {
  const resolver = new JwksKeyResolver({
    expectedIssuer: TEST_ISSUER,
    allowHttp: true,
    allowPrivateIps: true,
    timeoutMs: 15,
    fetchImpl: async (_url, init) => stalledResponse(init?.signal ?? undefined)
  });
  await assert.rejects(resolver.refreshJwks(), /timed out/i);
});

test("oversized JWKS and discovery bodies are rejected while streaming", async () => {
  const oversized = JSON.stringify({ keys: [getRsaJwk()] });
  const jwks = new JwksKeyResolver({
    expectedIssuer: TEST_ISSUER,
    jwksUri: `${TEST_ISSUER}/jwks.json`,
    allowHttp: true,
    allowPrivateIps: true,
    maxResponseBytes: 16,
    fetchImpl: async () => new Response(oversized, { status: 200 })
  });
  await assert.rejects(jwks.refreshJwks(), /exceeded maximum size limit/i);

  const discovery = new JwksKeyResolver({
    expectedIssuer: TEST_ISSUER,
    allowHttp: true,
    allowPrivateIps: true,
    maxResponseBytes: 16,
    fetchImpl: async () => new Response(oversized, { status: 200 })
  });
  await assert.rejects(discovery.refreshJwks(), /exceeded maximum size limit/i);
});

test("OIDC discovery requires a non-empty exact issuer before trusting jwks_uri", async () => {
  for (const metadata of [
    { jwks_uri: `${TEST_ISSUER}/jwks.json` },
    { issuer: "", jwks_uri: `${TEST_ISSUER}/jwks.json` },
    { issuer: "https://other-issuer.test", jwks_uri: `${TEST_ISSUER}/jwks.json` }
  ]) {
    let jwksRequested = false;
    const resolver = new JwksKeyResolver({
      expectedIssuer: TEST_ISSUER,
      allowHttp: true,
      allowPrivateIps: true,
      fetchImpl: async (url) => {
        if (String(url).includes("openid-configuration")) return new Response(JSON.stringify(metadata), { status: 200 });
        jwksRequested = true;
        return new Response(JSON.stringify({ keys: [] }), { status: 200 });
      }
    });
    await assert.rejects(resolver.refreshJwks(), /issuer/i);
    assert.equal(jwksRequested, false);
  }
});

test("discovery and JWKS redirects are rejected without following external or restricted destinations", async () => {
  for (const location of ["https://other.example/jwks", "http://169.254.169.254/latest/meta-data"]) {
    for (const directJwks of [false, true]) {
      let requests = 0;
      let redirectMode: RequestRedirect | undefined;
      const resolver = new JwksKeyResolver({
        expectedIssuer: TEST_ISSUER,
        ...(directJwks ? { jwksUri: `${TEST_ISSUER}/jwks.json` } : {}),
        allowHttp: true,
        allowPrivateIps: true,
        fetchImpl: async (_url, init) => {
          requests++;
          redirectMode = init?.redirect;
          return new Response(null, { status: 302, headers: { location } });
        }
      });
      await assert.rejects(resolver.refreshJwks(), /redirect/i);
      assert.equal(redirectMode, "error");
      assert.equal(requests, 1, "redirect destination must never be requested");
    }
  }
});
