import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceObservabilityPanel } from "./SourceObservabilityPanel";

const { api } = vi.hoisted(() => ({ api: { analyzeProjectSource: vi.fn(), applyProjectSourceAnalysis: vi.fn() } }));
vi.mock("../api/ApiProvider", () => ({ useApi: () => api }));

const analysis = {
  status: "partial" as const, sourceDigest: "abc123", serviceName: "alumni-api", routes: [
    { method: "GET", path: "/health", evidence: { path: "backend/src/app.js", line: 67, claim: "health route" } }
  ],
  expectedModel: { schemaVersion: "cloudpilot.expected-observability.v1" as const, serviceId: "alumni-api", requirements: [
    { id: "health-health", signal: "health" as const, kind: "http" as const, endpoint: "/health" }
  ] }, metricConfigs: {}, evidenceByRequirement: {}, findings: [
    { id: "health-dependency-readiness", ruleId: "CP-RULE-SOURCE-HEALTH-DEPENDENCY-READINESS", severity: "medium" as const, status: "incomplete" as const,
      title: "Health handler is dependency-blind", expected: "Dependency readiness", observed: "Health handler does not check the database.", risk: "May report healthy while database is disconnected.",
      evidence: [{ path: "backend/src/app.js", line: 67, claim: "health handler" }] }
  ], diagnostics: []
};

function sourceFile(path: string, content: string): File {
  const file = new File([content], path.split("/").at(-1) ?? path, { type: "text/javascript" });
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  Object.defineProperty(file, "text", { value: async () => content });
  return file;
}

describe("SourceObservabilityPanel", () => {
  afterEach(cleanup);
  beforeEach(() => {
    api.analyzeProjectSource.mockResolvedValue(analysis);
    api.applyProjectSourceAnalysis.mockResolvedValue({ ...analysis, saved: true });
  });

  it("previews source evidence, requires explicit apply, and keeps the expected-model baseline", async () => {
    const onSaved = vi.fn();
    const baseline = { schemaVersion: "cloudpilot.expected-observability.v1", serviceId: "alumni-api", requirements: [] };
    render(<SourceObservabilityPanel projectId="p1" existingExpectedModel={baseline} canUpdate onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Application and monitoring source files"), {
      target: { files: [sourceFile("backend/src/app.js", 'app.get("/health", handler);')] }
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Analyze source snapshot" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Analyze source snapshot" }));
    await screen.findByText(/Health handler is dependency-blind/);
    expect(screen.getAllByText(/backend\/src\/app\.js:67/).length).toBeGreaterThan(0);
    expect(api.applyProjectSourceAnalysis).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply reviewed source model" }));
    await waitFor(() => expect(api.applyProjectSourceAnalysis).toHaveBeenCalledWith("p1", expect.any(Array), baseline));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/saved with an audit event/)).toBeInTheDocument();
  });

  it("does not upload ignored environment files", async () => {
    render(<SourceObservabilityPanel projectId="p1" existingExpectedModel={null} canUpdate onSaved={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Application and monitoring source files"), {
      target: { files: [sourceFile("backend/.env", "secret=value")] }
    });
    expect(api.analyzeProjectSource).not.toHaveBeenCalled();
    expect(screen.getByText(/Choose 1 to 120 source or configuration files/)).toBeInTheDocument();
  });
});
