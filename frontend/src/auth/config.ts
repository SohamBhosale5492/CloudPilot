import type { Configuration } from "@azure/msal-browser";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FrontendConfig {
  tenantId: string;
  clientId: string;
  apiClientId: string;
  apiScope: string;
  apiBaseUrl: string;
  redirectUri: string;
}

export type ConfigResult = { config: FrontendConfig; errors: [] } | { config: null; errors: string[] };

export function readFrontendConfig(env: ImportMetaEnv, origin: string): ConfigResult {
  const tenantId = env.VITE_ENTRA_TENANT_ID?.trim();
  const clientId = env.VITE_ENTRA_CLIENT_ID?.trim();
  const apiClientId = env.VITE_ENTRA_API_CLIENT_ID?.trim();
  const apiScope = env.VITE_ENTRA_API_SCOPE?.trim();
  const apiBaseUrl = env.VITE_API_BASE_URL?.trim() || "/";
  const errors: string[] = [];

  if (!tenantId || !GUID.test(tenantId)) errors.push("VITE_ENTRA_TENANT_ID must be a tenant GUID.");
  if (!clientId || !GUID.test(clientId)) errors.push("VITE_ENTRA_CLIENT_ID must be a client application GUID.");
  if (!apiClientId || !GUID.test(apiClientId)) errors.push("VITE_ENTRA_API_CLIENT_ID must be the CloudPilot API application GUID.");
  if (!apiScope) errors.push("VITE_ENTRA_API_SCOPE must contain the delegated CloudPilot API scope.");
  if (!isSafeApiBaseUrl(apiBaseUrl, origin)) errors.push("VITE_API_BASE_URL must be a same-origin path, HTTPS URL, or loopback HTTP URL.");
  if (errors.length || !tenantId || !clientId || !apiClientId || !apiScope) return { config: null, errors };

  return {
    config: {
      tenantId: tenantId.toLowerCase(),
      clientId: clientId.toLowerCase(),
      apiClientId: apiClientId.toLowerCase(),
      apiScope,
      apiBaseUrl,
      redirectUri: origin
    },
    errors: []
  };
}

function isSafeApiBaseUrl(value: string, origin: string): boolean {
  if (value.startsWith("/") && !value.startsWith("//")) {
    try { return new URL(value, origin).origin === new URL(origin).origin; }
    catch { return false; }
  }
  try {
    const url = new URL(value, origin);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function createMsalConfiguration(config: FrontendConfig): Configuration {
  return {
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      redirectUri: config.redirectUri,
      postLogoutRedirectUri: config.redirectUri
    },
    system: {
      loggerOptions: {
        piiLoggingEnabled: false,
        loggerCallback: () => undefined
      }
    }
  };
}

export const isGuid = (value: string): boolean => GUID.test(value);
