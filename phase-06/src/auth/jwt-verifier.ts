import crypto from "node:crypto";
import { JwksKeyResolver } from "./jwks-resolver.js";

export type UserRole = "admin" | "operator" | "viewer";

export interface AuthenticatedIdentity {
  userId: string;
  tenantId: string;
  roles: UserRole[];
  email?: string;
}

export interface SecurityContext {
  identity: AuthenticatedIdentity;
}

export interface BaseJwtVerifierConfig {
  expectedIssuer: string;
  expectedAudience: string;
  allowedAlgorithms?: string[];
  /** Allowed clock skew in milliseconds (default: 30000ms / 30s) */
  clockSkewMs?: number;
}

export interface StaticJwtVerifierConfig extends BaseJwtVerifierConfig {
  /**
   * Public key (PEM string or KeyObject) for RS256, or HMAC secret string for HS256.
   *
   * The primary OIDC trust model is asymmetric (RS256 with a public key).
   * HS256 is supported only for local testing and must be explicitly opted into
   * by setting allowedAlgorithms to include "HS256". Do not enable HS256 in
   * production; OIDC providers issue RS256 (or ES256) tokens signed with
   * private keys that are never shared with resource servers.
   */
  publicKeyOrSecret: string | crypto.KeyObject;
}

export interface JwksJwtVerifierConfig extends BaseJwtVerifierConfig {
  /**
   * JWKS key resolver that discovers and fetches public keys from the trusted OIDC provider.
   */
  keyResolver: JwksKeyResolver;
}

export type JwtVerifierConfig = StaticJwtVerifierConfig | JwksJwtVerifierConfig;

export interface JwtVerificationResult {
  valid: boolean;
  securityContext?: SecurityContext;
  error?: string;
  statusCode?: number;
}

interface JwtHeader {
  alg: string;
  typ?: string;
  kid?: string;
  jku?: string;
  x5u?: string;
}

interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  tenant_id?: string;
  roles?: string[];
  email?: string;
  [key: string]: unknown;
}

function verifyPayloadClaims(
  payload: JwtPayload,
  config: BaseJwtVerifierConfig,
  now: Date
): JwtVerificationResult {
  // Issuer validation
  if (payload.iss !== config.expectedIssuer) {
    return { valid: false, error: `Invalid issuer: expected ${config.expectedIssuer}, got ${payload.iss}.`, statusCode: 401 };
  }

  // Audience validation
  const aud = payload.aud;
  const audienceMatches = Array.isArray(aud)
    ? aud.includes(config.expectedAudience)
    : aud === config.expectedAudience;

  if (!audienceMatches) {
    return { valid: false, error: `Invalid audience: expected ${config.expectedAudience}, got ${JSON.stringify(aud)}.`, statusCode: 401 };
  }

  const nowEpochSeconds = Math.floor(now.getTime() / 1000);
  const skewSeconds = Math.floor((config.clockSkewMs ?? 30000) / 1000);

  // Expiration check
  if (typeof payload.exp !== "number") {
    return { valid: false, error: "Missing 'exp' (expiration) claim.", statusCode: 401 };
  }
  if (nowEpochSeconds - skewSeconds >= payload.exp) {
    return { valid: false, error: "Token has expired.", statusCode: 401 };
  }

  // Not before check
  if (typeof payload.nbf === "number" && nowEpochSeconds + skewSeconds < payload.nbf) {
    return { valid: false, error: "Token not active yet (nbf).", statusCode: 401 };
  }

  // Required CloudPilot Identity Claims
  if (typeof payload.sub !== "string" || payload.sub.trim().length === 0) {
    return { valid: false, error: "Missing or invalid 'sub' claim.", statusCode: 401 };
  }

  if (typeof payload.tenant_id !== "string" || payload.tenant_id.trim().length === 0) {
    return { valid: false, error: "Missing or invalid 'tenant_id' claim.", statusCode: 401 };
  }

  if (!Array.isArray(payload.roles) || payload.roles.length === 0) {
    return { valid: false, error: "Missing or empty 'roles' claim.", statusCode: 401 };
  }

  const validRoles: UserRole[] = [];
  for (const r of payload.roles) {
    if (r === "admin" || r === "operator" || r === "viewer") {
      validRoles.push(r);
    }
  }

  if (validRoles.length === 0) {
    return { valid: false, error: "Token has no valid roles (expected admin, operator, or viewer).", statusCode: 401 };
  }

  return {
    valid: true,
    securityContext: {
      identity: {
        userId: payload.sub,
        tenantId: payload.tenant_id,
        roles: validRoles,
        email: typeof payload.email === "string" ? payload.email : undefined
      }
    }
  };
}

function verifySignature(
  alg: string,
  key: string | crypto.KeyObject,
  signedData: string,
  signature: Buffer
): boolean {
  if (alg === "RS256") {
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(signedData);
    return verifier.verify(key, signature);
  }

  if (alg === "ES256") {
    const verifier = crypto.createVerify("SHA256");
    verifier.update(signedData);
    if (typeof key === "string") {
      return verifier.verify({ key, dsaEncoding: "ieee-p1363" }, signature);
    }
    return verifier.verify({ key, dsaEncoding: "ieee-p1363" }, signature);
  }

  if (alg === "HS256") {
    if (typeof key !== "string" || key.length === 0) {
      return false;
    }
    const hmac = crypto.createHmac("sha256", key);
    hmac.update(signedData);
    const expectedSignature = hmac.digest();
    if (expectedSignature.length !== signature.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedSignature, signature);
  }

  return false;
}

