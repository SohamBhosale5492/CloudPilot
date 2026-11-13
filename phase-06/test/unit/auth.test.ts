import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { classifyJwtVerificationFailure, verifyJwtToken, JwtVerifierConfig } from "../../src/auth/jwt-verifier.js";
import { hasPermission, assertPermission } from "../../src/rbac/guard.js";
import {
  mintTestJwt,
  TEST_PUBLIC_KEY,
  TEST_ISSUER,
  TEST_AUDIENCE,
  TEST_SECRET
} from "../jwt-signer.js";

// RS256-only config (production default)
const DEFAULT_CONFIG: JwtVerifierConfig = {
  expectedIssuer: TEST_ISSUER,
  expectedAudience: TEST_AUDIENCE,
  publicKeyOrSecret: TEST_PUBLIC_KEY,
  allowedAlgorithms: ["RS256"]
};

test("verifyJwtToken: valid RS256 token populates security context", () => {
  const token = mintTestJwt({
    sub: "usr-123",
    tenantId: "tnt-456",
    roles: ["admin", "operator"],
    email: "admin@example.com"
  });

  const res = verifyJwtToken(token, DEFAULT_CONFIG);
  assert.equal(res.valid, true);
  assert.ok(res.securityContext);
  assert.equal(res.securityContext.identity.userId, "usr-123");
  assert.equal(res.securityContext.identity.tenantId, "tnt-456");
  assert.deepEqual(res.securityContext.identity.roles, ["admin", "operator"]);
  assert.equal(res.securityContext.identity.email, "admin@example.com");
  assert.equal(classifyJwtVerificationFailure(res), undefined);
});

test("JWT failure diagnostics map verifier errors to fixed safe categories", () => {
  const cases = [
    ["Invalid issuer: raw issuer detail", "issuer_mismatch"],
    ["Invalid audience: raw audience detail", "audience_mismatch"],
    ["Missing or invalid Entra 'tid' tenant GUID", "tenant_mismatch"],
    ["Token has expired", "token_expired"],
    ["Token not active yet (nbf)", "token_not_yet_valid"],
    ["Unsupported Entra token type", "idtyp_missing_or_invalid"],
    ["Entra client application is not allowed", "azp_missing_or_not_allowed"],
    ["Missing or invalid roles claim", "roles_missing_or_invalid"],
    ["Unsupported Entra token version", "token_version_invalid"],
    ["Invalid token signature", "signature_invalid"],
    ["Key resolution error: secret-bearing detail", "jwks_failure"],
    ["Malformed JWT token structure", "malformed_token"],
    ["Unclassified failure with raw claim details", "other_verification_failure"]
  ] as const;

  for (const [error, expected] of cases) {
    assert.equal(classifyJwtVerificationFailure({ valid: false, error }), expected);
  }
});

test("verifyJwtToken: valid HS256 token requires explicit opt-in", () => {
  const token = mintTestJwt({
    algorithm: "HS256",
    sub: "usr-hs",
    tenantId: "tnt-hs",
    roles: ["viewer"]
  });

  // Should fail with default RS256-only config
  const defaultRes = verifyJwtToken(token, DEFAULT_CONFIG);
  assert.equal(defaultRes.valid, false);
  assert.match(defaultRes.error ?? "", /Unsupported or disallowed algorithm: HS256/i);

  // Should succeed only when HS256 is explicitly allowed
  const hsConfig: JwtVerifierConfig = {
    expectedIssuer: TEST_ISSUER,
    expectedAudience: TEST_AUDIENCE,
    publicKeyOrSecret: TEST_SECRET,
    allowedAlgorithms: ["HS256"]
  };

  const res = verifyJwtToken(token, hsConfig);
  assert.equal(res.valid, true);
  assert.equal(res.securityContext?.identity.userId, "usr-hs");
  assert.equal(res.securityContext?.identity.tenantId, "tnt-hs");
  assert.deepEqual(res.securityContext?.identity.roles, ["viewer"]);
});

