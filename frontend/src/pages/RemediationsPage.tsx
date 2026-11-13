import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../api/ApiProvider";
import { ApiError } from "../api/client";
import { CursorPager } from "../components/CursorPager";
import { EmptyState, ErrorState, Loading } from "../components/Feedback";
import { ProjectPicker } from "../components/ProjectPicker";
import { StatusBadge } from "../components/StatusBadge";
import { useCursorPage } from "../hooks/useCursorPage";
import { DataTable, PageHeading } from "../layouts/AppShell";
import { formatDate } from "../utils/format";

export function RemediationsPage() {
  const api = useApi();
  const [projectId, setProjectId] = useState("");
  const load = useCallback((cursor: string | undefined, signal: AbortSignal) =>
    projectId ? api.listRemediations(projectId, { cursor, signal }) : Promise.resolve({ items: [], hasMore: false }), [api, projectId]);
  const state = useCursorPage(projectId, load);
  const unavailable = state.error instanceof ApiError && state.error.status === 404;

  return <>
    <PageHeading title="Remediations" description="Review remediation records returned by the API. Automated execution is disabled." />
    <div className="filter-row"><ProjectPicker value={projectId} onChange={setProjectId} /></div>
    <div className="alert alert-info" role="status">Legacy remediation creation and retriggering are disabled. Approved proposal execution is not connected to this page.</div>
    {!projectId ? <EmptyState title="Choose a project" detail="Remediations are listed within a project scope." /> : unavailable ?
      <div className="alert alert-warning" role="status"><strong>Remediation read route unavailable.</strong> This host configuration did not return remediation data; no empty dataset is inferred.</div> : <>
        {state.error && <ErrorState error={state.error} onRetry={state.refresh} />}
        {state.loading && !state.page ? <Loading label="Loading remediations" /> : state.page?.items.length === 0 ?
          <EmptyState title="No remediations on this page" detail={state.canGoBack ? "This cursor page returned no records." : "The API returned no remediations for this project."} /> :
          state.page && <div className="card-surface"><DataTable><thead><tr><th>Status</th><th>Finding</th><th>Pull request</th><th>Retries</th><th>Updated</th><th>Action</th></tr></thead><tbody>
            {state.page.items.map((item) => <tr key={item.id}><td><StatusBadge status={item.status} /></td><td><Link to={`/remediations/${encodeURIComponent(item.id)}`}>{item.findingId}</Link><small className="table-subtext">{item.id}</small></td>
              <td>{item.prUrl ? <a href={item.prUrl} target="_blank" rel="noreferrer">PR #{item.prNumber ?? "—"}</a> : item.branchName ?? "Not created"}</td>
              <td>{item.retriesLeft}</td><td>{formatDate(item.updatedAt)}</td><td>{item.status === "failed" ? "Retry disabled" : "—"}</td></tr>)}
          </tbody></DataTable><CursorPager hasMore={state.page.hasMore} canGoBack={state.canGoBack} loading={state.loading} onPrevious={state.previous} onNext={state.next} /></div>}
      </>}
  </>;
}
