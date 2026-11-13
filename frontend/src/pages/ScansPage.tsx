import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../api/ApiProvider";
import { CursorPager } from "../components/CursorPager";
import { EmptyState, ErrorState, Loading } from "../components/Feedback";
import { ProjectPicker } from "../components/ProjectPicker";
import { StatusBadge } from "../components/StatusBadge";
import { useCursorPage } from "../hooks/useCursorPage";
import { DataTable, PageHeading } from "../layouts/AppShell";
import { formatDate } from "../utils/format";

export function ScansPage() {
  const api = useApi();
  const [projectId, setProjectId] = useState("");
  const load = useCallback((cursor: string | undefined, signal: AbortSignal) => api.listScans(projectId, { cursor, signal }), [api, projectId]);
  const page = useCursorPage(projectId, load);
  return <>
    <PageHeading title="Scans" description="Browse scan history within a selected project." />
    <div className="filter-row"><ProjectPicker value={projectId} onChange={setProjectId} /></div>
    {!projectId ? <EmptyState title="Select a project" detail="Scans are only exposed through a project-scoped endpoint." /> : <>
      {page.error && <ErrorState error={page.error} onRetry={page.refresh} />}
      {page.loading && !page.page ? <Loading label="Loading scans" /> : page.page?.items.length === 0 ?
        <EmptyState title="No scans on this page" detail={page.canGoBack ? "This cursor page returned no scans." : "This project has no scans yet."} /> :
        page.page && <DataTable><thead><tr><th>Status</th><th>Created</th><th>Completed</th><th>Attempts</th><th></th></tr></thead><tbody>
          {page.page.items.map((scan) => <tr key={scan.id}><td><StatusBadge status={scan.status} />{scan.error && <div className="small text-danger mt-1">{scan.error}</div>}</td>
            <td>{formatDate(scan.createdAt)}</td><td>{formatDate(scan.completedAt)}</td><td>{scan.attemptCount}</td>
            <td><Link className="btn btn-sm btn-outline-secondary" to={`/projects/${encodeURIComponent(projectId)}/scans/${encodeURIComponent(scan.id)}`}>Open</Link></td></tr>)}
        </tbody></DataTable>}
      {page.page && <CursorPager hasMore={page.page.hasMore} canGoBack={page.canGoBack} loading={page.loading} onPrevious={page.previous} onNext={page.next} />}
    </>}
  </>;
}
