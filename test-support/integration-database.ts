/**
 * Fail-closed target validation for the explicitly authorized local integration
 * database. This module validates only URL structure; it never connects.
 */
export const INTEGRATION_TEST_DATABASE = "cloudpilot_runtime_role_test";
export const INTEGRATION_TEST_HOST = "127.0.0.1";
export const INTEGRATION_TEST_PORT = "56440";
export const INTEGRATION_FIXTURE_TEST_ROLE = "cloudpilot_integration_test";

export function requireIntegrationDatabaseUrl(
  value: string | undefined,
  variableName: string,
  expectedRole: "cloudpilot_runtime" | "cloudpilot_migrator" | typeof INTEGRATION_FIXTURE_TEST_ROLE
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${variableName} is required; refusing database access.`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL URL; refusing database access.`);
  }

  let database: string;
  let username: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    username = decodeURIComponent(url.username);
  } catch {
    throw new Error(`${variableName} has malformed encoded identity fields; refusing database access.`);
  }

  const hasConnectionOverride = [...url.searchParams.keys()].some((key) =>
    ["host", "hostaddr", "port", "dbname", "database", "user", "username"].includes(key.toLowerCase())
  );
  if (!(url.protocol === "postgres:" || url.protocol === "postgresql:") ||
      url.hostname !== INTEGRATION_TEST_HOST ||
      url.port !== INTEGRATION_TEST_PORT ||
      database !== INTEGRATION_TEST_DATABASE ||
      username !== expectedRole ||
      url.password.length === 0 ||
      url.hash.length !== 0 ||
      hasConnectionOverride) {
    throw new Error(
      `${variableName} must target ${expectedRole}@${INTEGRATION_TEST_HOST}:${INTEGRATION_TEST_PORT}/${INTEGRATION_TEST_DATABASE}; URL values are suppressed.`
    );
  }

  return value;
}

/** Phase 06/07 fixtures require CRUD privileges unavailable to the runtime role. */
export function requireIntegrationFixtureDatabaseUrl(value: string | undefined): string {
  return requireIntegrationDatabaseUrl(value, "CLOUDPILOT_FIXTURE_TEST_DATABASE_URL", INTEGRATION_FIXTURE_TEST_ROLE);
}
