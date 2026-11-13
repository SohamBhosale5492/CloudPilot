import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiProvider, useApi } from "./ApiProvider";

const { authState, tokenBridge } = vi.hoisted(() => ({
  authState: { value: { getAccessToken: vi.fn(async () => "token-one") } },
  tokenBridge: { current: undefined as (() => Promise<string>) | undefined }
}));

vi.mock("../auth/AuthProvider", () => ({ useAuth: () => authState.value }));
vi.mock("./client", () => ({
  createApiClient: vi.fn((baseUrl: string, getAccessToken: () => Promise<string>) => {
    void baseUrl;
    tokenBridge.current = getAccessToken;
    return {};
  }),
  CloudPilotApi: class { constructor(client: unknown) { void client; } }
}));

const config = {
  tenantId: "tenant-1", clientId: "client-1", apiClientId: "api-1",
  apiScope: "api://api-1/access_as_user", apiBaseUrl: "/", redirectUri: "http://127.0.0.1:5173"
};

describe("ApiProvider client stability", () => {
  beforeEach(() => {
    authState.value = { getAccessToken: vi.fn(async () => "token-one") };
    tokenBridge.current = undefined;
  });

  it("rebuilds its API client when the authenticated token callback changes", async () => {
    const instances: unknown[] = [];
    function Probe() {
      instances.push(useApi());
      return null;
    }
    const { rerender } = render(<ApiProvider config={config}><Probe /></ApiProvider>);
    authState.value = { getAccessToken: vi.fn(async () => "token-two") };
    rerender(<ApiProvider config={config}><Probe /></ApiProvider>);
    expect(instances[1]).not.toBe(instances[0]);
    await expect(tokenBridge.current!()).resolves.toBe("token-two");
  });
});
