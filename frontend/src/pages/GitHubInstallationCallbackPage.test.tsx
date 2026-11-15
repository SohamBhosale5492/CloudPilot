import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubInstallationCallbackPage } from "./GitHubInstallationCallbackPage";
import { storeGitHubInstallationReturn } from "../github/installation-flow";

const { api, auth } = vi.hoisted(() => ({
  api: { completeGitHubInstallation: vi.fn() },
  auth: { account: null as { homeAccountId: string } | null, loading: false }
}));

vi.mock("../api/ApiProvider", () => ({ useApi: () => api }));
vi.mock("../auth/AuthProvider", () => ({ useAuth: () => auth }));

const state = "x".repeat(43);
const callbackUrl = `/github/installations/callback?installation_id=12345678&state=${state}&setup_action=install`;

function renderCallback(url = callbackUrl) {
  window.history.replaceState({}, "", url);
  return render(<StrictMode><MemoryRouter initialEntries={[url]}><Routes>
    <Route path="/github/installations/callback" element={<GitHubInstallationCallbackPage />} />
    <Route path="/projects/project-1" element={<div>Project detail</div>} />
  </Routes></MemoryRouter></StrictMode>);
}

describe("GitHubInstallationCallbackPage", () => {
  afterEach(cleanup);

  beforeEach(() => {
    window.sessionStorage.clear();
    api.completeGitHubInstallation.mockReset().mockResolvedValue({ accountLogin: "cloudpilot-org", status: "connected", alreadyConnected: false });
    auth.account = { homeAccountId: "user" };
    auth.loading = false;
    window.history.replaceState({}, "", "/");
  });

  it("relays callback data once under StrictMode, clears query parameters, and shows backend-confirmed success", async () => {
    renderCallback();
    expect(await screen.findByText("GitHub App installation for cloudpilot-org was verified and connected.")).toBeInTheDocument();
    expect(api.completeGitHubInstallation).toHaveBeenCalledTimes(1);
    expect(api.completeGitHubInstallation).toHaveBeenCalledWith({ installationId: "12345678", state, setupAction: "install" });
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("does not send callback state without an active CloudPilot account", async () => {
    auth.account = null;
    renderCallback();
    expect(await screen.findByText(/A CloudPilot sign-in is required/)).toBeInTheDocument();
    expect(api.completeGitHubInstallation).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("shows failure truthfully and permits an in-memory retry", async () => {
    api.completeGitHubInstallation.mockRejectedValueOnce(new Error("Verification unavailable"));
    renderCallback();
    expect(await screen.findByText("Verification unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry verification" }));
    expect(await screen.findByText("GitHub App installation for cloudpilot-org was verified and connected.")).toBeInTheDocument();
    expect(api.completeGitHubInstallation).toHaveBeenCalledTimes(2);
  });

  it("returns to the initiating project after backend confirmation", async () => {
    storeGitHubInstallationReturn({ projectPath: "/projects/project-1", organizationId: "d8a9a4cb-5ca0-46da-bb25-b124beea0e90" });
    renderCallback();
    fireEvent.click(await screen.findByRole("button", { name: "Continue to repository binding" }));
    expect(await screen.findByText("Project detail")).toBeInTheDocument();
  });

  it("relays setup_action=update once under StrictMode and shows backend-confirmed success", async () => {
    const updateUrl = `/github/installations/callback?installation_id=12345678&state=${state}&setup_action=update`;
    renderCallback(updateUrl);
    expect(await screen.findByText("GitHub App installation for cloudpilot-org was verified and connected.")).toBeInTheDocument();
    expect(api.completeGitHubInstallation).toHaveBeenCalledTimes(1);
    expect(api.completeGitHubInstallation).toHaveBeenCalledWith({ installationId: "12345678", state, setupAction: "update" });
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("fails closed on unsupported setup actions without calling API", async () => {
    for (const unsupported of ["reinstall", "request", "delete", "unknown", ""]) {
      api.completeGitHubInstallation.mockClear();
      const invalidUrl = `/github/installations/callback?installation_id=12345678&state=${state}&setup_action=${unsupported}`;
      const { unmount } = renderCallback(invalidUrl);
      expect(await screen.findByText(/GitHub returned invalid installation callback parameters/)).toBeInTheDocument();
      expect(api.completeGitHubInstallation).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("fails closed on malformed state parameters without calling API", async () => {
    for (const badState of ["too-short", "x".repeat(42), "x".repeat(44), "x".repeat(42) + "$", ""]) {
      api.completeGitHubInstallation.mockClear();
      const invalidUrl = `/github/installations/callback?installation_id=12345678&state=${encodeURIComponent(badState)}&setup_action=install`;
      const { unmount } = renderCallback(invalidUrl);
      expect(await screen.findByText(/GitHub returned invalid installation callback parameters/)).toBeInTheDocument();
      expect(api.completeGitHubInstallation).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("fails closed on invalid installation IDs without calling API", async () => {
    for (const badId of ["not-a-number", "0", "-123", "99999999999999999999999", ""]) {
      api.completeGitHubInstallation.mockClear();
      const invalidUrl = `/github/installations/callback?installation_id=${badId}&state=${state}&setup_action=update`;
      const { unmount } = renderCallback(invalidUrl);
      expect(await screen.findByText(/GitHub returned invalid installation callback parameters/)).toBeInTheDocument();
      expect(api.completeGitHubInstallation).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("fails closed on duplicate query parameters without calling API", async () => {
    const pollutedUrls = [
      `/github/installations/callback?installation_id=12345678&installation_id=87654321&state=${state}&setup_action=install`,
      `/github/installations/callback?installation_id=12345678&state=${state}&state=${state}&setup_action=install`,
      `/github/installations/callback?installation_id=12345678&state=${state}&setup_action=install&setup_action=update`
    ];
    for (const pollutedUrl of pollutedUrls) {
      api.completeGitHubInstallation.mockClear();
      const { unmount } = renderCallback(pollutedUrl);
      expect(await screen.findByText(/GitHub returned invalid installation callback parameters/)).toBeInTheDocument();
      expect(api.completeGitHubInstallation).not.toHaveBeenCalled();
      unmount();
    }
  });
});