export function verifyJwtTokenSync(
  token: string,
  config: StaticJwtVerifierConfig,
  now: Date = new Date()
): JwtVerificationResult {
  if (typeof token !== "string" || token.trim().length === 0) {
    return { valid: false, error: "Missing or empty token.", statusCode: 401 };
  }

  const parts = token.trim().split(".");
  if (parts.length !== 3) {
    return { valid: false, error: "Malformed JWT token structure.", statusCode: 401 };
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  let header: JwtHeader;
  let payload: JwtPayload;

  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { valid: false, error: "Failed to parse JWT header or payload.", statusCode: 401 };
  }

  // Never trust token-supplied key URLs
  if (header.jku || header.x5u) {
    return { valid: false, error: "Token header contains forbidden URL claim (jku/x5u).", statusCode: 401 };
  }

  if (!header.alg || header.alg === "none") {
    return { valid: false, error: "Unsupported or disallowed algorithm: none.", statusCode: 401 };
  }

  const allowedAlgs = config.allowedAlgorithms ?? ["RS256"];
  if (!allowedAlgs.includes(header.alg)) {
    return { valid: false, error: `Unsupported or disallowed algorithm: ${header.alg}.`, statusCode: 401 };
  }

  if (header.alg === "HS256" && (typeof config.publicKeyOrSecret !== "string" || config.publicKeyOrSecret.length === 0)) {
    return { valid: false, error: "HS256 requires a non-empty string secret in publicKeyOrSecret.", statusCode: 401 };
  }

  const signedData = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(signatureB64, "base64url");

  let signatureValid = false;
  try {
    signatureValid = verifySignature(header.alg, config.publicKeyOrSecret, signedData, signature);
  } catch (err) {
    return { valid: false, error: `Cryptographic verification error: ${err instanceof Error ? err.message : String(err)}`, statusCode: 401 };
  }

  if (!signatureValid) {
    return { valid: false, error: "Invalid token signature.", statusCode: 401 };
  }

  return verifyPayloadClaims(payload, config, now);
}

export async function verifyJwtTokenAsync(
  token: string,
  config: JwksJwtVerifierConfig,
  now: Date = new Date()
): Promise<JwtVerificationResult> {
  if (typeof token !== "string" || token.trim().length === 0) {
    return { valid: false, error: "Missing or empty token.", statusCode: 401 };
  }

  const parts = token.trim().split(".");
  if (parts.length !== 3) {
    return { valid: false, error: "Malformed JWT token structure.", statusCode: 401 };
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  let header: JwtHeader;
  let payload: JwtPayload;

  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { valid: false, error: "Failed to parse JWT header or payload.", statusCode: 401 };
  }

  // Never trust token-supplied key URLs
  if (header.jku || header.x5u) {
    return { valid: false, error: "Token header contains forbidden URL claim (jku/x5u).", statusCode: 401 };
  }

  if (!header.alg || header.alg === "none") {
    return { valid: false, error: "Unsupported or disallowed algorithm: none.", statusCode: 401 };
  }

  // Reject symmetric algorithms in JWKS mode unconditionally
  if (header.alg === "HS256") {
    return { valid: false, error: "Symmetric algorithm HS256 is not permitted in JWKS mode.", statusCode: 401 };
  }

  const allowedAlgs = config.allowedAlgorithms ?? ["RS256", "ES256"];
  if (!allowedAlgs.includes(header.alg)) {
    return { valid: false, error: `Unsupported or disallowed algorithm: ${header.alg}.`, statusCode: 401 };
  }

  let resolvedKey: { key: crypto.KeyObject; alg?: string } | null;
  try {
    resolvedKey = await config.keyResolver.resolveKey({
      alg: header.alg,
      kid: header.kid
    });
  } catch (err) {
    return { valid: false, error: `Key resolution error: ${err instanceof Error ? err.message : String(err)}`, statusCode: 401 };
  }

  if (!resolvedKey) {
    return { valid: false, error: "Signing key not found in JWKS or key lookup was throttled.", statusCode: 401 };
  }

  const signedData = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(signatureB64, "base64url");

  let signatureValid = false;
  try {
    signatureValid = verifySignature(header.alg, resolvedKey.key, signedData, signature);
  } catch (err) {
    return { valid: false, error: `Cryptographic verification error: ${err instanceof Error ? err.message : String(err)}`, statusCode: 401 };
  }

  if (!signatureValid) {
    return { valid: false, error: "Invalid token signature.", statusCode: 401 };
  }

  return verifyPayloadClaims(payload, config, now);
}

// Overload signatures for backward-compatible ergonomic consumption
export function verifyJwtToken(token: string, config: StaticJwtVerifierConfig, now?: Date): JwtVerificationResult;
export function verifyJwtToken(token: string, config: JwksJwtVerifierConfig, now?: Date): Promise<JwtVerificationResult>;
export function verifyJwtToken(token: string, config: JwtVerifierConfig, now?: Date): JwtVerificationResult | Promise<JwtVerificationResult>;
export function verifyJwtToken(
  token: string,
  config: JwtVerifierConfig,
  now: Date = new Date()
): JwtVerificationResult | Promise<JwtVerificationResult> {
  if ("keyResolver" in config && config.keyResolver) {
    return verifyJwtTokenAsync(token, config, now);
  }
  return verifyJwtTokenSync(token, config as StaticJwtVerifierConfig, now);
}
