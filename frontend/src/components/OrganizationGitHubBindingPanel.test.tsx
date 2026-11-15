import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { OrganizationGitHubBindingPanel } from "./OrganizationGitHubBindingPanel";
import { storeGitHubInstallationReturn } from "../github/installation-flow";

const { api, redirect } = vi.hoisted(() => ({ api: {
  listOrganizations: vi.fn(), createOrganization: vi.fn(), requestProjectAdoption: vi.fn(), decideProjectAdoption: vi.fn(),
  startGitHubInstallation: vi.fn(), listOrganizationInstallations: vi.fn(), listInstallationRepositories: vi.fn(),
  getOrganizationProjectBinding: vi.fn(), bindOrganizationProjectRepository: vi.fn(), disconnectOrganizationProjectRepository: vi.fn()
}, redirect: vi.fn() }));
vi.mock("../api/ApiProvider", () => ({ useApi: () => api }));
vi.mock("../github/installation-flow", async (importOriginal) => ({
  ...await importOriginal<typeof import("../github/installation-flow")>(),
  redirectToGitHubInstallation: (...args: unknown[]) => redirect(...args)
}));

afterEach(cleanup);

describe("OrganizationGitHubBindingPanel", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    redirect.mockReset();
    api.listOrganizations.mockReset().mockResolvedValue({ items: [{ id: "org-1", displayName: "Team", role: "admin" }], hasMore: false });
    api.createOrganization.mockReset().mockResolvedValue({
      organization: { id: "org-new", displayName: "New Team", status: "active", createdAt: "2026-11-13T00:00:00Z" },
      membership: { role: "owner", status: "active" }
    });
    api.requestProjectAdoption.mockReset().mockResolvedValue({
      adoption: { id: "adopt-1", status: "pending", projectId: "project-1" },
      replayed: false
    });
    api.decideProjectAdoption.mockReset().mockResolvedValue({
      adoption: { id: "adopt-1", status: "approved" }
    });
    api.startGitHubInstallation.mockReset().mockResolvedValue({
      intentId: "intent-1", state: "s".repeat(43),
      installationUrl: `https://github.com/apps/cloudpilot-secure-observability/installations/new?state=${"s".repeat(43)}`,
      expiresAt: "2026-11-13T00:10:00Z"
    });
    api.listOrganizationInstallations.mockReset().mockResolvedValue({ installations: [{ id: "install-record", accountLogin: "acme", accountType: "Organization", status: "active" }] });
    api.listInstallationRepositories.mockReset().mockResolvedValue({ repositories: [{ id: "9007199254740999", fullName: "acme/service", private: true, archived: false, disabled: false }], page: 1, hasNextPage: false });
    api.getOrganizationProjectBinding.mockReset().mockResolvedValue({ binding: null });
    api.bindOrganizationProjectRepository.mockReset().mockResolvedValue({ binding: { repositoryId: "9007199254740999" } });
  });

  it("binds the selected exact repository ID through the organization API", async () => {
    render(<OrganizationGitHubBindingPanel projectId="project-1" />);
    fireEvent.change(await screen.findByLabelText("Organization"), { target: { value: "org-1" } });
    fireEvent.change(await screen.findByLabelText("GitHub installation"), { target: { value: "install-record" } });
    fireEvent.change(await screen.findByLabelText("Repository"), { target: { value: "9007199254740999" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and bind repository" }));
    await waitFor(() => expect(api.bindOrganizationProjectRepository).toHaveBeenCalledWith("org-1", "project-1", "install-record", "9007199254740999"));
  });

  it("starts the backend installation intent and returns to the selected project after GitHub", async () => {
    const organizationId = "d8a9a4cb-5ca0-46da-bb25-b124beea0e90";
    api.listOrganizations.mockResolvedValue({ items: [{ id: organizationId, displayName: "Team", role: "admin" }], hasMore: false });
    api.listOrganizationInstallations.mockResolvedValue({ installations: [] });
    render(<OrganizationGitHubBindingPanel projectId="project-1" />);
    fireEvent.change(await screen.findByLabelText("Organization"), { target: { value: organizationId } });
    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub App" }));

    await waitFor(() => expect(api.startGitHubInstallation).toHaveBeenCalledWith(organizationId));
    expect(redirect).toHaveBeenCalledWith(
      `https://github.com/apps/cloudpilot-secure-observability/installations/new?state=${"s".repeat(43)}`,
      "s".repeat(43)
    );
    expect(JSON.parse(window.sessionStorage.getItem("cloudpilot:github-installation:return") ?? "null"))
      .toEqual({ projectPath: "/projects/project-1", organizationId });
  });

  it("restores the initiating organization and refreshes installations when returning to the project", async () => {
    const organizationId = "d8a9a4cb-5ca0-46da-bb25-b124beea0e90";
    api.listOrganizations.mockResolvedValue({ items: [{ id: organizationId, displayName: "CloudPilot Development", role: "owner" }], hasMore: false });
    api.listOrganizationInstallations.mockResolvedValue({
      installations: [{ id: "install-record", accountLogin: "cloudpilot", accountType: "User", status: "active" }]
    });
    storeGitHubInstallationReturn({ projectPath: "/projects/project-1", organizationId });

    render(<OrganizationGitHubBindingPanel projectId="project-1" />);

    await waitFor(() => expect(screen.getByLabelText("Organization")).toHaveValue(organizationId));
    expect(api.listOrganizationInstallations).toHaveBeenCalledWith(organizationId);
    expect(await screen.findByLabelText("GitHub installation")).toBeInTheDocument();
    expect(window.sessionStorage.getItem("cloudpilot:github-installation:return")).toBeNull();
  });

  it("does not offer GitHub installation management to an organization member", async () => {
    api.listOrganizations.mockResolvedValue({ items: [{ id: "d8a9a4cb-5ca0-46da-bb25-b124beea0e90", displayName: "Team", role: "member" }], hasMore: false });
    api.listOrganizationInstallations.mockResolvedValue({ installations: [] });
    render(<OrganizationGitHubBindingPanel projectId="project-1" />);
    fireEvent.change(await screen.findByLabelText("Organization"), { target: { value: "d8a9a4cb-5ca0-46da-bb25-b124beea0e90" } });
    await waitFor(() => expect(api.listOrganizationInstallations).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Connect GitHub App" })).not.toBeInTheDocument();
    expect(api.startGitHubInstallation).not.toHaveBeenCalled();
  });

  it("creates an organization for an empty membership list, refreshes, and selects it", async () => {
    api.listOrganizations.mockReset()
      .mockResolvedValueOnce({ items: [], hasMore: false })
      .mockResolvedValueOnce({ items: [{ id: "org-new", displayName: "New Team", role: "owner" }], hasMore: false });
    render(<OrganizationGitHubBindingPanel projectId="project-1" />);

    fireEvent.change(await screen.findByLabelText("Organization name"), { target: { value: "  New Team  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create organization" }));

    await waitFor(() => expect(screen.getByLabelText("Organization")).toHaveValue("org-new"));
    expect(api.createOrganization).toHaveBeenCalledOnce();
    const [displayName, idempotencyKey] = api.createOrganization.mock.calls[0] as [string, string];
    expect(displayName).toBe("New Team");
    expect(idempotencyKey).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(api.listOrganizations).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent(/created.*owner/i);
  });

  it("validates the organization name and presents create failures", async () => {
    api.listOrganizations.mockReset().mockResolvedValue({ items: [], hasMore: false });
    render(<OrganizationGitHubBindingPanel projectId="project-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Create organization" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Organization name must contain 1 to 120 printable characters.");
    expect(api.createOrganization).not.toHaveBeenCalled();

    api.createOrganization.mockRejectedValueOnce(new Error("Organization creation is disabled."));
    fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "New Team" } });
    fireEvent.click(screen.getByRole("button", { name: "Create organization" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Organization creation is disabled.");
  });

  it("does not offer organization creation when the membership list fails to load", async () => {
    api.listOrganizations.mockReset().mockRejectedValue(new Error("Organization list unavailable."));
    render(<OrganizationGitHubBindingPanel projectId="project-1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Organization list unavailable.");
    expect(screen.queryByLabelText("Organization name")).not.toBeInTheDocument();
  });

  it("displays active installations when project binding lookup returns 404 and completes request-approve adoption before binding", async () => {
    api.getOrganizationProjectBinding.mockReset()
      .mockRejectedValueOnce(new ApiError("Project or repository binding not found.", 404))
      .mockResolvedValueOnce({ binding: null })
      .mockResolvedValueOnce({
        binding: {
          id: "binding-1",
          installationRecordId: "install-record",
          repositoryId: "9007199254740999",
          owner: "acme",
          name: "service",
          status: "active"
        }
      });

    render(<OrganizationGitHubBindingPanel projectId="project-1" />);
    fireEvent.change(await screen.findByLabelText("Organization"), { target: { value: "org-1" } });

    // Active installation remains visible despite binding 404
    const installationSelect = await screen.findByLabelText("GitHub installation");
    expect(installationSelect).toBeInTheDocument();
    expect(screen.queryByText("No active GitHub App installation is available for this organization.")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Repository discovery works, but binding is disabled until adoption is approved
    fireEvent.change(installationSelect, { target: { value: "install-record" } });
    fireEvent.change(await screen.findByLabelText("Repository"), { target: { value: "9007199254740999" } });
    expect(screen.getByRole("button", { name: "Verify and bind repository" })).toBeDisabled();

    // Step 1: Request adoption
    fireEvent.click(screen.getByRole("button", { name: "Request project adoption" }));
    await waitFor(() => expect(api.requestProjectAdoption).toHaveBeenCalledWith("org-1", "project-1", "adopt:org-1:project-1"));

    // Step 2: Approve adoption
    fireEvent.click(await screen.findByRole("button", { name: "Approve project adoption" }));
    await waitFor(() => expect(api.decideProjectAdoption).toHaveBeenCalledWith("org-1", "adopt-1", "project-1", "approve"));

    // Step 3: Bind repository after approved adoption
    const bindButton = screen.getByRole("button", { name: "Verify and bind repository" });
    await waitFor(() => expect(bindButton).not.toBeDisabled());
    fireEvent.click(bindButton);
    await waitFor(() => expect(api.bindOrganizationProjectRepository).toHaveBeenCalledWith("org-1", "project-1", "install-record", "9007199254740999"));
    expect(await screen.findByText("The organization-scoped repository binding is active and verified.")).toBeInTheDocument();
  });

  it("does not offer project adoption to non-admin/non-owner roles when binding lookup returns 404", async () => {
    api.listOrganizations.mockResolvedValue({ items: [{ id: "org-1", displayName: "Team", role: "viewer" }], hasMore: false });
    api.getOrganizationProjectBinding.mockRejectedValueOnce(new ApiError("Project or repository binding not found.", 404));

    render(<OrganizationGitHubBindingPanel projectId="project-1" />);
    fireEvent.change(await screen.findByLabelText("Organization"), { target: { value: "org-1" } });

    await waitFor(() => expect(api.listOrganizationInstallations).toHaveBeenCalledWith("org-1"));
    expect(screen.queryByRole("button", { name: "Request project adoption" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve project adoption" })).not.toBeInTheDocument();
    expect(api.requestProjectAdoption).not.toHaveBeenCalled();
  });

  it("reloads repositories for an already-selected installation after project adoption approval", async () => {
    api.getOrganizationProjectBinding.mockReset()
      .mockRejectedValueOnce(new ApiError("Project or repository binding not found.", 404))
      .mockResolvedValueOnce({ binding: null });
    api.listInstallationRepositories.mockReset()
      .mockRejectedValueOnce(new ApiError("GitHub repository discovery is unavailable.", 503))
      .mockResolvedValueOnce({
        repositories: [{ id: "1416545152", fullName: "SohamBhosale5492/CloudPilot", private: false, archived: false, disabled: false }],
        page: 1,
        hasNextPage: false
      });

    render(<OrganizationGitHubBindingPanel projectId="project-1" />);
    fireEvent.change(await screen.findByLabelText("Organization"), { target: { value: "org-1" } });

    const installationSelect = await screen.findByLabelText("GitHub installation");
    fireEvent.change(installationSelect, { target: { value: "install-record" } });
    await waitFor(() => expect(api.listInstallationRepositories).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Request project adoption" }));
    await waitFor(() => expect(api.requestProjectAdoption).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole("button", { name: "Approve project adoption" }));
    await waitFor(() => expect(api.decideProjectAdoption).toHaveBeenCalledOnce());

    await waitFor(() => expect(api.listInstallationRepositories).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("option", { name: "SohamBhosale5492/CloudPilot" })).toBeInTheDocument();
  });
});
