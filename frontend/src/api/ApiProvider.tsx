import { createContext, useContext, useMemo, type ReactNode } from "react";
import { CloudPilotApi, createApiClient } from "./client";
import { useAuth } from "../auth/AuthProvider";
import type { FrontendConfig } from "../auth/config";

const ApiContext = createContext<CloudPilotApi | null>(null);

export function ApiProvider({ config, children }: { config: FrontendConfig; children: ReactNode }) {
  const { getAccessToken } = useAuth();
  const api = useMemo(
    () => new CloudPilotApi(createApiClient(config.apiBaseUrl, getAccessToken)),
    [config.apiBaseUrl, getAccessToken]
  );
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): CloudPilotApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi must be used inside ApiProvider.");
  return api;
}
