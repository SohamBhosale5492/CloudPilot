import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelemetryTargetConfigPanel } from "./TelemetryTargetConfigPanel";

const { api } = vi.hoisted(() => ({ api: { saveProjectTargetConfig: vi.fn() } }));
vi.mock("../api/ApiProvider", () => ({ useApi: () => api }));

describe("TelemetryTargetConfigPanel", () => {
  afterEach(cleanup);
  beforeEach(() => api.saveProjectTargetConfig.mockResolvedValue(undefined));

  it("keeps current targets until explicit save and saves the edited supported configuration", async () => {
    const current = { prometheusBaseUrl: "http://127.0.0.1:9090" };
    const onSaved = vi.fn();
    render(<TelemetryTargetConfigPanel projectId="p1" current={current} expectedModel={{ requirements: [{ id: "requests", signal: "metric" }] }} canUpdate onSaved={onSaved} />);
    expect(screen.getByText("Prometheus: configured")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit telemetry targets" }));
    const editor = screen.getByLabelText("Target configuration JSON");
    expect(JSON.parse((editor as HTMLTextAreaElement).value)).toEqual(current);
    expect(api.saveProjectTargetConfig).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Load Phase 01 local lab example" }));
    const example = JSON.parse((editor as HTMLTextAreaElement).value);
    expect(example.prometheusBaseUrl).toBe("http://127.0.0.1:9090");
    expect(example.metricConfigs.requests.serviceName).toBe("demo-service");
    fireEvent.click(screen.getByRole("button", { name: "Save telemetry targets" }));
    await waitFor(() => expect(api.saveProjectTargetConfig).toHaveBeenCalledTimes(1));
    expect(api.saveProjectTargetConfig).toHaveBeenCalledWith("p1", example);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(current.prometheusBaseUrl).toBe("http://127.0.0.1:9090");
  });

  it("blocks unsupported telemetry targets and does not offer editing to viewers", () => {
    render(<TelemetryTargetConfigPanel projectId="p1" current={null} expectedModel={null} canUpdate={false} onSaved={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Edit telemetry targets" })).not.toBeInTheDocument();
    expect(screen.getByText(/Traces, logs, and alerts do not have configured live inspectors/)).toBeInTheDocument();
  });
});
