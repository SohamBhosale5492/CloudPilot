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
    this.expectedIssuer = options.expectedIssuer;
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
    const usable = (entry: ResolvedKey | undefined): ResolvedKey | null => {
      if (!entry || entry.alg !== header.alg) return null;
      if (header.alg === "RS256") return entry.key.asymmetricKeyType === "rsa" ? entry : null;
      if (header.alg === "ES256") {
        return entry.key.asymmetricKeyType === "ec" &&
          entry.key.asymmetricKeyDetails?.namedCurve === "prime256v1" ? entry : null;
      }
      return null;
    };

    // Fast path: key is cached and cache is still fresh
    if (header.kid && this.keyCache.has(header.kid) && !isCacheExpired) {
      return usable(this.keyCache.get(header.kid));
    }

    // If cache is empty or expired, refresh unconditionally
    if (this.keyCache.size === 0 || isCacheExpired) {
      await this.refreshJwks();
      if (header.kid && this.keyCache.has(header.kid)) {
        return usable(this.keyCache.get(header.kid));
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
      return usable(this.keyCache.get(header.kid));
    }

    // Token without kid: if exactly one matching key exists in cache, return it
    if (!header.kid && this.keyCache.size === 1) {
      const singleKey = Array.from(this.keyCache.values())[0];
      return usable(singleKey);
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

    // 3. Fetch and consume JWKS under one timeout and a streaming byte limit.
    const { response: res, bodyText } = await this.fetchBoundedText(urlValidation.sanitizedUrl, "JWKS");

    if (!res.ok) {
      throw new Error(`JWKS endpoint returned HTTP ${res.status} ${res.statusText}`);
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
      const alg = jwk.alg === undefined
        ? isRsa ? "RS256" : isEcP256 ? "ES256" : ""
        : typeof jwk.alg === "string" ? jwk.alg : "";
      if (!((alg === "RS256" && isRsa) || (alg === "ES256" && isEcP256))) {
        continue;
      }

      try {
        const keyObject = crypto.createPublicKey({
          key: jwk,
          format: "jwk"
        });

        const keyEntry: ResolvedKey = {
          key: keyObject,
          alg,
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
    const discoveryUrl = `${this.expectedIssuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;

    const urlValidation = validateAndSanitizeUrl(discoveryUrl, {
      allowPrivateIps: this.allowPrivateIps
    });
    if (!urlValidation.valid || !urlValidation.sanitizedUrl) {
      throw new Error(`OIDC discovery URL rejected by policy: ${urlValidation.reason ?? "invalid URL"}`);
    }

    if (!this.allowHttp && !urlValidation.sanitizedUrl.startsWith("https://")) {
      throw new Error("OIDC discovery must use HTTPS in production.");
    }

    const { response: res, bodyText } = await this.fetchBoundedText(urlValidation.sanitizedUrl, "OIDC discovery");

    if (!res.ok) {
      throw new Error(`OIDC discovery endpoint returned HTTP ${res.status} ${res.statusText}`);
    }

    let config: OidcConfiguration;
    try {
      config = JSON.parse(bodyText);
    } catch {
      throw new Error("OIDC configuration is not valid JSON.");
    }

    // Verify discovered issuer matches expected issuer strictly
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("OIDC discovery response must be a JSON object.");
    }
    if (typeof config.issuer !== "string" || !config.issuer.trim()) {
      throw new Error("OIDC discovery response missing a non-empty 'issuer'.");
    }
    if (config.issuer !== this.expectedIssuer) {
      throw new Error("Discovered issuer does not match the configured issuer.");
    }

    if (!config.jwks_uri || typeof config.jwks_uri !== "string") {
      throw new Error("OIDC discovery response missing 'jwks_uri'.");
    }

    return config.jwks_uri;
  }

  private async fetchBoundedText(url: string, label: string): Promise<{ response: Response; bodyText: string }> {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        void reader?.cancel().catch(() => {});
        reject(new Error(`${label} request timed out.`));
      }, this.timeoutMs);
    });
    const request = (async () => {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
          redirect: "error"
        });
      } catch (err) {
        throw new Error(`Failed to fetch ${label} from ${url}: ${sanitizeErrorDetails(err)}`);
      }
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`${label} endpoint redirects are not allowed.`);
      }
      if (!response.body) return { response, bodyText: "" };

      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        totalBytes += value.byteLength;
        if (totalBytes > this.maxResponseBytes) {
          void reader.cancel().catch(() => {});
          throw new Error(`${label} response exceeded maximum size limit (${this.maxResponseBytes} bytes).`);
        }
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes);
      return { response, bodyText: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    })();

    try {
      return await Promise.race([request, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      try { reader?.releaseLock(); } catch { /* stream may already be cancelled */ }
    }
  }
}
