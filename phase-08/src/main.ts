import { JwksKeyResolver } from "../../phase-06/src/auth/jwks-resolver.js";
import { EntraV2ClaimsAdapter, type JwtVerifierConfig } from "../../phase-06/src/auth/jwt-verifier.js";
import { createCloudPilotHostFromEnvironment, type CloudPilotApplicationHost, type HostEnvironment } from "./host.js";

export interface ProductionEnvironment extends HostEnvironment {
  OIDC_ISSUER?: string;
  OIDC_AUDIENCE?: string;
  OIDC_TENANT_ID?: string;
  OIDC_ALLOWED_CLIENT_IDS?: string;
  OIDC_JWKS_URI?: string;
}

export function createProductionJwtConfig(env: ProductionEnvironment): JwtVerifierConfig {
  const issuer = env.OIDC_ISSUER?.trim();
  const audience = env.OIDC_AUDIENCE?.trim();
  const tenantId = env.OIDC_TENANT_ID?.trim().toLowerCase();
  const allowedClientIds = env.OIDC_ALLOWED_CLIENT_IDS?.split(",").map((value) => value.trim().toLowerCase());
  if (!issuer || !audience || !tenantId || !allowedClientIds?.length || allowedClientIds.some((clientId) => !clientId)) {
    throw new Error("OIDC_ISSUER, OIDC_AUDIENCE, OIDC_TENANT_ID, and OIDC_ALLOWED_CLIENT_IDS are required.");
  }
  const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!guidPattern.test(tenantId)) throw new Error("OIDC_TENANT_ID must be a GUID.");
  if (!guidPattern.test(audience)) throw new Error("OIDC_AUDIENCE must be the Entra v2 API application ID GUID.");
  if (allowedClientIds.some((clientId) => !guidPattern.test(clientId))) {
    throw new Error("OIDC_ALLOWED_CLIENT_IDS must be a comma-separated list of client application ID GUIDs.");
  }
  let issuerUrl: URL;
  try { issuerUrl = new URL(issuer); } catch { throw new Error("OIDC_ISSUER must be a valid HTTPS URL."); }
  const expectedIssuerPath = `/${tenantId}/v2.0`;
  if (issuerUrl.protocol !== "https:" || issuerUrl.hostname !== "login.microsoftonline.com" ||
      issuerUrl.pathname !== expectedIssuerPath || issuerUrl.search || issuerUrl.hash || issuerUrl.username || issuerUrl.password) {
    throw new Error("OIDC_ISSUER must be the exact single-tenant Entra v2 issuer URL.");
  }
  if (env.OIDC_JWKS_URI) {
    let jwksUrl: URL;
    try { jwksUrl = new URL(env.OIDC_JWKS_URI); } catch { throw new Error("OIDC_JWKS_URI must be a valid HTTPS URL."); }
    if (jwksUrl.protocol !== "https:" || jwksUrl.username || jwksUrl.password) throw new Error("OIDC_JWKS_URI must be a valid HTTPS URL without embedded credentials.");
  }
  return {
    expectedIssuer: issuer,
    expectedAudience: audience,
    allowedAlgorithms: ["RS256", "ES256"],
    claimsAdapter: new EntraV2ClaimsAdapter({ expectedTenantId: tenantId, allowedClientIds }),
    keyResolver: new JwksKeyResolver({ expectedIssuer: issuer, ...(env.OIDC_JWKS_URI ? { jwksUri: env.OIDC_JWKS_URI } : {}) })
  };
}

export interface SignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
}

/** Installs one shared, idempotent shutdown path for SIGINT and SIGTERM. */
export function installGracefulShutdown(
  host: Pick<CloudPilotApplicationHost, "stop">,
  signals: SignalSource = process,
  onFailure: (error: unknown) => void = () => { process.exitCode = 1; }
): () => void {
  let stopping: Promise<void> | null = null;
  const shutdown = (): void => {
    if (!stopping) {
      stopping = host.stop().catch((error: unknown) => {
        onFailure(error);
      });
    }
    void stopping;
  };
  signals.once("SIGINT", shutdown);
  signals.once("SIGTERM", shutdown);
  return () => {
    signals.removeListener("SIGINT", shutdown);
    signals.removeListener("SIGTERM", shutdown);
  };
}

export async function main(env: ProductionEnvironment = process.env as ProductionEnvironment): Promise<void> {
  const host = createCloudPilotHostFromEnvironment(createProductionJwtConfig(env), env);
  installGracefulShutdown(host, process, () => {
    process.stderr.write("CloudPilot shutdown encountered an error.\n");
    process.exitCode = 1;
  });
  try {
    await host.start();
  } catch (error) {
    const diagnosticMessage = (message: string): string => message
      .replace(/\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi, "[redacted connection URL]")
      .replace(/\b(DATABASE_URL|MIGRATION_DATABASE_URL|GITHUB_APP_PRIVATE_KEY)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[redacted private key]");
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`CloudPilot startup failed: ${diagnosticMessage(message)}\n`);
    if (error instanceof Error && error.cause instanceof Error) {
      process.stderr.write(`CloudPilot startup cause: ${diagnosticMessage(error.cause.message)}\n`);
    }
    process.exitCode = 1;
    return;
  }
}

if (require.main === module) {
  void main().catch(() => {
    process.stderr.write("CloudPilot configuration is invalid or startup failed.\n");
    process.exitCode = 1;
  });
}
