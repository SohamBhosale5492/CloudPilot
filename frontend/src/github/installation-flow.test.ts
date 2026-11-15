import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_INSTALLATION_RETURN_KEY,
  readGitHubInstallationReturn,
  redirectToGitHubInstallation,
  storeGitHubInstallationReturn,
  validateGitHubInstallationUrl
} from "./installation-flow";

const state = "s".repeat(43);
const githubUrl = `https://github.com/apps/cloudpilot-secure-observability/installations/new?state=${state}`;
const organizationId = "d8a9a4cb-5ca0-46da-bb25-b124beea0e90";

afterEach(() => window.sessionStorage.clear());

describe("GitHub installation frontend flow", () => {
  it("accepts only the backend GitHub install URL bound to the returned state", () => {
    expect(validateGitHubInstallationUrl(githubUrl, state)).toBe(githubUrl);
    expect(validateGitHubInstallationUrl("https://attacker.example/collect?state=" + state, state)).toBeNull();
    expect(validateGitHubInstallationUrl(githubUrl.replace(state, "x".repeat(43)), state)).toBeNull();
    expect(validateGitHubInstallationUrl(`${githubUrl}&redirect_uri=https://attacker.example`, state)).toBeNull();
  });

  it("redirects only after validating the exact GitHub install destination", () => {
    const assign = vi.fn();
    redirectToGitHubInstallation(githubUrl, state, assign);
    expect(assign).toHaveBeenCalledWith(githubUrl);
    expect(() => redirectToGitHubInstallation("https://attacker.example", state, assign)).toThrow(/invalid GitHub installation URL/i);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("stores and consumes only a same-origin project return context", () => {
    storeGitHubInstallationReturn({ projectPath: "/projects/project-1", organizationId });
    expect(readGitHubInstallationReturn()).toEqual({ projectPath: "/projects/project-1", organizationId });
    expect(readGitHubInstallationReturn(true)).toEqual({ projectPath: "/projects/project-1", organizationId });
    expect(window.sessionStorage.getItem(GITHUB_INSTALLATION_RETURN_KEY)).toBeNull();

    window.sessionStorage.setItem(GITHUB_INSTALLATION_RETURN_KEY, JSON.stringify({
      projectPath: "https://attacker.example/steal", organizationId
    }));
    expect(readGitHubInstallationReturn()).toBeNull();
  });
});
