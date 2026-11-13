import { useEffect, useRef, useState } from "react";
import { useApi } from "../api/ApiProvider";
import { getErrorMessage } from "../api/client";
import { useAuth } from "../auth/AuthProvider";

type CallbackParameters =
  | { valid: true; installationId: string; state: string; setupAction: "install" }
  | { valid: false };

function readCallbackParameters(search: string): CallbackParameters {
  const params = new URLSearchParams(search);
  if ([...params.keys()].some((name) => !["installation_id", "state", "setup_action"].includes(name))) {
    return { valid: false };
  }
  const installationIds = params.getAll("installation_id");
  const states = params.getAll("state");
  const actions = params.getAll("setup_action");
  const installationId = installationIds[0];
  const state = states[0];
  const setupAction = actions[0];
  if (installationIds.length !== 1 || states.length !== 1 || actions.length !== 1 ||
      typeof installationId !== "string" || typeof state !== "string" || typeof setupAction !== "string" ||
      !/^[1-9]\d{0,18}$/.test(installationId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) || setupAction !== "install") {
    return { valid: false };
  }
  try {
    const parsedInstallationId = BigInt(installationId);
    if (parsedInstallationId > 9_223_372_036_854_775_807n) return { valid: false };
  } catch { return { valid: false }; }
  return { valid: true, installationId, state, setupAction: "install" };
}

export function GitHubInstallationCallbackPage() {
  const api = useApi();
  const { account, loading } = useAuth();
  const [callback] = useState<CallbackParameters>(() => readCallbackParameters(window.location.search));
  const [status, setStatus] = useState<"waiting" | "sending" | "connected" | "error" | "signed-out">("waiting");
  const [message, setMessage] = useState("");
  const [retryCount, setRetryCount] = useState(0);
  const clearedUrl = useRef(false);
  const attempted = useRef(false);
  const displayStatus = status === "waiting" && !loading && !callback.valid
    ? "error"
    : status === "waiting" && !loading && !account ? "signed-out"
      : status === "waiting" && !loading && account ? "sending" : status;
  const displayMessage = status === "waiting" && !loading && !callback.valid
    ? "GitHub returned invalid installation callback parameters. Restart the connection from CloudPilot."
    : status === "waiting" && !loading && !account
      ? "A CloudPilot sign-in is required. Sign in, then restart the GitHub App connection from CloudPilot."
      : status === "waiting" && !loading && account
        ? "Verifying the GitHub App installation with CloudPilot…"
      : message;

  useEffect(() => {
    if (clearedUrl.current) return;
    clearedUrl.current = true;
    // The callback state is retained only in this component's memory for the
    // authenticated POST; remove query parameters from the visible URL/history.
    window.history.replaceState(window.history.state, "", window.location.pathname);
  }, []);

  useEffect(() => {
    if (loading || status === "connected" || attempted.current) return;
    if (!callback.valid) {
      attempted.current = true;
      return;
    }
    if (!account) {
      return;
    }

    attempted.current = true;
    void api.completeGitHubInstallation({
      installationId: callback.installationId,
      state: callback.state,
      setupAction: callback.setupAction
    }).then((result) => {
      setStatus("connected");
      setMessage(result.alreadyConnected
        ? `GitHub App installation for ${result.accountLogin} is already connected.`
        : `GitHub App installation for ${result.accountLogin} was verified and connected.`);
    }).catch((error: unknown) => {
      setStatus("error");
      setMessage(getErrorMessage(error));
    });
  }, [account, api, callback, loading, retryCount, status]);

  function retry() {
    attempted.current = false;
    setStatus("waiting");
    setMessage("");
    setRetryCount((count) => count + 1);
  }

  return <main className="page-container"><section className="surface-panel" aria-labelledby="github-callback-heading">
    <h1 id="github-callback-heading">GitHub App installation</h1>
    {displayStatus === "sending" && <div className="spinner-border text-primary me-2" role="status"><span className="visually-hidden">Verifying installation</span></div>}
    {displayMessage && <div className={`alert ${displayStatus === "connected" ? "alert-success" : displayStatus === "error" || displayStatus === "signed-out" ? "alert-warning" : "alert-info"}`} role={displayStatus === "error" ? "alert" : "status"}>{displayMessage}</div>}
    {displayStatus === "error" && callback.valid && <button type="button" className="btn btn-outline-primary" onClick={retry}>Retry verification</button>}
    {displayStatus === "connected" && <p className="text-muted mb-0">CloudPilot confirmed the installation through GitHub and saved its organization association.</p>}
  </section></main>;
}
