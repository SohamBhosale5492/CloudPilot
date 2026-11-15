import { useEffect, useState, type FormEvent } from "react";
import { useApi } from "../api/ApiProvider";
import { ApiError, getErrorMessage } from "../api/client";
import { readGitHubInstallationReturn, redirectToGitHubInstallation, storeGitHubInstallationReturn } from "../github/installation-flow";

type Organization = { id: string; displayName: string; role: string };
type Installation = { id: string; accountLogin: string; accountType: string; status: string };
type Repository = { id: string; fullName: string; private: boolean; archived: boolean; disabled: boolean };

function isNotFoundError(cause: unknown): boolean {
  if (cause instanceof ApiError) return cause.status === 404;
  return Boolean(cause && typeof cause === "object" && "status" in cause && (cause as { status?: unknown }).status === 404);
}

export function OrganizationGitHubBindingPanel({ projectId }: { projectId: string }) {
  const api = useApi();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationsLoading, setOrganizationsLoading] = useState(true);
  const [organizationsLoadFailed, setOrganizationsLoadFailed] = useState(false);
  const [organizationId, setOrganizationId] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [creatingOrganization, setCreatingOrganization] = useState(false);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [installationId, setInstallationId] = useState("");
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repositoryId, setRepositoryId] = useState("");
  const [repositoryPage, setRepositoryPage] = useState(1);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [binding, setBinding] = useState<{ id: string; installationRecordId: string; repositoryId: string; owner: string; name: string; status: string } | null>(null);
  const [needsAdoption, setNeedsAdoption] = useState(false);
  const [pendingAdoptionId, setPendingAdoptionId] = useState<string | null>(null);
  const [adoptingProject, setAdoptingProject] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connectingGitHub, setConnectingGitHub] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const organization = organizations.find((item) => item.id === organizationId);
  const canManage = organization?.role === "owner" || organization?.role === "admin";
  const activeInstallations = installations.filter((item) => item.status === "active");

  useEffect(() => {
    let active = true;
    void api.listOrganizations().then((page) => {
      if (!active) return;
      setOrganizations(page.items);
      const continuation = readGitHubInstallationReturn();
      if (continuation && page.items.some((item) => item.id === continuation.organizationId)) {
        setOrganizationId(continuation.organizationId);
        readGitHubInstallationReturn(true);
      }
    })
      .catch((cause: unknown) => { if (active) { setError(getErrorMessage(cause)); setOrganizationsLoadFailed(true); } })
      .finally(() => { if (active) setOrganizationsLoading(false); });
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    if (!organizationId) return;
    let active = true;
    void (async () => {
      await Promise.resolve();
      if (!active) return;
      setBusy(true);
      setNeedsAdoption(false);
      setPendingAdoptionId(null);
      const [installationsResult, bindingResult] = await Promise.allSettled([
        api.listOrganizationInstallations(organizationId),
        api.getOrganizationProjectBinding(organizationId, projectId)
      ]);
      if (!active) return;
      if (installationsResult.status === "fulfilled") {
        setInstallations(installationsResult.value.installations);
      } else {
        setInstallations([]);
        setError(getErrorMessage(installationsResult.reason));
      }

      if (bindingResult.status === "fulfilled") {
        setBinding(bindingResult.value.binding);
        setNeedsAdoption(false);
      } else {
        setBinding(null);
        if (isNotFoundError(bindingResult.reason)) {
          setNeedsAdoption(true);
        } else if (installationsResult.status === "fulfilled") {
          setError(getErrorMessage(bindingResult.reason));
        }
      }
      if (active) setBusy(false);
    })();
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
  }, [api, organizationId, installationId, repositoryPage, needsAdoption]);

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const displayName = organizationName.normalize("NFC").trim();
    const hasControlChar = [...displayName].some((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    });
    if (!displayName || [...displayName].length > 120 || hasControlChar) {
      setError("Organization name must contain 1 to 120 printable characters.");
      return;
    }
    setCreatingOrganization(true); setError(null); setNotice(null);
    try {
      const result = await api.createOrganization(displayName, globalThis.crypto.randomUUID());
      const created = { id: result.organization.id, displayName: result.organization.displayName, role: result.membership.role };
      try {
        const page = await api.listOrganizations();
        setOrganizations(page.items.some((item) => item.id === created.id) ? page.items : [created, ...page.items]);
        setOrganizationsLoadFailed(false);
      } catch (cause) {
        setOrganizations([created]);
        setError(`Organization was created, but the list could not be refreshed: ${getErrorMessage(cause)}`);
      }
      setOrganizationId(created.id); setInstallationId(""); setRepositories([]); setRepositoryId(""); setBinding(null);
      setNeedsAdoption(false); setPendingAdoptionId(null);
      setOrganizationName(""); setNotice(`Organization “${created.displayName}” created. You are an ${created.role}.`);
    } catch (cause) { setError(getErrorMessage(cause)); }
    finally { setCreatingOrganization(false); }
  }

  async function requestAdoption() {
    if (!organizationId || !canManage) return;
    setAdoptingProject(true); setError(null); setNotice(null);
    try {
      const candidateKey = `adopt:${organizationId}:${projectId}`;
      const idempotencyKey = /^[A-Za-z0-9._:-]{1,128}$/.test(candidateKey)
        ? candidateKey
        : globalThis.crypto.randomUUID();
      const result = await api.requestProjectAdoption(organizationId, projectId, idempotencyKey);
      if (result.adoption.status === "approved") {
        setPendingAdoptionId(null);
        setNeedsAdoption(false);
        const current = await api.getOrganizationProjectBinding(organizationId, projectId);
        setBinding(current.binding);
        setNotice("Project adoption is approved for this organization.");
      } else {
        setPendingAdoptionId(result.adoption.id);
        setNotice("Project adoption requested. Approve the adoption to assign this project to the organization.");
      }
    } catch (cause) { setError(getErrorMessage(cause)); }
    finally { setAdoptingProject(false); }
  }

  async function approveAdoption() {
    if (!organizationId || !pendingAdoptionId || !canManage) return;
    setAdoptingProject(true); setError(null); setNotice(null);
    try {
      await api.decideProjectAdoption(organizationId, pendingAdoptionId, projectId, "approve");
      setPendingAdoptionId(null);
      setNeedsAdoption(false);
      const current = await api.getOrganizationProjectBinding(organizationId, projectId);
      setBinding(current.binding);
      setNotice("Project adoption approved. You can now bind a GitHub repository.");
    } catch (cause) { setError(getErrorMessage(cause)); }
    finally { setAdoptingProject(false); }
  }

  async function bind() {
    if (!organizationId || !installationId || !repositoryId || !canManage || needsAdoption) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.bindOrganizationProjectRepository(organizationId, projectId, installationId, repositoryId);
      const current = await api.getOrganizationProjectBinding(organizationId, projectId);
      setBinding(current.binding); setNotice("The organization-scoped repository binding is active and verified.");
    } catch (cause) { setError(getErrorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function connectGitHubApp() {
    if (!organizationId || !canManage) return;
    setBusy(true); setConnectingGitHub(true); setError(null); setNotice(null);
    try {
      const intent = await api.startGitHubInstallation(organizationId);
      storeGitHubInstallationReturn({ projectPath: `/projects/${encodeURIComponent(projectId)}`, organizationId });
      redirectToGitHubInstallation(intent.installationUrl, intent.state);
    } catch (cause) { setError(getErrorMessage(cause)); }
    finally { setBusy(false); setConnectingGitHub(false); }
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
    <select id="binding-organization" className="form-select mb-3" value={organizationId} disabled={organizationsLoading || organizationsLoadFailed} onChange={(event) => {
      setOrganizationId(event.target.value); setInstallationId(""); setInstallations([]); setBinding(null);
      setNeedsAdoption(false); setPendingAdoptionId(null);
      setRepositories([]); setRepositoryId(""); setRepositoryPage(1); setHasNextPage(false); setError(null);
    }}>
      <option value="">Select an organization…</option>{organizations.map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.role}</option>)}
    </select>
    {organizationsLoading && <p role="status">Loading organizations…</p>}
    {!organizationsLoading && !organizationsLoadFailed && organizations.length === 0 && <form onSubmit={(event) => void createOrganization(event)}>
      <p>You do not belong to an organization yet. Create one to continue with GitHub repository binding.</p>
      <label className="form-label" htmlFor="new-organization-name">Organization name</label>
      <input id="new-organization-name" className="form-control mb-2" value={organizationName} maxLength={120}
        onChange={(event) => setOrganizationName(event.target.value)} autoComplete="organization" />
      <button className="btn btn-primary mb-3" type="submit" disabled={creatingOrganization}>
        {creatingOrganization ? "Creating organization…" : "Create organization"}
      </button>
    </form>}
    {binding && <p role="status">Current binding: <strong>{binding.owner}/{binding.name}</strong> · {binding.status} · repository ID {binding.repositoryId}</p>}
    {organizationId && !busy && needsAdoption && canManage && <div className="mb-3">
      <p className="text-muted mb-2">
        {pendingAdoptionId
          ? "Project adoption request is pending approval for this organization."
          : "This project is not yet adopted into the selected organization. Adopt the project to enable repository binding."}
      </p>
      {!pendingAdoptionId ? (
        <button type="button" className="btn btn-outline-primary" disabled={adoptingProject || busy} onClick={() => void requestAdoption()}>
          {adoptingProject ? "Requesting adoption…" : "Request project adoption"}
        </button>
      ) : (
        <button type="button" className="btn btn-primary" disabled={adoptingProject || busy} onClick={() => void approveAdoption()}>
          {adoptingProject ? "Approving adoption…" : "Approve project adoption"}
        </button>
      )}
    </div>}
    {organizationId && !busy && activeInstallations.length === 0 && <p className="text-muted">No active GitHub App installation is available for this organization.</p>}
    {canManage && organizationId && !busy && activeInstallations.length === 0 && <button type="button" className="btn btn-outline-primary mb-3"
      disabled={connectingGitHub} onClick={() => void connectGitHubApp()}>
      {connectingGitHub ? "Starting GitHub connection…" : "Connect GitHub App"}
    </button>}
    {canManage && activeInstallations.length > 0 && <>
      <label className="form-label" htmlFor="binding-installation">GitHub installation</label>
      <select id="binding-installation" className="form-select mb-3" value={installationId} onChange={(event) => {
        setInstallationId(event.target.value); setRepositories([]); setRepositoryId(""); setRepositoryPage(1); setHasNextPage(false); setError(null);
      }}>
        <option value="">Select an installation…</option>{activeInstallations.map((item) =>
          <option key={item.id} value={item.id}>{item.accountLogin} ({item.accountType})</option>)}
      </select>
      {installationId && <>
        <label className="form-label" htmlFor="binding-repository">Repository</label>
        <select id="binding-repository" className="form-select mb-2" value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>
          <option value="">Select a repository…</option>{repositories.filter((item) => !item.archived && !item.disabled).map((item) =>
            <option key={item.id} value={item.id}>{item.fullName}{item.private ? " · private" : ""}</option>)}
        </select>
        <div className="d-flex gap-2">
          <button className="btn btn-primary" disabled={busy || adoptingProject || needsAdoption || !repositoryId} onClick={() => void bind()}>{busy ? "Verifying…" : "Verify and bind repository"}</button>
          {hasNextPage && <button className="btn btn-outline-secondary" disabled={busy} onClick={() => setRepositoryPage((page) => page + 1)}>Next repositories</button>}
          {binding && <button className="btn btn-outline-danger" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>}
        </div>
      </>}
    </>}
    {organizationId && !canManage && <p className="text-muted">Only an organization owner or admin can manage GitHub repository bindings.</p>}
  </section>;
}
