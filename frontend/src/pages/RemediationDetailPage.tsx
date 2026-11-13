import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useApi } from "../api/ApiProvider";
import { ApiError } from "../api/client";
import { EmptyState, ErrorState, Loading } from "../components/Feedback";
import { StatusBadge } from "../components/StatusBadge";
import { PageHeading } from "../layouts/AppShell";
import { formatDate } from "../utils/format";

export function RemediationDetailPage() {
  const { remediationId = "" } = useParams();
  const api = useApi();
  const [state, setState] = useState<{ id: string; item?: Awaited<ReturnType<typeof api.getRemediation>>; error?: unknown } | null>(null);
  const currentState = state?.id === remediationId ? state : null;
  const reload = useCallback(() => {
    void api.getRemediation(remediationId).then((item) => setState({ id: remediationId, item }))
      .catch((error: unknown) => setState({ id: remediationId, error }));
  }, [api, remediationId]);
  useEffect(() => { reload(); }, [reload]);

  return <>
    <PageHeading title="Remediation detail" description="Tenant-scoped status returned by the remediation API." />
    {!currentState && <Loading label="Loading remediation" />}
    {currentState?.error instanceof ApiError && currentState.error.status === 404 && <div className="alert alert-warning" role="status">Remediation is not available to this tenant, or the optional remediation API is disabled. No record was returned.</div>}
    {currentState?.error != null && !(currentState.error instanceof ApiError && currentState.error.status === 404) && <ErrorState error={currentState.error} onRetry={reload} />}
    {currentState?.item && <div className="card-surface detail-card"><div className="detail-status"><StatusBadge status={currentState.item.status} /></div>
      <dl className="detail-grid"><dt>Remediation ID</dt><dd>{currentState.item.id}</dd><dt>Project ID</dt><dd><Link to={`/projects/${encodeURIComponent(currentState.item.projectId)}`}>{currentState.item.projectId}</Link></dd>
        <dt>Finding ID</dt><dd>{currentState.item.findingId}</dd><dt>Scan ID</dt><dd>{currentState.item.scanId}</dd><dt>Branch</dt><dd>{currentState.item.branchName ?? "—"}</dd>
        <dt>Pull request</dt><dd>{currentState.item.prUrl ? <a href={currentState.item.prUrl} target="_blank" rel="noreferrer">PR #{currentState.item.prNumber ?? "—"}</a> : "—"}</dd>
        <dt>Patch summary</dt><dd>{currentState.item.patchSummary ?? "—"}</dd><dt>Retries left</dt><dd>{currentState.item.retriesLeft}</dd><dt>Next attempt</dt><dd>{formatDate(currentState.item.nextAttemptAt)}</dd>
        <dt>Created</dt><dd>{formatDate(currentState.item.createdAt)}</dd><dt>Updated</dt><dd>{formatDate(currentState.item.updatedAt)}</dd><dt>Last error</dt><dd>{currentState.item.errorMessage ?? "—"}</dd></dl></div>}
    {currentState && !currentState.error && !currentState.item && <EmptyState title="Remediation unavailable" detail="No remediation record was returned." />}
    <p className="back-link"><Link to="/remediations">Back to remediations</Link></p>
  </>;
}
