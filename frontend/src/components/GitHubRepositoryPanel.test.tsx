import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubRepositoryPanel } from "./GitHubRepositoryPanel";

const { api } = vi.hoisted(() => ({ api: { configureGitHubRepository: vi.fn(), disconnectGitHubRepository: vi.fn() } }));
vi.mock("../api/ApiProvider", () => ({ useApi: () => api }));

describe("GitHubRepositoryPanel", () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    api.configureGitHubRepository.mockReset().mockResolvedValue({ configured: true });
    api.disconnectGitHubRepository.mockReset().mockResolvedValue({ configured: false });
  });

  it("allows project:update users to save a reference and clearly marks access unverified", async () => {
    const onSaved = vi.fn();
    render(<GitHubRepositoryPanel projectId="p1" currentUrl={null} canUpdate onSaved={onSaved} />);
    expect(screen.getByText(/metadata only/i)).toBeInTheDocument();
    expect(screen.getByText(/No repository reference is configured/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("HTTPS GitHub repository URL"), { target: { value: "https://github.com/example/service" } });
    fireEvent.click(screen.getByRole("button", { name: "Save repository reference" }));
    await waitFor(() => expect(api.configureGitHubRepository).toHaveBeenCalledWith("p1", "https://github.com/example/service"));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/No token is requested or stored here/)).toBeInTheDocument();
  });

  it("shows existing owner/name, permits disconnect, and does not reveal an invalid stored URL", async () => {
    const onSaved = vi.fn();
    const view = render(<GitHubRepositoryPanel projectId="p1" currentUrl="https://github.com/example/service.git" canUpdate onSaved={onSaved} />);
    expect(screen.getByText(/example\/service/)).toBeInTheDocument();
    expect(screen.getByLabelText("HTTPS GitHub repository URL")).toHaveValue("https://github.com/example/service");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect repository reference" }));
    await waitFor(() => expect(api.disconnectGitHubRepository).toHaveBeenCalledWith("p1"));
    expect(onSaved).toHaveBeenCalledTimes(1);
    view.rerender(<GitHubRepositoryPanel projectId="p1" currentUrl="https://user:secret@github.com/example/service" canUpdate onSaved={onSaved} />);
    expect(screen.getByText(/cannot be safely displayed/)).toBeInTheDocument();
    expect(screen.getByLabelText("HTTPS GitHub repository URL")).toHaveValue("");
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
  });

  it("keeps reference changes unavailable without project:update", () => {
    render(<GitHubRepositoryPanel projectId="p1" currentUrl={null} canUpdate={false} onSaved={vi.fn()} />);
    expect(screen.queryByLabelText("HTTPS GitHub repository URL")).not.toBeInTheDocument();
    expect(screen.getByText(/does not have project:update permission/)).toBeInTheDocument();
  });

  it("reports API failures without replacing them with a success state", async () => {
    api.configureGitHubRepository.mockRejectedValueOnce(new Error("Repository setup unavailable"));
    render(<GitHubRepositoryPanel projectId="p1" currentUrl={null} canUpdate onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("HTTPS GitHub repository URL"), { target: { value: "https://github.com/example/service" } });
    fireEvent.click(screen.getByRole("button", { name: "Save repository reference" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Repository setup unavailable");
  });
});
