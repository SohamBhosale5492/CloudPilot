import { useState, type FormEvent } from "react";
import { useApi } from "../api/ApiProvider";
import { getErrorMessage } from "../api/client";

interface Props {
  projectId: string;
  currentUrl: string | null;
  canUpdate: boolean;
  onSaved(): void;
}

function displayReference(value: string | null): { owner: string; name: string } | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return null;
    const owner = parts[0];
    const name = parts[1];
    if (!owner || !name) return null;
    return { owner, name: name.replace(/\.git$/, "") };
  } catch { return null; }
}

export function GitHubRepositoryPanel({ projectId, currentUrl, canUpdate, onSaved }: Props) {
  const api = useApi();
  const [urlState, setUrlState] = useState(() => ({ projectId, currentUrl, value: normalizedReference(currentUrl) }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reference = displayReference(currentUrl);
  if (urlState.projectId !== projectId || urlState.currentUrl !== currentUrl) {
    setUrlState({ projectId, currentUrl, value: normalizedReference(currentUrl) });
  }
  const url = urlState.projectId === projectId && urlState.currentUrl === currentUrl
    ? urlState.value
    : normalizedReference(currentUrl);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try { await api.configureGitHubRepository(projectId, url); onSaved(); }
    catch (cause) { setError(getErrorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try { await api.disconnectGitHubRepository(projectId); setUrlState({ projectId, currentUrl: null, value: "" }); onSaved(); }
    catch (cause) { setError(getErrorMessage(cause)); }
    finally { setBusy(false); }
  }

  return <section className="surface-panel" aria-labelledby="github-repository-heading">
    <div className="section-heading"><div><h2 id="github-repository-heading">GitHub repository</h2>
      {reference ? <p>Repository reference: <strong>{reference.owner}/{reference.name}</strong> · access not verified</p> :
        <p>{currentUrl ? "A repository reference is stored but cannot be safely displayed." : "No repository reference is configured."}</p>}
    </div></div>
    <div className="alert alert-info" role="note">
      This saves repository metadata only. CloudPilot has not checked repository access or installed a GitHub App. No token is requested or stored here. The current remediation worker uses a server-wide GitHub credential rather than an organization-specific installation, so this reference is not an authorized GitHub connection.
    </div>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    {canUpdate ? <>
      <form onSubmit={(event) => void save(event)}>
        <label className="form-label" htmlFor="github-repository-url">HTTPS GitHub repository URL</label>
        <div className="input-group"><input id="github-repository-url" className="form-control" type="url" required maxLength={512}
          placeholder="https://github.com/owner/repository" value={url} onChange={(event) => setUrlState({ projectId, currentUrl, value: event.target.value })} />
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save repository reference"}</button>
        </div>
      </form>
      {currentUrl && <button className="btn btn-outline-danger mt-2" type="button" onClick={() => void disconnect()} disabled={busy}>Disconnect repository reference</button>}
    </> : <p className="text-muted mb-0">Your current role does not have project:update permission to change this repository reference.</p>}
  </section>;
}

function normalizedReference(value: string | null): string {
  const parsed = displayReference(value);
  return parsed ? `https://github.com/${parsed.owner}/${parsed.name}` : "";
}
