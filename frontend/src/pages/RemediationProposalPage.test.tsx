import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemediationProposalPage } from "./RemediationProposalPage";

const { api } = vi.hoisted(() => ({ api: {
  getRemediationProposal: vi.fn(), prepareRemediationArtifact: vi.fn(), decideRemediationProposal: vi.fn()
} }));
vi.mock("../api/ApiProvider", () => ({ useApi: () => api }));

const pending = (artifact: boolean) => ({
  id: "proposal-1", organizationId: "org-1", projectId: "project-1", findingId: "finding-1",
  repositoryBindingId: "binding-1", githubRepositoryId: "42", planHash: "a".repeat(64),
  plan: { patch: { filePath: "config/observability/metrics.yaml" } }, approvalState: "pending",
  status: "pending_approval", approvedByIdentityUserId: null, approvedAt: null, rejectedByIdentityUserId: null,
  rejectedAt: null, executionArtifact: artifact ? { artifactHash: "b".repeat(64), filePath: "config/observability/metrics.yaml",
    baseRef: "main", baseCommitSha: "c".repeat(40) } : null,
  approvedArtifactHash: null, invalidatedAt: null, createdAt: "2026-01-01T00:00:00Z",
  permissions: { prepareArtifact: true, approve: true }
});

describe("RemediationProposalPage", () => {
  beforeEach(() => {
    api.getRemediationProposal.mockReset().mockResolvedValue(pending(false));
    api.prepareRemediationArtifact.mockReset().mockResolvedValue({ artifactHash: "b".repeat(64), replayed: false });
    api.decideRemediationProposal.mockReset().mockResolvedValue({ remediationId: "proposal-1", approvalState: "approved", status: "pending_approval" });
  });

  it("displays invalidated status and reason and omits approval buttons for stale proposals", async () => {
    api.getRemediationProposal.mockResolvedValue({
      ...pending(false),
      approvalState: "invalidated",
      invalidatedAt: "2026-01-02T00:00:00Z",
      invalidationReason: "The original finding was resolved in a newer completed scan."
    });
    render(<MemoryRouter initialEntries={["/proposals/proposal-1"]}><Routes>
      <Route path="/proposals/:proposalId" element={<RemediationProposalPage />} />
    </Routes></MemoryRouter>);

    expect(await screen.findByText(/Proposal invalidated\./)).toBeInTheDocument();
    expect(screen.getByText(/The original finding was resolved in a newer completed scan\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve proposal" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject proposal" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Prepare verified artifact" })).not.toBeInTheDocument();
  });

  it("prepares and displays the persisted artifact before explicit approval", async () => {
    api.getRemediationProposal.mockResolvedValueOnce(pending(false)).mockResolvedValueOnce(pending(true)).mockResolvedValueOnce({
      ...pending(true), approvalState: "approved", approvedArtifactHash: "b".repeat(64)
    });
    render(<MemoryRouter initialEntries={["/proposals/proposal-1"]}><Routes>
      <Route path="/proposals/:proposalId" element={<RemediationProposalPage />} />
    </Routes></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Prepare verified artifact" }));
    await screen.findByText(/Artifact prepared:/);
    expect(await screen.findByText(/baseRef|Approved base/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve proposal" }));
    await waitFor(() => expect(api.decideRemediationProposal).toHaveBeenCalledWith("proposal-1", "approve"));
    expect(await screen.findByText(/Automated execution remains disabled/)).toBeInTheDocument();
  });
});
