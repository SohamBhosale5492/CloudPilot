import { useCallback, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../api/ApiProvider";
import { getErrorMessage } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { hasPermission } from "../auth/permissions";
import { CursorPager } from "../components/CursorPager";
import { EmptyState, ErrorState, Loading } from "../components/Feedback";
import { useCursorPage } from "../hooks/useCursorPage";
import { DataTable, PageHeading } from "../layouts/AppShell";
import { formatDate } from "../utils/format";
import type { ExpectedObservabilityModel, ProjectTargetConfig } from "../types/api";

const DEMO_MODEL: ExpectedObservabilityModel = {
  schemaVersion: "cloudpilot.expected-observability.v1",
  serviceId: "demo-service",
  requirements: [{
    id: "demo-request-metric",
    signal: "metric",
    metricName: "demo_http_server_requests_total",
    dimensions: ["method", "route", "status_code"]
  }]
};

const DEMO_TARGET_CONFIG: ProjectTargetConfig = {
  prometheusBaseUrl: "http://127.0.0.1:9090",
  metricConfigs: {
    "demo-request-metric": {
      serviceName: "demo-service",
      route: "/api/demo",
      method: "GET",
      minimumCount: 1,
      maxEvidenceAgeMs: 60000
    }
  }
};

function parseProjectJson<T>(value: string, label: string): T {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`${label} must be valid JSON.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as T;
}

function validateExpectedModel(value: ExpectedObservabilityModel): void {
  if (value.schemaVersion !== "cloudpilot.expected-observability.v1" ||
      typeof value.serviceId !== "string" || !value.serviceId.trim() ||
      !Array.isArray(value.requirements) || value.requirements.length === 0 ||
      value.requirements.some((item) => !item || typeof item.id !== "string" || !item.id.trim() ||
        !["metric", "log", "trace", "health", "alert"].includes(item.signal))) {
    throw new Error("Expected model must use the supported schema version and contain at least one identified requirement.");
  }
}

export function ProjectsPage() {
  const api = useApi();
  const { roles } = useAuth();
  const canCreate = hasPermission(roles, "project:create");
  const load = useCallback((cursor: string | undefined, signal: AbortSignal) => api.listProjects({ cursor, signal }), [api]);
  const page = useCursorPage("projects", load);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [expectedModelJson, setExpectedModelJson] = useState(() => JSON.stringify(DEMO_MODEL, null, 2));
  const [targetConfigJson, setTargetConfigJson] = useState(() => JSON.stringify(DEMO_TARGET_CONFIG, null, 2));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("name") ?? "").trim();
    const repositoryUrl = String(form.get("repositoryUrl") ?? "").trim();
    setFormError(null);
    let expectedModel: ExpectedObservabilityModel;
    let targetConfig: ProjectTargetConfig;
    try {
      expectedModel = parseProjectJson<ExpectedObservabilityModel>(expectedModelJson, "Expected observability model");
      validateExpectedModel(expectedModel);
      targetConfig = parseProjectJson<ProjectTargetConfig>(targetConfigJson, "Telemetry target configuration");
    } catch (error) {
      setFormError(getErrorMessage(error));
      return;
    }
    setSaving(true);
    try {
      await api.createProject({ name, ...(repositoryUrl ? { repositoryUrl } : {}), expectedModel, targetConfig });
      formElement.reset();
      setExpectedModelJson(JSON.stringify(DEMO_MODEL, null, 2));
      setTargetConfigJson(JSON.stringify(DEMO_TARGET_CONFIG, null, 2));
      setShowForm(false);
      page.refresh();
    } catch (error) {
      setFormError(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return <>
    <PageHeading title="Projects" description="Repositories and observability targets registered for your tenant."
      actions={canCreate ? <button className="btn btn-primary" onClick={() => setShowForm((value) => !value)}>{showForm ? "Close" : "New project"}</button> : undefined} />
    {showForm && <section className="surface-panel project-create-panel">
      <h2>Register a project</h2>
      <p className="text-muted">The starter configuration evaluates the real Phase 01 demo metric in local Prometheus. Edit it to match your service and telemetry endpoints. A repository URL is used by remediation; it does not itself authenticate GitHub.</p>
      <form onSubmit={(event) => void submit(event)}>
        <div className="row g-3">
          <div className="col-md-5"><label className="form-label" htmlFor="project-name">Project name</label><input id="project-name" className="form-control" name="name" maxLength={100} required /></div>
          <div className="col-md-7"><label className="form-label" htmlFor="repository-url">Repository URL <span className="text-muted">(optional)</span></label><input id="repository-url" className="form-control" name="repositoryUrl" type="url" placeholder="https://github.com/org/repository" /></div>
        </div>
        <div className="row g-3 mt-1">
          <div className="col-lg-6"><label className="form-label" htmlFor="expected-model">Expected observability model (JSON)</label><textarea id="expected-model" className="form-control font-monospace" rows={14} value={expectedModelJson} onChange={(event) => setExpectedModelJson(event.target.value)} spellCheck={false} required /></div>
          <div className="col-lg-6"><label className="form-label" htmlFor="target-config">Telemetry target configuration (JSON)</label><textarea id="target-config" className="form-control font-monospace" rows={14} value={targetConfigJson} onChange={(event) => setTargetConfigJson(event.target.value)} spellCheck={false} required /></div>
        </div>
        {formError && <div className="alert alert-danger mt-3 mb-0" role="alert">{formError}</div>}
        <div className="form-actions"><button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Create project"}</button><button className="btn btn-outline-secondary" type="button" onClick={() => setShowForm(false)}>Cancel</button></div>
      </form>
    </section>}
    {page.error && <ErrorState error={page.error} onRetry={page.refresh} />}
    {page.loading && !page.page ? <Loading label="Loading projects" /> : page.page?.items.length === 0 ?
      <EmptyState title="No projects on this page" detail={page.canGoBack ? "This cursor page returned no projects." : "Register a project to begin collecting scan results."} /> :
      page.page && <DataTable><thead><tr><th>Name</th><th>Repository</th><th>Created</th><th><span className="visually-hidden">Open</span></th></tr></thead>
        <tbody>{page.page.items.map((project) => <tr key={project.id}>
          <td><Link className="table-primary-link" to={`/projects/${encodeURIComponent(project.id)}`}>{project.name}</Link></td>
          <td>{project.repositoryUrl ? <a href={project.repositoryUrl} target="_blank" rel="noreferrer">{project.repositoryUrl}</a> : <span className="text-muted">Not connected</span>}</td>
          <td>{formatDate(project.createdAt)}</td><td><Link className="btn btn-sm btn-outline-secondary" to={`/projects/${encodeURIComponent(project.id)}`}>Open</Link></td>
        </tr>)}</tbody>
      </DataTable>}
    {page.page && <CursorPager hasMore={page.page.hasMore} canGoBack={page.canGoBack} loading={page.loading} onPrevious={page.previous} onNext={page.next} />}
  </>;
}
