import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useApi } from "../api/ApiProvider";
import { getErrorMessage } from "../api/client";
import { ErrorState, Loading } from "../components/Feedback";
import { PageHeading } from "../layouts/AppShell";
import type { RemediationProposal } from "../types/api";
import { formatDate, formatJson } from "../utils/format";

export function RemediationProposalPage() {
  const { proposalId = "" } = useParams();
  const api = useApi();
  const [state, setState] = useState<{ id: string; proposal?: RemediationProposal; error?: unknown } | null>(null);
  const [action, setAction] = useState<"prepare" | "approve" | "reject" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const current = state?.id === proposalId ? state : null;

  const reload = useCallback(async () => {
    try { setState({ id: proposalId, proposal: await api.getRemediationProposal(proposalId) }); }
    catch (error) { setState({ id: proposalId, error }); }
  }, [api, proposalId]);
  useEffect(() => {
    const controller = new AbortController();
    void api.getRemediationProposal(proposalId, { signal: controller.signal })
      .then((proposal) => { if (!controller.signal.aborted) setState({ id: proposalId, proposal }); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setState({ id: proposalId, error }); });
    return () => controller.abort();
  }, [api, proposalId]);

  async function runAction(next: "prepare" | "approve" | "reject") {
    setAction(next); setMessage(null);
    try {
      if (next === "prepare") {
        const result = await api.prepareRemediationArtifact(proposalId);
        setMessage(`Artifact ${result.replayed ? "already prepared" : "prepared"}: ${result.artifactHash}`);
      } else {
        const result = await api.decideRemediationProposal(proposalId, next);
        setMessage(`Proposal ${result.approvalState}. Automated execution remains disabled.`);
      }
      await reload();
    } catch (error) { setMessage(getErrorMessage(error)); }
    finally { setAction(null); }
  }

  const proposal = current?.proposal;
  const plan = proposal?.plan && typeof proposal.plan === "object" ? proposal.plan as Record<string, unknown> : null;
  return <>
    <PageHeading title="Remediation proposal" description="Review the persisted plan and exact artifact metadata. Approval is explicit and does not start execution." />
    {!current && <Loading label="Loading proposal" />}
    {current?.error && <ErrorState error={current.error} onRetry={() => void reload()} />}
    {proposal && <section className="card-surface detail-card" aria-label="Proposal details">
      <p><strong>Approval:</strong> {proposal.approvalState} · <strong>Lifecycle:</strong> {proposal.status} · <strong>PR delivery:</strong> {proposal.prDeliveryStatus ?? (proposal.status === "merged" ? "pr_merged" : proposal.status === "open" ? "draft_pr_created" : proposal.status === "closed" ? "pr_closed" : "not_started")} · <strong>Finding resolution:</strong> {proposal.findingResolution?.status ?? "unverified"}{proposal.findingResolution?.latestOutcome ? ` (latest scan outcome: ${proposal.findingResolution.latestOutcome})` : " (awaiting subsequent scan)"}</p>
      <dl className="detail-grid">
        <dt>Proposal</dt><dd>{proposal.id}</dd><dt>Project</dt><dd><Link to={`/projects/${encodeURIComponent(proposal.projectId)}`}>{proposal.projectId}</Link></dd>
        <dt>Finding</dt><dd>{proposal.findingId}</dd><dt>Repository ID</dt><dd>{proposal.githubRepositoryId}</dd>
        <dt>Plan hash</dt><dd><code>{proposal.planHash}</code></dd><dt>Created</dt><dd>{formatDate(proposal.createdAt)}</dd>
        {proposal.approvedAt && <><dt>Approved</dt><dd>{formatDate(proposal.approvedAt)}</dd></>}
        {proposal.invalidatedAt && <><dt>Invalidated</dt><dd>{formatDate(proposal.invalidatedAt)}</dd></>}
        {proposal.executionArtifact && <><dt>Artifact hash</dt><dd><code>{proposal.executionArtifact.artifactHash}</code></dd>
          <dt>Approved base</dt><dd>{proposal.executionArtifact.baseRef} @ <code>{proposal.executionArtifact.baseCommitSha}</code></dd>
          <dt>Artifact path</dt><dd><code>{proposal.executionArtifact.filePath}</code></dd></>}
      </dl>
      {plan && <details><summary>Review persisted plan</summary><pre className="evidence-json">{formatJson(plan)}</pre></details>}
      {proposal.execution && <div className="alert alert-secondary mt-3" role="status">
        <strong>Execution state:</strong> {proposal.execution.status} · stage {proposal.execution.stage ?? "—"} · attempt {proposal.execution.attemptNumber}{proposal.execution.status === "completed" ? " (Draft PR delivered — finding resolution requires a subsequent passing scan)" : ""}
        {proposal.execution.commitSha && <div>Verified commit: <code>{proposal.execution.commitSha}</code></div>}
        {proposal.execution.branchName && <div>Branch: <code>{proposal.execution.branchName}</code></div>}
        {proposal.execution.pullRequestUrl && <div>Pull request: <a href={proposal.execution.pullRequestUrl} target="_blank" rel="noreferrer">#{proposal.execution.pullRequestNumber ?? "—"}</a></div>}
        {proposal.execution.failureCode && <div>Failure code: <code>{proposal.execution.failureCode}</code></div>}
      </div>}
      {proposal.approvalState === "pending" && <div className="d-flex flex-wrap gap-2 mt-3">
        {!proposal.executionArtifact && proposal.permissions?.prepareArtifact && <button className="btn btn-outline-primary" disabled={action !== null}
          onClick={() => void runAction("prepare")}>{action === "prepare" ? "Preparing…" : "Prepare verified artifact"}</button>}
        {proposal.executionArtifact && proposal.permissions?.approve && <button className="btn btn-primary" disabled={action !== null}
          onClick={() => void runAction("approve")}>{action === "approve" ? "Approving…" : "Approve proposal"}</button>}
        {proposal.permissions?.approve && <button className="btn btn-outline-danger" disabled={action !== null}
          onClick={() => void runAction("reject")}>{action === "reject" ? "Rejecting…" : "Reject proposal"}</button>}
      </div>}
      {proposal.approvalState === "approved" && <div className="alert alert-info mt-3" role="status">Approved artifact is persisted. Background remediation execution is disabled in this release.</div>}
      {proposal.approvalState === "invalidated" && <div className="alert alert-warning mt-3" role="alert"><strong>Proposal invalidated.</strong> {proposal.invalidationReason ?? "This proposal is stale and can no longer be approved."}</div>}
      {message && <div className="alert alert-secondary mt-3" role="status">{message}</div>}
    </section>}
    <p className="back-link"><Link to="/findings">Back to findings</Link></p>
  </>;
}
