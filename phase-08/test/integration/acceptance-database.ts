export const PHASE08_ACCEPTANCE_DATABASE_ENV = "CLOUDPILOT_PHASE08_ACCEPTANCE_TEST_DATABASE_URL";

export type Phase08AcceptanceDatabase = {
  url: string;
  database: "cloudpilot_acceptance_56441";
  username: "cloudpilot_acceptance_app";
  host: "127.0.0.1";
  port: "56441";
};

/** Strict opt-in target for the single authorized isolated Phase 08 acceptance database. */
export function parsePhase08AcceptanceDatabase(value: string | undefined): Phase08AcceptanceDatabase | undefined {
  if (value === undefined) return undefined;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${PHASE08_ACCEPTANCE_DATABASE_ENV} is malformed; refusing database access.`);
  }

  const forbiddenOverrides = ["host", "hostaddr", "port", "dbname", "database", "user", "username"];
  if (!(url.protocol === "postgres:" || url.protocol === "postgresql:") ||
      url.hostname !== "127.0.0.1" || url.port !== "56441" ||
      decodeURIComponent(url.pathname.replace(/^\//, "")) !== "cloudpilot_acceptance_56441" ||
      decodeURIComponent(url.username) !== "cloudpilot_acceptance_app" || !url.password || url.hash ||
      [...url.searchParams.keys()].some((key) => forbiddenOverrides.includes(key.toLowerCase()))) {
    throw new Error(`${PHASE08_ACCEPTANCE_DATABASE_ENV} must target 127.0.0.1:56441/cloudpilot_acceptance_56441 as cloudpilot_acceptance_app.`);
  }

  return {
    url: url.toString(),
    database: "cloudpilot_acceptance_56441",
    username: "cloudpilot_acceptance_app",
    host: "127.0.0.1",
    port: "56441"
  };
}
