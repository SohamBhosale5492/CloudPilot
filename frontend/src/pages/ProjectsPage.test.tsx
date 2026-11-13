import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsPage } from "./ProjectsPage";

const { api } = vi.hoisted(() => ({ api: { listProjects: vi.fn(), createProject: vi.fn() } }));

vi.mock("../api/ApiProvider", () => ({ useApi: () => api }));
vi.mock("../auth/AuthProvider", () => ({ useAuth: () => ({ roles: ["admin"] }) }));

describe("ProjectsPage scan configuration workflow", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    api.listProjects.mockResolvedValue({ items: [], hasMore: false });
    api.createProject.mockResolvedValue({ id: "project-1" });
  });

  it("creates a project with the real demo observability expectation and Prometheus target", async () => {
    render(<MemoryRouter><ProjectsPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "College demo" } });
    fireEvent.change(screen.getByLabelText(/Repository URL/), { target: { value: "https://github.com/example/observability-demo" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(api.createProject).toHaveBeenCalledTimes(1));
    expect(api.createProject).toHaveBeenCalledWith({
      name: "College demo",
      repositoryUrl: "https://github.com/example/observability-demo",
      expectedModel: {
        schemaVersion: "cloudpilot.expected-observability.v1",
        serviceId: "demo-service",
        requirements: [{
          id: "demo-request-metric", signal: "metric", metricName: "demo_http_server_requests_total",
          dimensions: ["method", "route", "status_code"]
        }]
      },
      targetConfig: {
        prometheusBaseUrl: "http://127.0.0.1:9090",
        metricConfigs: {
          "demo-request-metric": {
            serviceName: "demo-service", route: "/api/demo", method: "GET", minimumCount: 1, maxEvidenceAgeMs: 60000
          }
        }
      }
    });
    await waitFor(() => expect(screen.queryByText("Register a project")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    expect(screen.getByLabelText("Project name")).toHaveValue("");
    expect(screen.getByLabelText(/Repository URL/)).toHaveValue("");
    expect((screen.getByLabelText("Expected observability model (JSON)") as HTMLTextAreaElement).value).toContain('"serviceId": "demo-service"');
    expect((screen.getByLabelText("Telemetry target configuration (JSON)") as HTMLTextAreaElement).value).toContain('"prometheusBaseUrl": "http://127.0.0.1:9090"');
  });

  it("preserves entered project fields and configuration when creation fails", async () => {
    api.createProject.mockRejectedValueOnce(new Error("Project API unavailable"));
    render(<MemoryRouter><ProjectsPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Keep this project" } });
    fireEvent.change(screen.getByLabelText(/Repository URL/), { target: { value: "https://github.com/example/keep-this" } });
    const expectedModel = '{"schemaVersion":"cloudpilot.expected-observability.v1","serviceId":"custom-service","requirements":[{"id":"request-count","signal":"metric","metricName":"requests_total","dimensions":["route"]}]}';
    const targetConfig = '{"prometheusBaseUrl":"http://127.0.0.1:9091","metricConfigs":{}}';
    fireEvent.change(screen.getByLabelText("Expected observability model (JSON)"), { target: { value: expectedModel } });
    fireEvent.change(screen.getByLabelText("Telemetry target configuration (JSON)"), { target: { value: targetConfig } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Project API unavailable");
    expect(screen.getByLabelText("Project name")).toHaveValue("Keep this project");
    expect(screen.getByLabelText(/Repository URL/)).toHaveValue("https://github.com/example/keep-this");
    expect(screen.getByLabelText("Expected observability model (JSON)")).toHaveValue(expectedModel);
    expect(screen.getByLabelText("Telemetry target configuration (JSON)")).toHaveValue(targetConfig);
  });

  it("blocks malformed configuration instead of creating an unscannable project", async () => {
    render(<MemoryRouter><ProjectsPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Invalid config" } });
    fireEvent.change(screen.getByLabelText("Expected observability model (JSON)"), { target: { value: "{" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Expected observability model must be valid JSON.");
    expect(api.createProject).not.toHaveBeenCalled();
  });
});
