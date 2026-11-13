import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EntraV2ClaimsAdapter, verifyJwtToken, type JwtVerificationResult, type JwtVerifierConfig } from "../../src/auth/jwt-verifier.js";
import { TEST_PRIVATE_KEY, TEST_PUBLIC_KEY } from "../jwt-signer.js";

const TENANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const API_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLIENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_CLIENT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;

const CONFIG: JwtVerifierConfig = {
  expectedIssuer: ISSUER,
  expectedAudience: API_ID,
  allowedAlgorithms: ["RS256"],
  publicKeyOrSecret: TEST_PUBLIC_KEY,
  claimsAdapter: new EntraV2ClaimsAdapter({ expectedTenantId: TENANT_ID, allowedClientIds: [CLIENT_ID] })
};

function mintEntraToken(overrides: Record<string, unknown> = {}, typ = "JWT"): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: ISSUER,
    aud: API_ID,
    exp: now + 3600,
    nbf: now - 10,
    iat: now,
    ver: "2.0",
    tid: TENANT_ID,
    sub: "subject-123",
    azp: CLIENT_ID,
    idtyp: "user",
    roles: ["operator"],
    ...overrides
  })).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  return `${signingInput}.${signer.sign(TEST_PRIVATE_KEY).toString("base64url")}`;
}

test("Entra v2 adapter maps tid and subject to provider-neutral tenantId and userId", () => {
  const result = verifyJwtToken(mintEntraToken(), CONFIG);
  assert.equal(result.valid, true);
  assert.deepEqual(result.securityContext?.identity, {
    userId: "subject-123",
    tenantId: TENANT_ID,
    roles: ["operator"],
    email: undefined
  });
});

test("Entra v2 adapter rejects wrong tenant, issuer, or audience", () => {
  for (const overrides of [
    { tid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
    { iss: "https://login.microsoftonline.com/ffffffff-ffff-4fff-8fff-ffffffffffff/v2.0" },
    { aud: "ffffffff-ffff-4fff-8fff-ffffffffffff" }
  ]) {
    const result: JwtVerificationResult = verifyJwtToken(mintEntraToken(overrides), CONFIG);
    assert.equal(result.valid, false);
  }
});

test("Entra v2 adapter rejects unsupported versions and JWT header token types", () => {
  assert.match(verifyJwtToken(mintEntraToken({ ver: "1.0" }), CONFIG).error ?? "", /version/i);
  assert.match(verifyJwtToken(mintEntraToken({ ver: undefined }), CONFIG).error ?? "", /version/i);
  assert.match(verifyJwtToken(mintEntraToken({}, "at+jwt"), CONFIG).error ?? "", /header token type/i);
});

test("Entra v2 adapter requires a valid allowlisted azp", () => {
  for (const overrides of [
    { azp: undefined },
    { azp: "not-a-guid" },
    { azp: OTHER_CLIENT_ID }
  ]) {
    assert.equal(verifyJwtToken(mintEntraToken(overrides), CONFIG).valid, false);
  }
});

test("Entra v2 adapter rejects app-only and missing token-type claims", () => {
  assert.match(verifyJwtToken(mintEntraToken({ idtyp: "app" }), CONFIG).error ?? "", /user access token/i);
  assert.match(verifyJwtToken(mintEntraToken({ idtyp: undefined }), CONFIG).error ?? "", /user access token/i);
});

test("Entra v2 adapter accepts only non-empty arrays of CloudPilot roles", () => {
  for (const roles of [undefined, [], "admin", ["superuser"], ["viewer", "superuser"], [null]]) {
    assert.equal(verifyJwtToken(mintEntraToken({ roles }), CONFIG).valid, false);
  }
  const result = verifyJwtToken(mintEntraToken({ roles: ["admin", "viewer"] }), CONFIG);
  assert.equal(result.valid, true);
  assert.deepEqual(result.securityContext?.identity.roles, ["admin", "viewer"]);
});

test("Entra v2 adapter rejects malformed tenant IDs and empty subjects", () => {
  assert.equal(verifyJwtToken(mintEntraToken({ tid: "tenant-1" }), CONFIG).valid, false);
  assert.equal(verifyJwtToken(mintEntraToken({ sub: "  " }), CONFIG).valid, false);
});
