import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubInstallationCallbackPage } from "./GitHubInstallationCallbackPage";

const { api, auth } = vi.hoisted(() => ({
  api: { completeGitHubInstallation: vi.fn() },
  auth: { account: null as { homeAccountId: string } | null, loading: false }
}));

vi.mock("../api/ApiProvider", () => ({ useApi: () => api }));
vi.mock("../auth/AuthProvider", () => ({ useAuth: () => auth }));

const state = "x".repeat(43);
const callbackUrl = `/github/installations/callback?installation_id=12345678&state=${state}&setup_action=install`;

function renderCallback() {
  window.history.replaceState({}, "", callbackUrl);
  return render(<StrictMode><MemoryRouter initialEntries={[callbackUrl]}><Routes>
    <Route path="/github/installations/callback" element={<GitHubInstallationCallbackPage />} />
  </Routes></MemoryRouter></StrictMode>);
}

describe("GitHubInstallationCallbackPage", () => {
  beforeEach(() => {
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
});
