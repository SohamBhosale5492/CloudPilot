export const GITHUB_INSTALLATION_RETURN_KEY = "cloudpilot:github-installation:return";

export interface GitHubInstallationReturnContext {
  projectPath: string;
  organizationId: string;
}

const APP_SLUG_PATH = /^\/apps\/[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?\/installations\/new$/;
const ORGANIZATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateGitHubInstallationUrl(value: string, expectedState: string): string | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(expectedState)) return null;
  try {
    const url = new URL(value);
    if (url.origin !== "https://github.com" || url.protocol !== "https:" || url.username || url.password || url.hash ||
        !APP_SLUG_PATH.test(url.pathname) || [...url.searchParams.keys()].length !== 1 ||
        url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== expectedState) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function redirectToGitHubInstallation(
  value: string,
  state: string,
  assign: (url: string) => void = (url) => window.location.assign(url)
): void {
  const url = validateGitHubInstallationUrl(value, state);
  if (!url) throw new Error("CloudPilot received an invalid GitHub installation URL. Restart the connection request.");
  assign(url);
}

export function storeGitHubInstallationReturn(context: GitHubInstallationReturnContext): boolean {
  const path = safeProjectPath(context.projectPath);
  if (!path || !ORGANIZATION_ID.test(context.organizationId)) {
    throw new Error("The GitHub installation return context is invalid.");
  }
  try {
    window.sessionStorage.setItem(GITHUB_INSTALLATION_RETURN_KEY, JSON.stringify({ projectPath: path, organizationId: context.organizationId }));
    return true;
  } catch {
    return false;
  }
}

export function readGitHubInstallationReturn(consume = false): GitHubInstallationReturnContext | null {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(GITHUB_INSTALLATION_RETURN_KEY);
    if (consume && raw !== null) window.sessionStorage.removeItem(GITHUB_INSTALLATION_RETURN_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const projectPath = typeof record.projectPath === "string" ? safeProjectPath(record.projectPath) : null;
    const organizationId = record.organizationId;
    if (!projectPath || typeof organizationId !== "string" || !ORGANIZATION_ID.test(organizationId)) return null;
    return { projectPath, organizationId };
  } catch {
    return null;
  }
}

function safeProjectPath(value: string): string | null {
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || url.search || url.hash || !/^\/projects\/[^/]+$/.test(url.pathname)) return null;
    return url.pathname;
  } catch {
    return null;
  }
}
