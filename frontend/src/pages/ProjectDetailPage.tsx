import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useApi } from "../api/ApiProvider";
import { getErrorMessage } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { hasPermission } from "../auth/permissions";
import { CursorPager } from "../components/CursorPager";
import { ArchitectureDiscoveryPanel } from "../components/ArchitectureDiscoveryPanel";
import { SourceObservabilityPanel } from "../components/SourceObservabilityPanel";
import { TelemetryTargetConfigPanel } from "../components/TelemetryTargetConfigPanel";
import { GitHubRepositoryPanel } from "../components/GitHubRepositoryPanel";
import { OrganizationGitHubBindingPanel } from "../components/OrganizationGitHubBindingPanel";
import { EmptyState, ErrorState, Loading, NotFoundState } from "../components/Feedback";
import { StatusBadge } from "../components/StatusBadge";
import { useCursorPage } from "../hooks/useCursorPage";
import { DataTable, PageHeading } from "../layouts/AppShell";
import { formatDate } from "../utils/format";
import type { Project } from "../types/api";

export function ProjectDetailPage() {
  const { projectId = "" } = useParams();
  const api = useApi();
  const navigate = useNavigate();
  const { roles } = useAuth();
  const canDelete = hasPermission(roles, "project:delete");
  const canUpdate = hasPermission(roles, "project:update");
  const [projectResult, setProjectResult] = useState<{ projectId: string; project?: Project; error?: unknown } | null>(null);
  const currentProjectResult = projectResult?.projectId === projectId ? projectResult : null;
  const project = currentProjectResult?.project ?? null;
  const loadingProject = !currentProjectResult;
  const projectError = currentProjectResult?.error;
  const [scanError, setScanError] = useState<string | null>(null);
  const [startingScan, setStartingScan] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void api.getProject(projectId, { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) setProjectResult({ projectId, project: value });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setProjectResult({ projectId, error });
    });
    return () => controller.abort();
  }, [api, projectId]);

  const loadScans = useCallback((cursor: string | undefined, signal: AbortSignal) => api.listScans(projectId, { cursor, signal }), [api, projectId]);
  const scans = useCursorPage(projectId, loadScans);

  async function startScan() {
    setStartingScan(true);
    setScanError(null);
    try { await api.startScan(projectId); scans.refresh(); }
    catch (error) { setScanError(getErrorMessage(error)); }
    finally { setStartingScan(false); }
  }

  async function deleteProject() {
    if (!window.confirm(`Delete project “${project?.name}”? This action cannot be undone.`)) return;
    try { await api.deleteProject(projectId); navigate("/projects", { replace: true }); }
    catch (error) { setProjectResult({ projectId, error }); }
  }

  async function refreshProject() {
    const refreshed = await api.getProject(projectId);
    setProjectResult({ projectId, project: refreshed });
  }

  if (loadingProject) return <Loading label="Loading project" />;
  if (projectError) return <ErrorState error={projectError} />;
  if (!project) return <NotFoundState label="Project" />;

  return <>
    <PageHeading title={project.name} description={project.repositoryUrl ?? "No repository URL is configured."}
      actions={<>
        {hasPermission(roles, "scan:create") && <button className="btn btn-primary" onClick={() => void startScan()} disabled={startingScan}>{startingScan ? "Starting…" : "Start scan"}</button>}
        {canDelete && <button className="btn btn-outline-danger" onClick={() => void deleteProject()}>Delete project</button>}
      </>} />
    {scanError && <div className="alert alert-danger" role="alert">{scanError}</div>}
    <ArchitectureDiscoveryPanel projectId={projectId} existingExpectedModel={project.expectedModel} canUpdate={canUpdate}
      onSaved={() => { void refreshProject(); }} />
    <SourceObservabilityPanel projectId={projectId} existingExpectedModel={project.expectedModel} canUpdate={canUpdate}
      onSaved={() => { void refreshProject(); }} />
    <OrganizationGitHubBindingPanel projectId={projectId} />
    <GitHubRepositoryPanel projectId={projectId} currentUrl={project.repositoryUrl} canUpdate={canUpdate}
      onSaved={() => { void refreshProject(); }} />
    <TelemetryTargetConfigPanel projectId={projectId} current={project.targetConfig} expectedModel={project.expectedModel}
      canUpdate={canUpdate} onSaved={() => { void refreshProject(); }} />
    <section className="surface-panel">
      <div className="section-heading"><div><h2>Scan history</h2><p>Scans are asynchronous. Status and results are read from the project-scoped API.</p></div></div>
      {scans.error != null && <ErrorState error={scans.error} onRetry={scans.refresh} />}
      {scans.loading && !scans.page ? <Loading label="Loading scans" /> : scans.page?.items.length === 0 ?
        <EmptyState title="No scans on this page" detail={scans.canGoBack ? "This cursor page returned no scans." : "Start a scan to evaluate the configured observability requirements."} /> :
        scans.page && <DataTable><thead><tr><th>Status</th><th>Started</th><th>Finished</th><th>Attempt</th><th></th></tr></thead><tbody>
          {scans.page.items.map((scan) => <tr key={scan.id}>
            <td><StatusBadge status={scan.status} />{scan.error && <div className="small text-danger mt-1">{scan.error}</div>}</td>
            <td>{formatDate(scan.startedAt ?? scan.createdAt)}</td><td>{formatDate(scan.completedAt)}</td><td>{scan.attemptCount}</td>
            <td><Link className="btn btn-sm btn-outline-secondary" to={`/projects/${encodeURIComponent(projectId)}/scans/${encodeURIComponent(scan.id)}`}>View findings</Link></td>
          </tr>)}
        </tbody></DataTable>}
      {scans.page && <CursorPager hasMore={scans.page.hasMore} canGoBack={scans.canGoBack} loading={scans.loading} onPrevious={scans.previous} onNext={scans.next} />}
    </section>
  </>;
}
