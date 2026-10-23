import crypto from "node:crypto";
import { validateAndSanitizeUrl } from "../../../phase-01/demo-service/src/inspectors.js";
import { sanitizeErrorDetails } from "../api/validation.js";

export interface JwksKeyResolverOptions {
  expectedIssuer: string;
  jwksUri?: string;
  allowHttp?: boolean;
  allowPrivateIps?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  ttlMs?: number;
  minRefreshIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ResolvedKey {
  key: crypto.KeyObject;
  alg?: string;
  kid?: string;
}

export interface JwkKey {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
  [key: string]: unknown;
}

export interface JwksResponse {
  keys?: JwkKey[];
}

export interface OidcConfiguration {
  issuer?: string;
  jwks_uri?: string;
  [key: string]: unknown;
}

export class JwksKeyResolver {
  readonly expectedIssuer: string;
  private jwksUri: string | null = null;
  private readonly allowHttp: boolean;
  private readonly allowPrivateIps: boolean;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly ttlMs: number;
  private readonly minRefreshIntervalMs: number;
  private readonly fetchImpl: typeof fetch;

  private keyCache: Map<string, ResolvedKey> = new Map();
  private lastFetchedAt = 0;
  private inFlightRefresh: Promise<void> | null = null;

  constructor(options: JwksKeyResolverOptions) {
    if (!options.expectedIssuer || typeof options.expectedIssuer !== "string") {
      throw new Error("expectedIssuer is required for JwksKeyResolver.");
    }
    this.expectedIssuer = options.expectedIssuer.replace(/\/+$/, "");
    this.jwksUri = options.jwksUri ?? null;
    this.allowHttp = options.allowHttp ?? false;
    this.allowPrivateIps = options.allowPrivateIps ?? false;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxResponseBytes = options.maxResponseBytes ?? 64 * 1024; // 64KB max
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000; // 10 minutes
    this.minRefreshIntervalMs = options.minRefreshIntervalMs ?? 60 * 1000; // 60 seconds throttle
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  get cachedKeyCount(): number {
    return this.keyCache.size;
  }

  get lastFetchTimestamp(): number {
    return this.lastFetchedAt;
  }

  /**
   * Resolves a public key given the JWT header parameters.
   */
  async resolveKey(header: { alg: string; kid?: string }): Promise<ResolvedKey | null> {
    const isCacheExpired = Date.now() - this.lastFetchedAt > this.ttlMs;

    // Fast path: key is cached and cache is still fresh
    if (header.kid && this.keyCache.has(header.kid) && !isCacheExpired) {
      return this.keyCache.get(header.kid)!;
    }

    // If cache is empty or expired, refresh unconditionally
    if (this.keyCache.size === 0 || isCacheExpired) {
      await this.refreshJwks();
      if (header.kid && this.keyCache.has(header.kid)) {
        return this.keyCache.get(header.kid)!;
      }
    }

    // Unknown kid with warm unexpired cache: throttle outbound fetches to prevent abuse
    if (header.kid && !this.keyCache.has(header.kid)) {
      const timeSinceLastFetch = Date.now() - this.lastFetchedAt;
      if (timeSinceLastFetch < this.minRefreshIntervalMs) {
        // Throttled: do not perform outbound HTTP fetch
        return null;
      }

      await this.refreshJwks();
      if (this.keyCache.has(header.kid)) {
        return this.keyCache.get(header.kid)!;
      }
      return null;
    }

    // Token without kid: if exactly one matching key exists in cache, return it
    if (!header.kid && this.keyCache.size === 1) {
      const singleKey = Array.from(this.keyCache.values())[0];
      if (!singleKey.alg || singleKey.alg === header.alg) {
        return singleKey;
      }
    }

    return null;
  }

  /**
   * Discovers OIDC metadata and fetches the JWKS keys.
   * Concurrency-safe: concurrent calls share the in-flight Promise.
   */
  async refreshJwks(): Promise<void> {
    if (this.inFlightRefresh) {
      return this.inFlightRefresh;
    }

    this.inFlightRefresh = this.doRefreshJwks().finally(() => {
      this.inFlightRefresh = null;
    });

    return this.inFlightRefresh;
  }

  private async doRefreshJwks(): Promise<void> {
    // 1. Discover JWKS URI if not already configured
    let jwksUrl = this.jwksUri;
    if (!jwksUrl) {
      jwksUrl = await this.discoverJwksUri();
      this.jwksUri = jwksUrl;
    }

    // 2. Validate JWKS URI against SSRF policy
    const urlValidation = validateAndSanitizeUrl(jwksUrl, {
      allowPrivateIps: this.allowPrivateIps
    });
    if (!urlValidation.valid || !urlValidation.sanitizedUrl) {
      throw new Error(`JWKS URI rejected by policy: ${urlValidation.reason ?? "invalid URL"}`);
    }

    if (!this.allowHttp && !urlValidation.sanitizedUrl.startsWith("https://")) {
      throw new Error("JWKS URI must use HTTPS in production.");
    }

    // 3. Fetch JWKS payload with bounded timeout and size
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(urlValidation.sanitizedUrl, {
        signal: controller.signal,
        headers: { Accept: "application/json" }
      });
    } catch (err) {
      throw new Error(`Failed to fetch JWKS from ${urlValidation.sanitizedUrl}: ${sanitizeErrorDetails(err)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`JWKS endpoint returned HTTP ${res.status} ${res.statusText}`);
    }

    const bodyText = await res.text();
    if (bodyText.length > this.maxResponseBytes) {
      throw new Error(`JWKS response exceeded maximum size limit (${this.maxResponseBytes} bytes).`);
    }

    let jwksData: JwksResponse;
    try {
      jwksData = JSON.parse(bodyText);
    } catch {
      throw new Error("JWKS response is not valid JSON.");
    }

    if (!jwksData || !Array.isArray(jwksData.keys)) {
      throw new Error("JWKS response missing 'keys' array.");
    }

    // 4. Parse and import keys
    const newCache = new Map<string, ResolvedKey>();
    for (const jwk of jwksData.keys) {
      if (!jwk || typeof jwk !== "object") continue;

      // Reject non-signature keys if 'use' claim is present
      if (jwk.use !== undefined && jwk.use !== "sig") {
        continue;
      }

      // We support RSA (RS256) and EC (ES256 on P-256 curve)
      const isRsa = jwk.kty === "RSA";
      const isEcP256 = jwk.kty === "EC" && (jwk.crv === "P-256" || jwk.crv === "secp256r1");

      if (!isRsa && !isEcP256) {
        continue;
      }

      try {
        const keyObject = crypto.createPublicKey({
          key: jwk,
          format: "jwk"
        });

        const keyEntry: ResolvedKey = {
          key: keyObject,
          alg: typeof jwk.alg === "string" ? jwk.alg : isRsa ? "RS256" : "ES256",
          kid: typeof jwk.kid === "string" ? jwk.kid : undefined
        };

        if (keyEntry.kid) {
          newCache.set(keyEntry.kid, keyEntry);
        } else {
          // If no kid, index by fallback synthetic key
          newCache.set(`nokid_${keyEntry.alg}`, keyEntry);
        }
      } catch {
        // Skip malformed individual keys without failing entire key set
      }
    }

    this.keyCache = newCache;
    this.lastFetchedAt = Date.now();
  }

  private async discoverJwksUri(): Promise<string> {
    const discoveryUrl = `${this.expectedIssuer}/.well-known/openid-configuration`;

    const urlValidation = validateAndSanitizeUrl(discoveryUrl, {
      allowPrivateIps: this.allowPrivateIps
    });
    if (!urlValidation.valid || !urlValidation.sanitizedUrl) {
      throw new Error(`OIDC discovery URL rejected by policy: ${urlValidation.reason ?? "invalid URL"}`);
    }

    if (!this.allowHttp && !urlValidation.sanitizedUrl.startsWith("https://")) {
      throw new Error("OIDC discovery must use HTTPS in production.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(urlValidation.sanitizedUrl, {
        signal: controller.signal,
        headers: { Accept: "application/json" }
      });
    } catch (err) {
      throw new Error(`Failed to fetch OIDC configuration from ${discoveryUrl}: ${sanitizeErrorDetails(err)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`OIDC discovery endpoint returned HTTP ${res.status} ${res.statusText}`);
    }

    const bodyText = await res.text();
    if (bodyText.length > this.maxResponseBytes) {
      throw new Error(`OIDC discovery response exceeded maximum size limit (${this.maxResponseBytes} bytes).`);
    }

    let config: OidcConfiguration;
    try {
      config = JSON.parse(bodyText);
    } catch {
      throw new Error("OIDC configuration is not valid JSON.");
    }

    // Verify discovered issuer matches expected issuer strictly
    if (config.issuer && config.issuer.replace(/\/+$/, "") !== this.expectedIssuer) {
      throw new Error(`Discovered issuer '${config.issuer}' does not match expected issuer '${this.expectedIssuer}'.`);
    }

    if (!config.jwks_uri || typeof config.jwks_uri !== "string") {
      throw new Error("OIDC discovery response missing 'jwks_uri'.");
    }

    return config.jwks_uri;
  }
}