test("verifyJwtToken: rejects 'none' algorithm unconditionally", () => {
  // Manually construct a 'none' JWT (unsigned)
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    sub: "attacker",
    tenant_id: "t1",
    roles: ["admin"],
    exp: Math.floor(Date.now() / 1000) + 3600,
    nbf: Math.floor(Date.now() / 1000) - 10,
    iat: Math.floor(Date.now() / 1000)
  })).toString("base64url");

  const noneToken = `${header}.${payload}.`;

  // Even if attacker tries to put "none" in allowedAlgorithms, it should still be rejected
  const weakConfig: JwtVerifierConfig = {
    ...DEFAULT_CONFIG,
    allowedAlgorithms: ["none", "RS256"]
  };
  const res = verifyJwtToken(noneToken, weakConfig);
  assert.equal(res.valid, false);
  assert.match(res.error ?? "", /none/i);
});

test("verifyJwtToken: HS256 rejects non-string key", () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });

  // Create an HS256 token then try to verify with an RSA key object (wrong type)
  const token = mintTestJwt({ algorithm: "HS256" });
  const keyObject = crypto.createPrivateKey(privateKey);
  const config: JwtVerifierConfig = {
    expectedIssuer: TEST_ISSUER,
    expectedAudience: TEST_AUDIENCE,
    publicKeyOrSecret: keyObject,
    allowedAlgorithms: ["HS256"]
  };
  const res = verifyJwtToken(token, config);
  assert.equal(res.valid, false);
  assert.match(res.error ?? "", /HS256 requires a non-empty string secret/i);
});

test("verifyJwtToken: HS256 rejects truncated signature (timing-safe equal length check)", () => {
  // Build a token and truncate its signature
  const token = mintTestJwt({ algorithm: "HS256" });
  const parts = token.split(".");
  const truncatedToken = `${parts[0]}.${parts[1]}.SHORT`;

  const hsConfig: JwtVerifierConfig = {
    expectedIssuer: TEST_ISSUER,
    expectedAudience: TEST_AUDIENCE,
    publicKeyOrSecret: TEST_SECRET,
    allowedAlgorithms: ["HS256"]
  };

  const res = verifyJwtToken(truncatedToken, hsConfig);
  assert.equal(res.valid, false);
  assert.match(res.error ?? "", /Invalid token signature/i);
});

test("verifyJwtToken: rejects empty or malformed token", () => {
  const emptyRes = verifyJwtToken("", DEFAULT_CONFIG);
  assert.equal(emptyRes.valid, false);
  assert.equal(emptyRes.statusCode, 401);

  const malformedRes = verifyJwtToken("not.a.valid.jwt.token", DEFAULT_CONFIG);
  assert.equal(malformedRes.valid, false);
  assert.equal(malformedRes.statusCode, 401);
});

test("verifyJwtToken: rejects bad signature", () => {
  const { privateKey: otherKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });

  const forgedToken = mintTestJwt({ signingKey: otherKey });
  const res = verifyJwtToken(forgedToken, DEFAULT_CONFIG);
  assert.equal(res.valid, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.error ?? "", /Invalid token signature/i);
});

test("verifyJwtToken: rejects expired token", () => {
  const expiredToken = mintTestJwt({ expSecondsFromNow: -100 });
  const res = verifyJwtToken(expiredToken, DEFAULT_CONFIG);
  assert.equal(res.valid, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.error ?? "", /expired/i);
});

test("verifyJwtToken: rejects token before nbf", () => {
  const futureToken = mintTestJwt({ nbfSecondsFromNow: 300 });
  const res = verifyJwtToken(futureToken, DEFAULT_CONFIG);
  assert.equal(res.valid, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.error ?? "", /not active/i);
});

test("verifyJwtToken: rejects invalid issuer", () => {
  const wrongIssuerToken = mintTestJwt({ iss: "https://evil.issuer.com" });
  const res = verifyJwtToken(wrongIssuerToken, DEFAULT_CONFIG);
  assert.equal(res.valid, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.error ?? "", /Invalid issuer/i);
});

