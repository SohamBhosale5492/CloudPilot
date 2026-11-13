import { useCallback } from "react";
import { useApi } from "../api/ApiProvider";
import { CursorPager } from "../components/CursorPager";
import { EmptyState, ErrorState, Loading } from "../components/Feedback";
import { useCursorPage } from "../hooks/useCursorPage";
import { DataTable, PageHeading } from "../layouts/AppShell";
import { formatDate, formatJson } from "../utils/format";

export function AuditEventsPage() {
  const api = useApi();
  const load = useCallback((cursor: string | undefined, signal: AbortSignal) => api.listAuditEvents({ cursor, signal }), [api]);
  const state = useCursorPage("audit-events", load);
  return <>
    <PageHeading title="Audit events" description="Tenant audit records are shown one server page at a time." />
    {state.error && <ErrorState error={state.error} onRetry={state.refresh} />}
    {state.loading && !state.page ? <Loading label="Loading audit events" /> : state.page?.items.length === 0 ?
      <EmptyState title="No audit events on this page" detail={state.canGoBack ? "This cursor page returned no records." : "No audit events were returned."} /> :
      state.page && <div className="card-surface"><DataTable><thead><tr><th>When</th><th>Action</th><th>Resource</th><th>Actor</th><th>Project</th><th>Details</th></tr></thead><tbody>
        {state.page.items.map((event) => <tr key={event.id}><td>{formatDate(event.createdAt)}</td><td><strong>{event.action}</strong></td>
          <td>{event.resourceType}<small className="table-subtext">{event.resourceId}</small></td><td>{event.actorId}</td><td>{event.projectId ?? "—"}</td>
          <td><details><summary>View details</summary><pre className="evidence-json">{formatJson(event.metadataJson)}</pre></details></td></tr>)}
      </tbody></DataTable><CursorPager hasMore={state.page.hasMore} canGoBack={state.canGoBack} loading={state.loading} onPrevious={state.previous} onNext={state.next} /></div>}
  </>;
}
