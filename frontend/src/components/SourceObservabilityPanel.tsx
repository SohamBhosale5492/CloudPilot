import { useState } from "react";
import { useApi } from "../api/ApiProvider";
import { getErrorMessage } from "../api/client";
import type { SourceObservabilityAnalysis } from "../types/architecture";

interface Props { projectId: string; existingExpectedModel: unknown; canUpdate: boolean; onSaved(): void }
interface SnapshotFile { path: string; content: string }
const MAX_FILES = 120;
const MAX_TOTAL_BYTES = 448 * 1024;
const SOURCE_EXTENSIONS = /\.(?:js|cjs|mjs|ts|json|yaml|yml)$/i;

export function SourceObservabilityPanel({ projectId, existingExpectedModel, canUpdate, onSaved }: Props) {
  const api = useApi();
  const [snapshot, setSnapshot] = useState<SnapshotFile[]>([]);
  const [result, setResult] = useState<SourceObservabilityAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function readSnapshot(files: FileList | null) {
    setError(null); setResult(null); setSnapshot([]);
    if (!files?.length) return;
    const selected = Array.from(files).filter((file) => {
      const path = file.webkitRelativePath || file.name;
      return SOURCE_EXTENSIONS.test(path) && !/(^|\/)(\.env(?:\.|$)|node_modules|\.git|package-lock\.json)(\/|$)/i.test(path);
    });
    if (!selected.length || selected.length > MAX_FILES) { setError(`Choose 1 to ${MAX_FILES} source or configuration files. Dependency and environment files are ignored.`); return; }
    if (selected.some((file) => file.size > 256 * 1024) || selected.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES) {
      setError(`Selected source exceeds the per-file or ${MAX_TOTAL_BYTES}-byte upload limit. Select only relevant application and monitoring files.`); return;
    }
    try {
      const rows = await Promise.all(selected.map(async (file) => ({ path: file.webkitRelativePath || file.name, content: await file.text(), size: file.size })));
      const total = rows.reduce((sum, item) => sum + item.size, 0);
      if (total > MAX_TOTAL_BYTES) throw new Error(`Selected source exceeds the ${MAX_TOTAL_BYTES}-byte upload limit. Select only relevant application and monitoring files.`);
      setSnapshot(rows.map(({ path, content }) => ({ path, content })));
    } catch (cause) { setError(getErrorMessage(cause)); }
  }

  async function analyze() {
    if (!snapshot.length) return;
    setBusy(true); setError(null);
    try { setResult(await api.analyzeProjectSource(projectId, snapshot)); }
    catch (cause) { setError(getErrorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function apply() {
    if (!result || result.expectedModel.requirements.length === 0) return;
    setBusy(true); setError(null);
    try {
      const saved = await api.applyProjectSourceAnalysis(projectId, snapshot, existingExpectedModel ?? null);
      setResult(saved); onSaved();
    } catch (cause) { setError(getErrorMessage(cause)); }
    finally { setBusy(false); }
  }

  return <section className="surface-panel mb-4" aria-labelledby="source-analysis-title">
    <div className="section-heading"><div><h2 id="source-analysis-title">Repository source observability analysis</h2>
      <p>Analyze a local source snapshot with deterministic Node.js/Express rules. CloudPilot does not fetch GitHub source; the selected files are analyzed in memory and not written to the application filesystem.</p></div></div>
    <div className="alert alert-warning">Do not select environment files, credentials, private keys, or unrelated source. Only supported JavaScript/TypeScript, package JSON, and YAML files are accepted.</div>
    <label className="form-label" htmlFor="source-snapshot">Application and monitoring source files</label>
    <input id="source-snapshot" className="form-control" type="file" multiple disabled={!canUpdate || busy}
      accept=".js,.cjs,.mjs,.ts,.json,.yaml,.yml" {...({ webkitdirectory: "" } as Record<string, string>)}
      onChange={(event) => void readSnapshot(event.currentTarget.files)} />
    {!canUpdate && <p className="text-muted mt-2">Your role can view projects but cannot upload or apply source analysis.</p>}
    {snapshot.length > 0 && <p className="small text-muted mt-2">{snapshot.length} supported files selected ({Math.round(snapshot.reduce((sum, file) => sum + new TextEncoder().encode(file.content).length, 0) / 1024)} KiB).</p>}
    {canUpdate && <button className="btn btn-outline-primary mt-2" type="button" disabled={busy || !snapshot.length} onClick={() => void analyze()}>{busy ? "Analyzing…" : "Analyze source snapshot"}</button>}
    {error && <div className="alert alert-danger mt-3" role="alert">{error}</div>}
    {result && <div className="mt-3" aria-label="Source observability analysis results">
      <p><strong>Analysis:</strong> {result.status}; service {result.serviceName ?? "not identified"}; {result.routes.length} routes; {result.expectedModel.requirements.length} expected requirements.</p>
      <p><strong>Snapshot digest:</strong> <code>{result.sourceDigest || "unavailable"}</code></p>
      {result.diagnostics.map((item) => <p className="alert alert-info" key={item}>{item}</p>)}
      <h3>Source-derived routes and requirements</h3>
      {result.routes.length === 0 ? <p>No Express routes were statically recognized.</p> : <ul>{result.routes.map((route) => <li key={`${route.method}:${route.path}`}><code>{route.method} {route.path}</code> — {route.evidence.path}:{route.evidence.line}</li>)}</ul>}
      {result.findings.length > 0 ? <><h3>Source assessments</h3><ul>{result.findings.map((finding) => <li key={finding.id} className="mb-2">
        <strong>{finding.severity.toUpperCase()} · {finding.status}: {finding.title}</strong><p className="mb-1">{finding.observed} {finding.risk}</p>
        <ul>{finding.evidence.map((evidence, index) => <li key={`${evidence.path}:${evidence.line}:${index}`}><code>{evidence.path}:{evidence.line}</code> — {evidence.claim}</li>)}</ul>
      </li>)}</ul></> : <p>No source-level gap was identified by the rules that ran.</p>}
      <h3>Expected telemetry</h3><ul>{result.expectedModel.requirements.map((requirement) => <li key={requirement.id}><code>{requirement.id}</code> — {requirement.signal}{requirement.signal === "metric" ? ` ${requirement.metricName}` : requirement.signal === "trace" ? ` service ${requirement.serviceName}` : requirement.signal === "health" ? ` ${requirement.endpoint}` : ""}</li>)}</ul>
      <details className="mb-3"><summary>Rule evidence by expected requirement</summary><ul>{Object.entries(result.evidenceByRequirement).map(([requirementId, evidence]) => <li key={requirementId}><code>{requirementId}</code><ul>{evidence.map((item, index) => <li key={`${item.path}:${item.line}:${index}`}><code>{item.path}:{item.line}</code> — {item.claim}</li>)}</ul></li>)}</ul></details>
      {canUpdate && result.expectedModel.requirements.length > 0 && !result.saved && <>
        <p className="small text-muted">Applying merges source-derived requirements with the current expected model using an optimistic baseline. A later scan will compare them with configured Prometheus, health and Jaeger evidence. Existing requirements are preserved; conflicts require review.</p>
        <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void apply()}>{busy ? "Applying…" : "Apply reviewed source model"}</button>
      </>}
      {result.saved && <p className="text-success" role="status">Source-derived model and line evidence saved with an audit event. Start a project scan to correlate runtime telemetry.</p>}
    </div>}
  </section>;
}
