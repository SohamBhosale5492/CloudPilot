import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { PublicClientApplication, type IPublicClientApplication } from "@azure/msal-browser";
import { MsalProvider } from "@azure/msal-react";
import { BrowserRouter } from "react-router-dom";
import "bootstrap/dist/css/bootstrap.min.css";
import "./styles/app.css";
import { ApiProvider } from "./api/ApiProvider";
import { App } from "./app/App";
import { AuthProvider } from "./auth/AuthProvider";
import { createMsalConfiguration, readFrontendConfig } from "./auth/config";

let initialization: Promise<IPublicClientApplication> | undefined;

function initializeMsal(config: NonNullable<ReturnType<typeof readFrontendConfig>["config"]>): Promise<IPublicClientApplication> {
  initialization ??= (async () => {
    const client = new PublicClientApplication(createMsalConfiguration(config));
    await client.initialize();
    const result = await client.handleRedirectPromise();
    if (result?.account) client.setActiveAccount(result.account);
    else {
      const firstAccount = client.getAllAccounts().at(0);
      if (!client.getActiveAccount() && firstAccount) client.setActiveAccount(firstAccount);
    }
    return client;
  })();
  return initialization;
}

function SetupNotice({ errors }: { errors: string[] }) {
  return <main className="setup-screen"><section className="setup-panel"><div className="brand-mark">CP</div><p className="eyebrow">FRONTEND CONFIGURATION</p><h1>Complete Microsoft sign-in setup</h1>
    <p>Authentication is unavailable until the required Vite environment variables are configured. This application does not include mock sign-in.</p>
    <ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul><p className="small text-body-secondary">Copy <code>frontend/.env.example</code> to <code>frontend/.env.local</code>, set the values, and restart Vite.</p></section></main>;
}

function StartupFailure({ message }: { message: string }) {
  return <main className="setup-screen"><section className="setup-panel"><h1>CloudPilot could not start</h1><p role="alert">{message}</p></section></main>;
}

function ReadyApp({ instance, config }: { instance: IPublicClientApplication; config: NonNullable<ReturnType<typeof readFrontendConfig>["config"]> }) {
  return <MsalProvider instance={instance}><BrowserRouter><AuthProvider config={config}><ApiProvider config={config}><App /></ApiProvider></AuthProvider></BrowserRouter></MsalProvider>;
}

function Root() {
  const configResult = useMemo(() => readFrontendConfig(import.meta.env, window.location.origin), []);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [instance, setInstance] = useState<IPublicClientApplication | null>(null);
  useEffect(() => {
    if (!configResult.config) return;
    let active = true;
    void initializeMsal(configResult.config).then((client) => { if (active) setInstance(client); })
      .catch(() => { if (active) setStartupError("Microsoft authentication initialization failed. Verify the Entra application and redirect URI settings."); });
    return () => { active = false; };
  }, [configResult.config]);
  if (!configResult.config) return <SetupNotice errors={configResult.errors} />;
  if (startupError) return <StartupFailure message={startupError} />;
  if (!instance) return <main className="setup-screen"><section className="setup-panel"><div className="spinner-border text-primary" role="status"><span className="visually-hidden">Starting</span></div><p className="mt-3">Initializing Microsoft sign-in…</p></section></main>;
  return <ReadyApp instance={instance} config={configResult.config} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
