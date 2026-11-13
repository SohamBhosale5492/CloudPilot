import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FindingsPage } from "./FindingsPage";

const { api } = vi.hoisted(() => ({
  api: { listScans: vi.fn(), listFindings: vi.fn(), createRemediation: vi.fn(), createRemediationProposal: vi.fn() }
}));

vi.mock("../api/ApiProvider", () => ({ useApi: () => api }));
vi.mock("../components/ProjectPicker", () => ({
  ProjectPicker: ({ onChange }: { onChange: (id: string) => void }) =>
    <button onClick={() => onChange("project-1")}>Choose test project</button>
}));

describe("FindingsPage approved-artifact proposal action", () => {
  beforeEach(() => {
    api.listScans.mockResolvedValue({ items: [{
      id: "scan-1", tenantId: "tenant-1", projectId: "project-1", status: "completed",
      createdAt: "2026-01-01T00:00:00Z", startedAt: null, completedAt: "2026-01-01T00:00:01Z",
      error: null, attemptCount: 1
    }], hasMore: false });
    api.listFindings.mockResolvedValue({ items: [{
      id: "finding-1", tenantId: "tenant-1", projectId: "project-1", scanId: "scan-1",
      ruleId: "request-metric", ruleVersion: "1", requirementId: "requests", signal: "metric",
      outcome: "gap", expected: "present", observed: "missing", reason: "Metric missing",
      evidenceJson: { source: "unit-test" }, createdAt: "2026-01-01T00:00:02Z"
    }], hasMore: false });
    api.createRemediation.mockReset();
    api.createRemediationProposal.mockReset();
  });

  it("creates a proposal through the approved proposal API for a persisted gap finding", async () => {
    api.createRemediationProposal.mockResolvedValue({ proposal: { id: "proposal-1" }, replayed: false });
    render(<MemoryRouter><FindingsPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Choose test project" }));
    fireEvent.change(await screen.findByLabelText("Scan"), { target: { value: "scan-1" } });

    expect(await screen.findByText("Metric missing")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create proposal" }));
    expect(api.createRemediationProposal).toHaveBeenCalledWith("project-1", "finding-1");
    expect(api.createRemediation).not.toHaveBeenCalled();
  });
});
