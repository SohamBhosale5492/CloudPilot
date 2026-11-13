import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewPage } from "./OverviewPage";

const { api } = vi.hoisted(() => ({
  api: { liveness: vi.fn(), readiness: vi.fn() }
}));

vi.mock("../api/ApiProvider", () => ({ useApi: () => api }));

describe("OverviewPage health requests", () => {
  beforeEach(() => {
    api.liveness.mockReset().mockResolvedValue({ status: "ok" });
    api.readiness.mockReset().mockResolvedValue({ status: "ready" });
  });

  it("requests liveness and readiness once per effect execution and does not restart on rerender", async () => {
    const view = render(<MemoryRouter><OverviewPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
    expect(api.liveness).toHaveBeenCalledTimes(1);
    expect(api.readiness).toHaveBeenCalledTimes(1);

    view.rerender(<MemoryRouter><OverviewPage /></MemoryRouter>);
    expect(api.liveness).toHaveBeenCalledTimes(1);
    expect(api.readiness).toHaveBeenCalledTimes(1);
  });
});