test("verifyJwtToken: rejects invalid audience", () => {
  const wrongAudToken = mintTestJwt({ aud: "wrong-audience" });
  const res = verifyJwtToken(wrongAudToken, DEFAULT_CONFIG);
  assert.equal(res.valid, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.error ?? "", /Invalid audience/i);
});

test("verifyJwtToken: rejects missing tenant_id or sub", () => {
  const noTenantToken = mintTestJwt({ tenantId: "" });
  const res1 = verifyJwtToken(noTenantToken, DEFAULT_CONFIG);
  assert.equal(res1.valid, false);
  assert.equal(res1.statusCode, 401);

  const noSubToken = mintTestJwt({ sub: "" });
  const res2 = verifyJwtToken(noSubToken, DEFAULT_CONFIG);
  assert.equal(res2.valid, false);
  assert.equal(res2.statusCode, 401);
});

test("verifyJwtToken: rejects unknown roles", () => {
  const invalidRoleToken = mintTestJwt({
    customClaims: { roles: ["superhero", "guest"] }
  });
  const res = verifyJwtToken(invalidRoleToken, DEFAULT_CONFIG);
  assert.equal(res.valid, false);
  assert.equal(res.statusCode, 401);
});

test("RBAC: admin role permissions", () => {
  const adminIdentity = {
    userId: "admin-1",
    tenantId: "t-1",
    roles: ["admin" as const]
  };

  assert.equal(hasPermission(adminIdentity, "project:create"), true);
  assert.equal(hasPermission(adminIdentity, "project:read"), true);
  assert.equal(hasPermission(adminIdentity, "scan:create"), true);
  assert.equal(hasPermission(adminIdentity, "scan:read"), true);
  assert.equal(hasPermission(adminIdentity, "finding:read"), true);
  assert.equal(hasPermission(adminIdentity, "audit:read"), true);
  assert.doesNotThrow(() => assertPermission(adminIdentity, "project:create"));
});

test("RBAC: operator role permissions", () => {
  const operatorIdentity = {
    userId: "op-1",
    tenantId: "t-1",
    roles: ["operator" as const]
  };

  assert.equal(hasPermission(operatorIdentity, "project:read"), true);
  assert.equal(hasPermission(operatorIdentity, "scan:create"), true);
  assert.equal(hasPermission(operatorIdentity, "scan:read"), true);
  assert.equal(hasPermission(operatorIdentity, "finding:read"), true);
  // Denied
  assert.equal(hasPermission(operatorIdentity, "project:create"), false);
  assert.equal(hasPermission(operatorIdentity, "project:delete"), false);
  assert.equal(hasPermission(operatorIdentity, "audit:read"), false);

  assert.throws(
    () => assertPermission(operatorIdentity, "project:create"),
    (err: unknown) => {
      return (err as { statusCode: number }).statusCode === 403;
    }
  );
});

test("RBAC: viewer role permissions", () => {
  const viewerIdentity = {
    userId: "vw-1",
    tenantId: "t-1",
    roles: ["viewer" as const]
  };

  assert.equal(hasPermission(viewerIdentity, "project:read"), true);
  assert.equal(hasPermission(viewerIdentity, "scan:read"), true);
  assert.equal(hasPermission(viewerIdentity, "finding:read"), true);
  // Denied
  assert.equal(hasPermission(viewerIdentity, "scan:create"), false);
  assert.equal(hasPermission(viewerIdentity, "project:create"), false);
  assert.throws(() => assertPermission(viewerIdentity, "scan:create"));
});

test("RBAC: deny-by-default for null/undefined/empty identity", () => {
  assert.equal(hasPermission(null, "project:read"), false);
  assert.equal(hasPermission(undefined, "project:read"), false);
  assert.equal(hasPermission({ userId: "1", tenantId: "t", roles: [] }, "project:read"), false);
});
