import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationGitHubBindingPanel } from "./OrganizationGitHubBindingPanel";

const { api } = vi.hoisted(() => ({ api: {
  listOrganizations: vi.fn(), listOrganizationInstallations: vi.fn(), listInstallationRepositories: vi.fn(),
  getOrganizationProjectBinding: vi.fn(), bindOrganizationProjectRepository: vi.fn(), disconnectOrganizationProjectRepository: vi.fn()
} }));
vi.mock("../api/ApiProvider", () => ({ useApi: () => api }));

describe("OrganizationGitHubBindingPanel", () => {
  beforeEach(() => {
    api.listOrganizations.mockReset().mockResolvedValue({ items: [{ id: "org-1", displayName: "Team", role: "admin" }], hasMore: false });
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
});
