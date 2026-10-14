import crypto from "node:crypto";

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

export interface JwtVerifierConfig {
  expectedIssuer: string;
  expectedAudience: string;
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
  /**
   * Explicitly restrict which algorithms are accepted.
   *
   * Defaults to ["RS256"] only. Callers MUST explicitly list "HS256" to
   * accept symmetric tokens. Algorithm "none" is ALWAYS rejected regardless
   * of this list, preventing unsigned token acceptance.
   */
  allowedAlgorithms?: string[];
  /** Allowed clock skew in milliseconds (default: 30000ms / 30s) */
  clockSkewMs?: number;
}

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

export function verifyJwtToken(token: string, config: JwtVerifierConfig, now: Date = new Date()): JwtVerificationResult {
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

  // Algorithm validation: "none" is always rejected, then enforce allowlist.
  // Default to RS256-only; callers must explicitly opt in to HS256.
  if (!header.alg || header.alg === "none") {
    return { valid: false, error: "Unsupported or disallowed algorithm: none.", statusCode: 401 };
  }

  const allowedAlgs = config.allowedAlgorithms ?? ["RS256"];
  if (!allowedAlgs.includes(header.alg)) {
    return { valid: false, error: `Unsupported or disallowed algorithm: ${header.alg}.`, statusCode: 401 };
  }

  // Signature verification
  const signedData = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(signatureB64, "base64url");

  let signatureValid = false;
  try {
    if (header.alg === "RS256") {
      const verifier = crypto.createVerify("RSA-SHA256");
      verifier.update(signedData);
      signatureValid = verifier.verify(config.publicKeyOrSecret, signature);
    } else if (header.alg === "HS256") {
      // HS256 requires a string secret; reject non-string keys for symmetric verification.
      if (typeof config.publicKeyOrSecret !== "string" || config.publicKeyOrSecret.length === 0) {
        return { valid: false, error: "HS256 requires a non-empty string secret in publicKeyOrSecret.", statusCode: 401 };
      }
      const hmac = crypto.createHmac("sha256", config.publicKeyOrSecret);
      hmac.update(signedData);
      const expectedSignature = hmac.digest();
      // timingSafeEqual requires equal-length buffers; signature may be truncated by attacker.
      if (expectedSignature.length !== signature.length) {
        signatureValid = false;
      } else {
        signatureValid = crypto.timingSafeEqual(expectedSignature, signature);
      }
    }
    // Any other algorithm that passed allowedAlgs check but is not implemented
    // stays signatureValid=false and will be rejected below.
  } catch (err) {
    return { valid: false, error: `Cryptographic verification error: ${err instanceof Error ? err.message : String(err)}`, statusCode: 401 };
  }

  if (!signatureValid) {
    return { valid: false, error: "Invalid token signature.", statusCode: 401 };
  }

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
