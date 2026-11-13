import {
  InteractionRequiredAuthError,
  type AccountInfo,
  type AuthenticationResult
} from "@azure/msal-browser";
import { useMsal } from "@azure/msal-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { FrontendConfig } from "./config";
import { readDisplayClaims } from "./token-claims";
import type { CloudPilotRole } from "./permissions";

interface AuthValue {
  account: AccountInfo | null;
  roles: CloudPilotRole[];
  loading: boolean;
  error: string | null;
  interactionRequired: boolean;
  getAccessToken: () => Promise<string>;
  signIn: () => Promise<void>;
  continueSignIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ config, children }: { config: FrontendConfig; children: ReactNode }) {
  const { instance, accounts, inProgress } = useMsal();
  const account = instance.getActiveAccount() ?? accounts[0] ?? null;
  const [roleSnapshot, setRoleSnapshot] = useState<{ accountId: string; roles: CloudPilotRole[] } | null>(null);
  const roles = useMemo(() => roleSnapshot && account && roleSnapshot.accountId === account.homeAccountId ? roleSnapshot.roles : [], [account, roleSnapshot]);
  const [settledAccountId, setSettledAccountId] = useState<string | null>(null);
  const loading = Boolean(account && settledAccountId !== account.homeAccountId);
  const [error, setError] = useState<string | null>(null);
  const [interactionRequired, setInteractionRequired] = useState(false);
  const accountId = account?.homeAccountId;

  const updateFromResult = useCallback((result: AuthenticationResult) => {
    if (result.account) {
      instance.setActiveAccount(result.account);
      const nextRoles = readDisplayClaims(result.accessToken).roles;
      setRoleSnapshot((current) => current?.accountId === result.account!.homeAccountId &&
        current.roles.length === nextRoles.length && current.roles.every((role) => nextRoles.includes(role))
        ? current
        : { accountId: result.account!.homeAccountId, roles: nextRoles });
    }
    setInteractionRequired(false);
    setError(null);
  }, [instance]);

  const getAccessToken = useCallback(async (): Promise<string> => {
    const activeAccount = instance.getActiveAccount() ??
      (accountId ? instance.getAllAccounts().find((candidate) => candidate.homeAccountId === accountId) : undefined) ??
      instance.getAllAccounts()[0];
    if (!activeAccount) throw new Error("Sign in with Microsoft to access CloudPilot.");
    try {
      const result = await instance.acquireTokenSilent({ account: activeAccount, scopes: [config.apiScope] });
      updateFromResult(result);
      return result.accessToken;
    } catch (reason) {
      if (reason instanceof InteractionRequiredAuthError) setInteractionRequired(true);
      throw reason;
    }
  }, [accountId, config.apiScope, instance, updateFromResult]);

  useEffect(() => {
    if (account && !instance.getActiveAccount()) instance.setActiveAccount(account);
  }, [account, instance]);

  useEffect(() => {
    if (!account || inProgress !== "none") return;
    let alive = true;
    void instance.acquireTokenSilent({ account, scopes: [config.apiScope] })
      .then((result) => { if (alive) updateFromResult(result); })
      .catch((reason: unknown) => {
        if (!alive) return;
        if (reason instanceof InteractionRequiredAuthError) setInteractionRequired(true);
        else setError("CloudPilot could not obtain an API access token. Check the Entra client and API scope configuration.");
      })
      .finally(() => { if (alive) setSettledAccountId(account.homeAccountId); });
    return () => { alive = false; };
  }, [account, config.apiScope, inProgress, instance, updateFromResult]);

  useEffect(() => {
    const handleUnauthorized = () => {
      setError("Your access token was rejected. Sign in again or ask an administrator to verify your Entra configuration.");
    };
    window.addEventListener("cloudpilot:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("cloudpilot:unauthorized", handleUnauthorized);
  }, []);

  const signIn = useCallback(async () => {
    setError(null);
    await instance.loginRedirect({ scopes: [config.apiScope] });
  }, [config.apiScope, instance]);

  const continueSignIn = useCallback(async () => {
    if (!account) return signIn();
    setError(null);
    try {
      const result = await instance.acquireTokenSilent({ account, scopes: [config.apiScope] });
      updateFromResult(result);
    } catch (reason) {
      if (reason instanceof InteractionRequiredAuthError) {
        await instance.acquireTokenRedirect({ account, scopes: [config.apiScope] });
        return;
      }
      setError("CloudPilot could not acquire the configured API access token.");
    }
  }, [account, config.apiScope, instance, signIn, updateFromResult]);

  const signOut = useCallback(async () => {
    const activeAccount = instance.getActiveAccount() ?? account;
    setRoleSnapshot(null);
    await instance.logoutRedirect({ account: activeAccount, postLogoutRedirectUri: config.redirectUri });
  }, [account, config.redirectUri, instance]);

  const value = useMemo<AuthValue>(() => ({
    account, roles, loading, error, interactionRequired, getAccessToken, signIn, continueSignIn, signOut
  }), [account, continueSignIn, error, getAccessToken, interactionRequired, loading, roles, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider.");
  return value;
}
