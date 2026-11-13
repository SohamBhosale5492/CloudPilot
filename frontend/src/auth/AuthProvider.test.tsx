import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthProvider";

const { msalState, activeAccountId, tokenRoles } = vi.hoisted(() => {
  const accounts = [
    { homeAccountId: "home-1", localAccountId: "local-1", tenantId: "tenant-1", username: "one@example.test" },
    { homeAccountId: "home-2", localAccountId: "local-2", tenantId: "tenant-1", username: "two@example.test" }
  ];
  const activeAccountId = { value: "home-1" };
  const tokenRoles = { value: ["admin"] as string[] };
  const instance = {
    getActiveAccount: vi.fn(() => {
      const account = accounts.find((candidate) => candidate.homeAccountId === activeAccountId.value);
      return account ? { ...account } : null;
    }),
    getAllAccounts: vi.fn(() => accounts),
    setActiveAccount: vi.fn((account: { homeAccountId: string } | null) => {
      if (account) activeAccountId.value = account.homeAccountId;
    }),
    acquireTokenSilent: vi.fn(async ({ account }: { account: typeof accounts[number] }) => ({
      account,
      accessToken: `header.${btoa(JSON.stringify({ roles: tokenRoles.value }))}.signature`
    })),
    loginRedirect: vi.fn(async () => undefined),
    acquireTokenRedirect: vi.fn(async () => undefined),
    logoutRedirect: vi.fn(async () => undefined)
  };
  return {
    msalState: { instance, accounts, inProgress: "none" },
    activeAccountId,
    tokenRoles
  };
});

vi.mock("@azure/msal-react", () => ({ useMsal: () => msalState }));

const config = {
  tenantId: "tenant-1", clientId: "client-1", apiClientId: "api-1",
  apiScope: "api://api-1/access_as_user", apiBaseUrl: "/", redirectUri: "http://127.0.0.1:5173"
};

function AuthProbe({ callbacks, renders }: { callbacks: Array<() => Promise<string>>; renders: number[] }) {
  const auth = useAuth();
  callbacks.push(auth.getAccessToken);
  renders.push(1);
  return <div data-testid="roles">{auth.roles.join(",")}</div>;
}

describe("AuthProvider token callback stability", () => {
  beforeEach(() => {
    activeAccountId.value = "home-1";
    tokenRoles.value = ["admin"];
    vi.mocked(msalState.instance.acquireTokenSilent).mockClear();
    vi.mocked(msalState.instance.setActiveAccount).mockClear();
  });

  it("keeps the callback stable and only updates role state when claims change", async () => {
    const callbacks: Array<() => Promise<string>> = [];
    const renders: number[] = [];
    function Probe() {
      const auth = useAuth();
      callbacks.push(auth.getAccessToken);
      renders.push(1);
      return <div data-testid="roles">{auth.roles.join(",")}</div>;
    }

    render(<AuthProvider config={config}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("roles")).toHaveTextContent("admin"));
    expect(callbacks.length).toBeGreaterThan(1);
    expect(callbacks.every((callback) => callback === callbacks[0])).toBe(true);

    tokenRoles.value = ["viewer"];
    await act(async () => { await callbacks.at(-1)!(); });
    expect(screen.getByTestId("roles")).toHaveTextContent("viewer");
    expect(callbacks.every((callback) => callback === callbacks[0])).toBe(true);

    const renderCount = renders.length;
    await act(async () => { await callbacks.at(-1)!(); });
    expect(renders).toHaveLength(renderCount);
    expect(vi.mocked(msalState.instance.acquireTokenSilent)).toHaveBeenCalled();
  });

  it("switches token acquisition to the currently active account", async () => {
    const { rerender } = render(<AuthProvider config={config}><AuthProbe callbacks={[]} renders={[]} /></AuthProvider>);
    await waitFor(() => expect(vi.mocked(msalState.instance.acquireTokenSilent)).toHaveBeenCalled());
    activeAccountId.value = "home-2";
    rerender(<AuthProvider config={config}><AuthProbe callbacks={[]} renders={[]} /></AuthProvider>);
    await waitFor(() => {
      const lastCall = vi.mocked(msalState.instance.acquireTokenSilent).mock.calls.at(-1)?.[0];
      expect(lastCall?.account.homeAccountId).toBe("home-2");
    });
  });
});
