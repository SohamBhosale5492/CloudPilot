import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { RemediationsPage } from "./RemediationsPage";

const { api } = vi.hoisted(() => ({
  api: {
    listProjects: vi.fn(),
    listRemediations: vi.fn(),
    retriggerRemediation: vi.fn()
  }
}));

vi.mock("../api/ApiProvider", () => ({ useApi: () => api }));
vi.mock("../auth/AuthProvider", () => ({ useAuth: () => ({ roles: ["operator"] }) }));
vi.mock("../components/ProjectPicker", () => ({ ProjectPicker: ({ onChange }: { onChange: (id: string) => void }) => <button onClick={() => onChange("project-1")}>Choose test project</button> }));

describe("RemediationsPage with mocked API and mocked role", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    api.listProjects.mockResolvedValue({ items: [], hasMore: false });
    api.listRemediations.mockRejectedValue(new ApiError("Not found", 404));
  });

  it("does not invent an empty remediation dataset when the optional API route is unavailable", async () => {
    render(<MemoryRouter><RemediationsPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Choose test project" }));
    expect(await screen.findByText(/Remediation read route unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/no empty dataset is inferred/i)).toBeInTheDocument();
  });

  it("does not offer the intentionally disabled legacy retrigger action", async () => {
    api.listRemediations.mockResolvedValue({
      items: [{ id: "remediation-1", projectId: "project-1", scanId: "scan-1", findingId: "finding-1",
        status: "failed", prUrl: null, prNumber: null, branchName: null, patchSummary: null,
        errorMessage: null, retriesLeft: 0, nextAttemptAt: null, createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z" }],
      hasMore: false
    });
    render(<MemoryRouter><RemediationsPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Choose test project" }));

    expect(await screen.findByText("Retry disabled")).toBeInTheDocument();
    expect(screen.getByText(/Legacy remediation creation and retriggering are disabled/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retrigger" })).not.toBeInTheDocument();
    expect(api.retriggerRemediation).not.toHaveBeenCalled();
  });
});
