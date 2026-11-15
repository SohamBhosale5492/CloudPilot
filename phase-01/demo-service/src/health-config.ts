import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const SAFE_ENDPOINT_RE = /^\/[a-zA-Z0-9._\-\/]*$/;

export interface ConfiguredHealthCheck {
  readonly service: string;
  readonly endpoint: string;
}

/**
 * Validates a health check endpoint path (must start with '/', no '..' or '//').
 */
export function isValidHealthEndpoint(endpoint: unknown): endpoint is string {
  return (
    typeof endpoint === "string" &&
    endpoint.length > 0 &&
    endpoint.length <= 128 &&
    SAFE_ENDPOINT_RE.test(endpoint) &&
    !endpoint.includes("..") &&
    !endpoint.includes("//")
  );
}

/**
 * Parses and validates health-checks YAML configuration string.
 * Entries without an explicit endpoint default to "/health".
 */
export function parseHealthChecksConfig(yamlText: string): ConfiguredHealthCheck[] {
  if (!yamlText || !yamlText.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText);
  } catch (err) {
    console.warn("Failed to parse health-checks configuration YAML:", err);
    return [];
  }

  if (!parsed || typeof parsed !== "object") {
    return [];
  }

  const rawChecks = (parsed as { health_checks?: unknown }).health_checks;
  if (!Array.isArray(rawChecks)) {
    return [];
  }

  const results: ConfiguredHealthCheck[] = [];
  for (const item of rawChecks) {
    if (!item || typeof item !== "object") continue;
    const { service, endpoint } = item as { service?: unknown; endpoint?: unknown };

    if (typeof service !== "string" || !service.trim() || service.length > 128) {
      continue;
    }

    const resolvedEndpoint = endpoint === undefined ? "/health" : endpoint;
    if (!isValidHealthEndpoint(resolvedEndpoint)) {
      console.warn(`Skipping invalid health check endpoint: ${String(resolvedEndpoint)}`);
      continue;
    }

    results.push({
      service: service.trim(),
      endpoint: resolvedEndpoint
    });
  }

  return results;
}

/**
 * Resolves the health-checks configuration file path from environment or well-known locations.
 */
export function resolveHealthConfigPath(explicitPath?: string): string | null {
  if (explicitPath !== undefined) {
    return fs.existsSync(explicitPath) ? explicitPath : null;
  }

  const envPath = process.env.HEALTH_CONFIG_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const candidates = [
    path.resolve(process.cwd(), "config/observability/health-checks.yaml"),
    path.resolve(__dirname, "../../config/observability/health-checks.yaml"),
    path.resolve(__dirname, "../../../config/observability/health-checks.yaml"),
    path.resolve(process.cwd(), "../../config/observability/health-checks.yaml")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Loads configured health checks from YAML file.
 */
export function loadHealthChecksConfig(filePath?: string): ConfiguredHealthCheck[] {
  const resolved = resolveHealthConfigPath(filePath);
  if (!resolved) {
    return [];
  }

  try {
    const content = fs.readFileSync(resolved, "utf8");
    return parseHealthChecksConfig(content);
  } catch (error) {
    console.warn("Failed to load health-checks config:", error);
    return [];
  }
}

/**
 * Finds a configured health check matching the requested URL pathname.
 */
export function findMatchingHealthCheck(
  checks: ReadonlyArray<ConfiguredHealthCheck>,
  pathname: string
): ConfiguredHealthCheck | null {
  for (const check of checks) {
    if (check.endpoint === pathname) {
      return check;
    }
  }
  return null;
}
