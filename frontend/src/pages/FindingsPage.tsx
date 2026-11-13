import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useApi } from "../api/ApiProvider";
import { ApiError, getErrorMessage } from "../api/client";
import { CursorPager } from "../components/CursorPager";
import { EmptyState, ErrorState, Loading, NotFoundState } from "../components/Feedback";
import { ProjectPicker } from "../components/ProjectPicker";
import { StatusBadge } from "../components/StatusBadge";
import { useCursorPage } from "../hooks/useCursorPage";
import { DataTable, PageHeading } from "../layouts/AppShell";
import { formatDate, formatJson } from "../utils/format";
import type { Scan } from "../types/api";

export function FindingsPage() {
  const { projectId: routeProjectId, scanId: routeScanId } = useParams();
  const api = useApi();
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState(routeProjectId ?? "");
  const [scanId, setScanId] = useState(routeScanId ?? "");
  const [scanCursor, setScanCursor] = useState<string | undefined>();
  const [scanTrail, setScanTrail] = useState<Array<string | undefined>>([]);
  const [proposalRequest, setProposalRequest] = useState<{ findingId: string | null; error: string | null }>({ findingId: null, error: null });
  const [scanResult, setScanResult] = useState<{ projectId: string; cursor?: string; page?: { items: Scan[]; hasMore: boolean; nextCursor?: string }; error?: unknown } | null>(null);

  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    void api.listScans(projectId, { cursor: scanCursor, signal: controller.signal }).then((page) => {
      if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean" ||
          (page.hasMore && (typeof page.nextCursor !== "string" || page.nextCursor.length === 0))) {
        throw new Error("The API returned an invalid scan cursor page; results may be incomplete.");
      }
      if (!controller.signal.aborted) setScanResult({ projectId, cursor: scanCursor, page });
    }).catch((error: unknown) => { if (!controller.signal.aborted) setScanResult({ projectId, cursor: scanCursor, error }); });
    return () => controller.abort();
  }, [api, projectId, scanCursor]);

  const currentScanResult = scanResult?.projectId === projectId && scanResult.cursor === scanCursor ? scanResult : null;
  const scans = currentScanResult?.page?.items ?? [];
  const scansHasMore = currentScanResult?.page?.hasMore ?? false;
  const scansNextCursor = currentScanResult?.page?.nextCursor;
  const scansError = currentScanResult?.error;
  const scansLoading = Boolean(projectId && !currentScanResult);

  const loadFindings = useCallback((cursor: string | undefined, signal: AbortSignal) =>
    api.listFindings(projectId, scanId, { cursor, signal }), [api, projectId, scanId]);
  const findings = useCursorPage(`${projectId}:${scanId}`, loadFindings);

  function nextScanPage() {
    if (!scansHasMore) return;
    setScanTrail((items) => [...items, scanCursor]);
    if (scansNextCursor) setScanCursor(scansNextCursor);
  }
  function previousScanPage() {
    if (!scanTrail.length) return;
    setScanCursor(scanTrail.at(-1));
    setScanTrail((items) => items.slice(0, -1));
  }

  async function createProposal(findingId: string) {
    setProposalRequest({ findingId, error: null });
    try {
      const result = await api.createRemediationProposal(projectId, findingId);
      navigate(`/proposals/${encodeURIComponent(result.proposal.id)}`);
    } catch (error) {
      setProposalRequest({ findingId: null, error: getErrorMessage(error) });
    }
  }

  if (routeProjectId && routeScanId && scansError instanceof ApiError && scansError.status === 404) return <NotFoundState label="Scan" />;

  return <>
    <PageHeading title="Findings" description="Findings are available under a project and scan; the API does not expose a global findings index." />
    <div className="filter-row"><ProjectPicker value={projectId} onChange={(id) => { setProjectId(id); setScanId(""); setScanCursor(undefined); setScanTrail([]); }} />
      {projectId && <div className="project-picker"><label className="form-label" htmlFor="scan-picker">Scan</label>
        <select id="scan-picker" className="form-select" value={scanId} onChange={(event) => setScanId(event.target.value)} disabled={scansLoading && !scans.length}>
          <option value="">Choose a scan…</option>{scans.map((scan) => <option key={scan.id} value={scan.id}>{scan.status} · {formatDate(scan.createdAt)}</option>)}
        </select>
        {scansError != null && <div className="small text-danger mt-1">{getErrorMessage(scansError)}</div>}
        {scans.length > 0 && <CursorPager hasMore={scansHasMore} canGoBack={scanTrail.length > 0} loading={scansLoading} onPrevious={previousScanPage} onNext={nextScanPage} />}
      </div>}
    </div>
    {!projectId || !scanId ? <EmptyState title="Choose a project and scan" detail="The API returns findings for one selected scan at a time." /> : <>
      {findings.error != null && <ErrorState error={findings.error} onRetry={findings.refresh} />}
      {findings.loading && !findings.page ? <Loading label="Loading findings" /> : findings.page?.items.length === 0 ?
        <EmptyState title="No findings on this page" detail={findings.canGoBack ? "This cursor page returned no findings." : "This scan returned no findings."} /> :
        findings.page && <DataTable><thead><tr><th>Rule</th><th>Signal</th><th>Outcome</th><th>Expected / observed</th><th>Reason</th><th>Evidence</th><th></th></tr></thead><tbody>
          {findings.page.items.map((finding) => <tr key={finding.id}>
            <td><strong>{finding.ruleId}</strong><small className="table-subtext">v{finding.ruleVersion} · {finding.requirementId}</small></td>
            <td>{finding.signal}</td><td><StatusBadge status={finding.outcome} /></td>
            <td><div><b>Expected:</b> {finding.expected}</div><div><b>Observed:</b> {finding.observed}</div></td>
            <td>{finding.reason}</td><td><details><summary>View evidence</summary><pre className="evidence-json">{formatJson(finding.evidenceJson)}</pre></details></td>
            <td>{finding.outcome === "gap" && <button className="btn btn-sm btn-outline-primary" disabled={proposalRequest.findingId !== null}
              onClick={() => void createProposal(finding.id)}>{proposalRequest.findingId === finding.id ? "Creating…" : "Create proposal"}</button>}</td>
          </tr>)}
        </tbody></DataTable>}
      {findings.page && <CursorPager hasMore={findings.page.hasMore} canGoBack={findings.canGoBack} loading={findings.loading} onPrevious={findings.previous} onNext={findings.next} />}
      <div className="back-link"><Link to={`/projects/${encodeURIComponent(projectId)}`}>Back to project</Link></div>
    </>}
    {proposalRequest.error && <div className="alert alert-danger" role="alert">Proposal could not be created: {proposalRequest.error}</div>}
    {findings.page?.items.some((finding) => finding.outcome === "gap") && <p className="small text-muted">Proposals use the persisted finding and verified organization repository binding. The legacy remediation endpoint remains disabled.</p>}
  </>;
}
