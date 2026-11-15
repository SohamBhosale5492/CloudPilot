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
import type { RemediationProposal } from "../types/api";
import { formatDate } from "../utils/format";

function proposalTargetLabel(proposal: RemediationProposal): string {
  if (proposal.executionArtifact?.filePath) return proposal.executionArtifact.filePath;
  if (proposal.plan && typeof proposal.plan === "object") {
    const patch = (proposal.plan as { patch?: unknown }).patch;
    if (patch && typeof patch === "object" && typeof (patch as { filePath?: unknown }).filePath === "string") {
      return (patch as { filePath: string }).filePath;
    }
  }
  return "Plan snapshot";
}

export function RemediationsPage() {
  const api = useApi();
  const [projectId, setProjectId] = useState("");
  const load = useCallback((cursor: string | undefined, signal: AbortSignal) =>
    projectId ? api.listRemediationProposals(projectId, { cursor, signal }) : Promise.resolve({ items: [], hasMore: false }), [api, projectId]);
  const state = useCursorPage(projectId, load);
  const unavailable = state.error instanceof ApiError && state.error.status === 404;

  return <>
    <PageHeading title="Remediations" description="Review persisted remediation proposals returned by the API. Automated execution is disabled." />
    <div className="filter-row"><ProjectPicker value={projectId} onChange={setProjectId} /></div>
    <div className="alert alert-info" role="status">Showing persisted remediation proposals for this project. Legacy remediation creation and retriggering are disabled, and automated execution remains disabled.</div>
    {!projectId ? <EmptyState title="Choose a project" detail="Remediation proposals are listed within a project scope." /> : unavailable ?
      <div className="alert alert-warning" role="status"><strong>Remediation read route unavailable.</strong> This host configuration did not return remediation data; no empty dataset is inferred.</div> : <>
        {state.error && <ErrorState error={state.error} onRetry={state.refresh} />}
        {state.loading && !state.page ? <Loading label="Loading remediations" /> : state.page?.items.length === 0 ?
          <EmptyState title="No remediation proposals on this page" detail={state.canGoBack ? "This cursor page returned no records." : "The API returned no remediation proposals for this project."} /> :
          state.page && <div className="card-surface"><DataTable><thead><tr><th>Status</th><th>PR Delivery</th><th>Resolution</th><th>Approval</th><th>Finding</th><th>Target</th><th>Created</th><th>Action</th></tr></thead><tbody>
            {state.page.items.map((item) => <tr key={item.id}>
              <td><StatusBadge status={item.status} /></td>
              <td><StatusBadge status={item.prDeliveryStatus ?? (item.status === "merged" ? "pr_merged" : item.status === "open" ? "draft_pr_created" : item.status === "closed" ? "pr_closed" : "not_started")} /></td>
              <td><StatusBadge status={item.findingResolution?.status ?? "unverified"} />{item.findingResolution?.latestOutcome && <small className="table-subtext">outcome: {item.findingResolution.latestOutcome}</small>}</td>
              <td><StatusBadge status={item.approvalState} />{item.invalidationReason && <small className="table-subtext">{item.invalidationReason}</small>}</td>
              <td><Link to={`/proposals/${encodeURIComponent(item.id)}`}>{item.findingId}</Link><small className="table-subtext">{item.id}</small></td>
              <td><code>{proposalTargetLabel(item)}</code></td>
              <td>{formatDate(item.createdAt)}</td>
              <td><Link to={`/proposals/${encodeURIComponent(item.id)}`}>Review proposal</Link></td>
            </tr>)}
          </tbody></DataTable><CursorPager hasMore={state.page.hasMore} canGoBack={state.canGoBack} loading={state.loading} onPrevious={state.previous} onNext={state.next} /></div>}
      </>}
  </>;
}
