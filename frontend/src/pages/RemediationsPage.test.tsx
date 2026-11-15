import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { RemediationsPage } from "./RemediationsPage";

const { api } = vi.hoisted(() => ({
  api: {
    listProjects: vi.fn(),
    listRemediationProposals: vi.fn(),
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
    api.listRemediationProposals.mockRejectedValue(new ApiError("Not found", 404));
  });

  it("does not invent an empty remediation dataset when the optional API route is unavailable", async () => {
    render(<MemoryRouter><RemediationsPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Choose test project" }));
    expect(await screen.findByText(/Remediation read route unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/no empty dataset is inferred/i)).toBeInTheDocument();
  });

  it("displays persisted remediation proposals including pending_approval without legacy retrigger actions", async () => {
    api.listRemediationProposals.mockResolvedValue({
      items: [{
        id: "fb6e7fb6-d4ef-42ac-abff-0cc23ecb6e15",
        organizationId: "org-1",
        projectId: "project-1",
        findingId: "finding-1",
        repositoryBindingId: "binding-1",
        githubRepositoryId: "12345",
        planHash: "a".repeat(64),
        plan: { patch: { filePath: "config/observability/metrics.yaml" } },
        approvalState: "pending",
        status: "pending_approval",
        approvedByIdentityUserId: null,
        approvedAt: null,
        rejectedByIdentityUserId: null,
        rejectedAt: null,
        executionArtifact: null,
        approvedArtifactHash: null,
        invalidatedAt: null,
        createdAt: "2026-01-01T00:00:00Z"
      }],
      hasMore: false
    });
    render(<MemoryRouter><RemediationsPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Choose test project" }));

    expect(await screen.findByText("pending approval")).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();
    expect(screen.getByText("config/observability/metrics.yaml")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review proposal" })).toHaveAttribute(
      "href",
      "/proposals/fb6e7fb6-d4ef-42ac-abff-0cc23ecb6e15"
    );
    expect(screen.queryByRole("button", { name: "Retrigger" })).not.toBeInTheDocument();
    expect(api.retriggerRemediation).not.toHaveBeenCalled();
  });

  it("displays invalidated status and invalidation reason for stale proposals", async () => {
    api.listRemediationProposals.mockResolvedValue({
      items: [{
        id: "fb6e7fb6-d4ef-42ac-abff-0cc23ecb6e15",
        organizationId: "org-1",
        projectId: "project-1",
        findingId: "finding-1",
        repositoryBindingId: "binding-1",
        githubRepositoryId: "12345",
        planHash: "a".repeat(64),
        plan: { patch: { filePath: "config/observability/metrics.yaml" } },
        approvalState: "invalidated",
        status: "pending_approval",
        approvedByIdentityUserId: null,
        approvedAt: null,
        rejectedByIdentityUserId: null,
        rejectedAt: null,
        executionArtifact: null,
        approvedArtifactHash: null,
        invalidatedAt: "2026-01-02T00:00:00Z",
        invalidationReason: "The original finding was resolved in a newer completed scan.",
        createdAt: "2026-01-01T00:00:00Z"
      }],
      hasMore: false
    });
    render(<MemoryRouter><RemediationsPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Choose test project" }));

    expect(await screen.findByText("invalidated")).toBeInTheDocument();
    expect(screen.getByText("The original finding was resolved in a newer completed scan.")).toBeInTheDocument();
  });
});
