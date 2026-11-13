import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArchitectureDiscoveryPanel } from "./ArchitectureDiscoveryPanel";

const { api } = vi.hoisted(() => ({ api: { discoverProjectArchitecture: vi.fn(), saveProjectExpectedModel: vi.fn(), mergeProjectExpectedModel: vi.fn() } }));
vi.mock("../api/ApiProvider", () => ({ useApi: () => api }));

const found = {
  status: "success" as const,
  model: {
    schemaVersion: "cloudpilot.architecture.v1" as const,
    services: [{ id: "compose:api", name: "api", workloadType: "compose-service" as const, image: "api:1", ports: ["8080:8080"], dependencies: [], source: { file: "compose.yaml", format: "docker-compose" as const } }],
    resources: []
  },
  diagnostics: []
};

function manifestFile(name: string, text: string): File {
  const file = new File([text], name, { type: "text/yaml" });
  Object.defineProperty(file, "text", { value: async () => text });
  return file;
}

describe("ArchitectureDiscoveryPanel", () => {
  afterEach(cleanup);
  beforeEach(() => {
    api.discoverProjectArchitecture.mockResolvedValue(found);
    api.saveProjectExpectedModel.mockResolvedValue(undefined);
    api.mergeProjectExpectedModel.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("shows detected evidence, keeps existing configuration untouched, and saves only after explicit requirements are added", async () => {
    const existing = { schemaVersion: "cloudpilot.expected-observability.v1", serviceId: "legacy", requirements: [{ id: "old" }] };
    const onSaved = vi.fn();
    render(<ArchitectureDiscoveryPanel projectId="p1" existingExpectedModel={existing} canUpdate onSaved={onSaved} />);
    expect(screen.getByText(/already has an expected model/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("YAML manifest files"), {
      target: { files: [manifestFile("compose.yaml", "services: {}") ] }
    });
    expect(await screen.findByRole("heading", { name: "Detected services" })).toBeInTheDocument();
    expect(screen.getAllByText("api", { exact: true })).toHaveLength(1);
    expect(screen.getByText(/does not prove a service is running or monitored/)).toBeInTheDocument();
    expect(api.saveProjectExpectedModel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Start with empty model draft (destructive reset)" }));
    const editor = screen.getByLabelText("Review and edit expected model JSON");
    expect(JSON.parse((editor as HTMLTextAreaElement).value).requirements).toEqual([]);
    expect(screen.getByRole("button", { name: "Save reviewed expected model" })).toBeDisabled();

    fireEvent.change(editor, { target: { value: JSON.stringify({
      schemaVersion: "cloudpilot.expected-observability.v1", serviceId: "compose:api",
      requirements: [{ id: "requests", signal: "metric", metricName: "http_requests_total", dimensions: ["route"] }]
    }) } });
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed expected model" }));
    await waitFor(() => expect(api.saveProjectExpectedModel).toHaveBeenCalledTimes(1));
    expect(api.saveProjectExpectedModel).toHaveBeenCalledWith("p1", expect.objectContaining({ serviceId: "compose:api" }));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(existing.serviceId).toBe("legacy");
  });

  it("shows assumptions, requires exact metric input, and preserves the saved model until explicit save", async () => {
    const existing = { schemaVersion: "cloudpilot.expected-observability.v1", serviceId: "old", requirements: [{ id: "keep", signal: "trace", serviceName: "api" }] };
    render(<ArchitectureDiscoveryPanel projectId="p1" existingExpectedModel={existing} canUpdate onSaved={() => undefined} />);
    fireEvent.change(screen.getByLabelText("YAML manifest files"), { target: { files: [manifestFile("compose.yaml", "services: {}") ] } });
    await screen.findByText("Request rate");
    expect(screen.getByText(/Low confidence/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Request rate"));
    expect(screen.getByLabelText("Metric name from service configuration")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Metric name from service configuration"), { target: { value: "http_requests_total" } });
    fireEvent.click(screen.getByRole("button", { name: "Add selected recommendations to model draft" }));
    const draft = JSON.parse((screen.getByLabelText("Review and edit expected model JSON") as HTMLTextAreaElement).value);
    expect(draft.requirements[0]).toEqual(existing.requirements[0]);
    expect(draft.requirements[1].metricName).toBe("http_requests_total");
    expect(api.saveProjectExpectedModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed expected model" }));
    await waitFor(() => expect(api.mergeProjectExpectedModel).toHaveBeenCalledWith("p1", existing, expect.objectContaining({ requirements: expect.arrayContaining(existing.requirements) })));
    expect(existing.serviceId).toBe("old");
  });

  it("reports unsupported discovery without fabricating services", async () => {
    api.discoverProjectArchitecture.mockResolvedValue({
      status: "unsupported", model: { schemaVersion: "cloudpilot.architecture.v1", services: [], resources: [] },
      diagnostics: [{ code: "UNSUPPORTED_FORMAT", severity: "warning", message: "No supported YAML files." }]
    });
    render(<ArchitectureDiscoveryPanel projectId="p1" existingExpectedModel={null} canUpdate onSaved={() => undefined} />);
    fireEvent.change(screen.getByLabelText("YAML manifest files"), {
      target: { files: [manifestFile("other.yml", "x") ] }
    });
    expect(await screen.findByText("unsupported", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("No supported services were discovered.")).toBeInTheDocument();
    expect(api.saveProjectExpectedModel).not.toHaveBeenCalled();
  });
});
