import { useEffect, useState } from "react";
import { useApi } from "../api/ApiProvider";
import { getErrorMessage } from "../api/client";

type Organization = { id: string; displayName: string; role: string };
type Installation = { id: string; accountLogin: string; accountType: string; status: string };
type Repository = { id: string; fullName: string; private: boolean; archived: boolean; disabled: boolean };

export function OrganizationGitHubBindingPanel({ projectId }: { projectId: string }) {
  const api = useApi();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [installationId, setInstallationId] = useState("");
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repositoryId, setRepositoryId] = useState("");
  const [repositoryPage, setRepositoryPage] = useState(1);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [binding, setBinding] = useState<{ id: string; installationRecordId: string; repositoryId: string; owner: string; name: string; status: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const organization = organizations.find((item) => item.id === organizationId);
  const canManage = organization?.role === "owner" || organization?.role === "admin";

  useEffect(() => {
    let active = true;
    void api.listOrganizations().then((page) => { if (active) setOrganizations(page.items); })
      .catch((cause: unknown) => { if (active) setError(getErrorMessage(cause)); });
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    if (!organizationId) return;
    let active = true;
    void Promise.all([api.listOrganizationInstallations(organizationId), api.getOrganizationProjectBinding(organizationId, projectId)])
      .then(([result, current]) => { if (active) { setInstallations(result.installations); setBinding(current.binding); } })
      .catch((cause: unknown) => { if (active) setError(getErrorMessage(cause)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api, organizationId, projectId]);

  useEffect(() => {
    if (!organizationId || !installationId) return;
    let active = true;
    void api.listInstallationRepositories(organizationId, installationId, repositoryPage)
      .then((result) => { if (active) { setRepositories(result.repositories); setHasNextPage(result.hasNextPage); } })
      .catch((cause: unknown) => { if (active) setError(getErrorMessage(cause)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api, organizationId, installationId, repositoryPage]);

  async function bind() {
    if (!organizationId || !installationId || !repositoryId || !canManage) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.bindOrganizationProjectRepository(organizationId, projectId, installationId, repositoryId);
      const current = await api.getOrganizationProjectBinding(organizationId, projectId);
      setBinding(current.binding); setNotice("The organization-scoped repository binding is active and verified.");
    } catch (cause) { setError(getErrorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    if (!organizationId || !canManage) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.disconnectOrganizationProjectRepository(organizationId, projectId);
      setBinding(null); setNotice("The organization-scoped repository binding was disconnected.");
    } catch (cause) { setError(getErrorMessage(cause)); }
    finally { setBusy(false); }
  }

  return <section className="surface-panel" aria-labelledby="org-github-binding-heading">
    <div className="section-heading"><div><h2 id="org-github-binding-heading">Organization GitHub binding</h2>
      <p>Uses an active organization installation and immutable GitHub repository ID. This is separate from the legacy repository URL field.</p></div></div>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    {notice && <div className="alert alert-success" role="status">{notice}</div>}
    <label className="form-label" htmlFor="binding-organization">Organization</label>
    <select id="binding-organization" className="form-select mb-3" value={organizationId} onChange={(event) => {
      setOrganizationId(event.target.value); setInstallationId(""); setInstallations([]); setBinding(null);
      setRepositories([]); setRepositoryId(""); setRepositoryPage(1); setHasNextPage(false); setError(null);
    }}>
      <option value="">Select an organization…</option>{organizations.map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.role}</option>)}
    </select>
    {binding && <p role="status">Current binding: <strong>{binding.owner}/{binding.name}</strong> · {binding.status} · repository ID {binding.repositoryId}</p>}
    {organizationId && !busy && installations.length === 0 && <p className="text-muted">No active GitHub App installation is available for this organization.</p>}
    {canManage && installations.length > 0 && <>
      <label className="form-label" htmlFor="binding-installation">GitHub installation</label>
      <select id="binding-installation" className="form-select mb-3" value={installationId} onChange={(event) => {
        setInstallationId(event.target.value); setRepositories([]); setRepositoryId(""); setRepositoryPage(1); setHasNextPage(false); setError(null);
      }}>
        <option value="">Select an installation…</option>{installations.filter((item) => item.status === "active").map((item) =>
          <option key={item.id} value={item.id}>{item.accountLogin} ({item.accountType})</option>)}
      </select>
      {installationId && <>
        <label className="form-label" htmlFor="binding-repository">Repository</label>
        <select id="binding-repository" className="form-select mb-2" value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>
          <option value="">Select a repository…</option>{repositories.filter((item) => !item.archived && !item.disabled).map((item) =>
            <option key={item.id} value={item.id}>{item.fullName}{item.private ? " · private" : ""}</option>)}
        </select>
        <div className="d-flex gap-2">
          <button className="btn btn-primary" disabled={busy || !repositoryId} onClick={() => void bind()}>{busy ? "Verifying…" : "Verify and bind repository"}</button>
          {hasNextPage && <button className="btn btn-outline-secondary" disabled={busy} onClick={() => setRepositoryPage((page) => page + 1)}>Next repositories</button>}
          {binding && <button className="btn btn-outline-danger" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>}
        </div>
      </>}
    </>}
    {organizationId && !canManage && <p className="text-muted">Only an organization owner or admin can manage GitHub repository bindings.</p>}
  </section>;
}
