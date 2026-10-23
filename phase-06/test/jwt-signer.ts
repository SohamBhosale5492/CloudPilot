import crypto from "node:crypto";
import { UserRole } from "../src/auth/jwt-verifier.js";

// Test-only RSA keypair generated for local testing suites.
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: {
    type: "spki",
    format: "pem"
  },
  privateKeyEncoding: {
    type: "pkcs8",
    format: "pem"
  }
});

// Test-only EC P-256 keypair generated for local ES256 testing.
const { privateKey: ecPrivateKey, publicKey: ecPublicKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
  publicKeyEncoding: {
    type: "spki",
    format: "pem"
  },
  privateKeyEncoding: {
    type: "pkcs8",
    format: "pem"
  }
});

export const TEST_PUBLIC_KEY = publicKey;
export const TEST_PRIVATE_KEY = privateKey;
export const TEST_EC_PUBLIC_KEY = ecPublicKey;
export const TEST_EC_PRIVATE_KEY = ecPrivateKey;

export const TEST_ISSUER = "https://auth.cloudpilot.test";
export const TEST_AUDIENCE = "cloudpilot-api";
export const TEST_SECRET = "test-hmac-secret-at-least-32-bytes-long!";

export interface MintTokenOptions {
  sub?: string;
  tenantId?: string;
  roles?: UserRole[];
  email?: string;
  iss?: string;
  aud?: string | string[];
  expSecondsFromNow?: number;
  nbfSecondsFromNow?: number;
  iatSecondsFromNow?: number;
  algorithm?: "RS256" | "HS256" | "ES256";
  kid?: string;
  jku?: string;
  x5u?: string;
  signingKey?: string;
  customClaims?: Record<string, unknown>;
}

export function mintTestJwt(options: MintTokenOptions = {}): string {
  const alg = options.algorithm ?? "RS256";
  const now = Math.floor(Date.now() / 1000);

  const header: Record<string, unknown> = {
    alg,
    typ: "JWT"
  };
  if (options.kid !== undefined) {
    header.kid = options.kid;
  }
  if (options.jku !== undefined) {
    header.jku = options.jku;
  }
  if (options.x5u !== undefined) {
    header.x5u = options.x5u;
  }

  const exp = options.expSecondsFromNow !== undefined
    ? now + options.expSecondsFromNow
    : now + 3600; // 1 hour default

  const nbf = options.nbfSecondsFromNow !== undefined
    ? now + options.nbfSecondsFromNow
    : now - 10;

  const payload: Record<string, unknown> = {
    iss: options.iss ?? TEST_ISSUER,
    aud: options.aud ?? TEST_AUDIENCE,
    sub: options.sub ?? "user-test-01",
    tenant_id: options.tenantId ?? "tenant-alpha",
    roles: options.roles ?? ["admin"],
    email: options.email ?? "test@cloudpilot.test",
    iat: options.iatSecondsFromNow !== undefined ? now + options.iatSecondsFromNow : now,
    nbf,
    exp,
    ...(options.customClaims ?? {})
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signedData = `${headerB64}.${payloadB64}`;

  let signature: Buffer;
  if (alg === "RS256") {
    const key = options.signingKey ?? TEST_PRIVATE_KEY;
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(signedData);
    signature = signer.sign(key);
  } else if (alg === "ES256") {
    const key = options.signingKey ?? TEST_EC_PRIVATE_KEY;
    const signer = crypto.createSign("SHA256");
    signer.update(signedData);
    signature = signer.sign({ key, dsaEncoding: "ieee-p1363" });
  } else if (alg === "HS256") {
    const key = options.signingKey ?? TEST_SECRET;
    const hmac = crypto.createHmac("sha256", key);
    hmac.update(signedData);
    signature = hmac.digest();
  } else {
    throw new Error(`Unsupported test signing algorithm: ${alg}`);
  }

  return `${signedData}.${signature.toString("base64url")}`;
}
