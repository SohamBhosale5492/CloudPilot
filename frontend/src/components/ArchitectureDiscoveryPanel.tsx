import { useState } from "react";
import { useApi } from "../api/ApiProvider";
import { getErrorMessage } from "../api/client";
import { expectedModelDraftForService, mergeRecommendationsIntoModel, recommendationsForService } from "../architecture/expected-model-draft";
import type { ExpectedObservabilityModel } from "../types/api";
import type { ArchitectureDiscoveryResult } from "../types/architecture";

interface Props {
  projectId: string;
  existingExpectedModel: unknown;
  canUpdate: boolean;
  onSaved(): void;
}

function editableModel(value: string): ExpectedObservabilityModel | null {
  try {
    const model: unknown = JSON.parse(value);
    if (!model || typeof model !== "object" || Array.isArray(model)) return null;
    const candidate = model as Partial<ExpectedObservabilityModel>;
    return candidate.schemaVersion === "cloudpilot.expected-observability.v1" &&
      typeof candidate.serviceId === "string" && candidate.serviceId.trim() &&
      Array.isArray(candidate.requirements) && candidate.requirements.length > 0
      ? candidate as ExpectedObservabilityModel : null;
  } catch { return null; }
}

export function ArchitectureDiscoveryPanel({ projectId, existingExpectedModel, canUpdate, onSaved }: Props) {
  const api = useApi();
  const [result, setResult] = useState<ArchitectureDiscoveryResult | null>(null);
  const [modelText, setModelText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [mergeDraft, setMergeDraft] = useState(false);
  const [draftConflicts, setDraftConflicts] = useState<string[]>([]);
  const modelToSave = editableModel(modelText);

  async function discover(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const manifests = await Promise.all(Array.from(files).map(async (file) => ({ path: file.name, content: await file.text() })));
      setResult(await api.discoverProjectArchitecture(projectId, manifests));
    } catch (cause) { setError(getErrorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!modelToSave) return;
    setBusy(true); setError(null);
    try {
      if (mergeDraft) await api.mergeProjectExpectedModel(projectId, existingExpectedModel ?? null, modelToSave);
      else {
        if (!window.confirm("This replaces the project's entire expected model, including all existing requirements. Continue?")) return;
        await api.saveProjectExpectedModel(projectId, modelToSave);
      }
      setSaved(true); onSaved();
    }
    catch (cause) { setError(getErrorMessage(cause)); }
    finally { setBusy(false); }
  }

  return <section className="surface-panel mb-4" aria-labelledby="architecture-discovery-title">
    <div className="section-heading"><div><h2 id="architecture-discovery-title">Architecture discovery</h2>
      <p>Inspect uploaded Docker Compose or Kubernetes YAML. Configuration is evidence of declarations only; it does not prove a service is running or monitored.</p></div></div>
    {isExistingModelPresent(existingExpectedModel) && <p className="alert alert-info">This project already has an expected model. Adding recommendations merges against this version; explicit reset replaces it.</p>}
    {!canUpdate && <p className="text-muted">Your role can view project details but cannot run discovery or save configuration.</p>}
    <label className="form-label" htmlFor="architecture-files">YAML manifest files</label>
    <input id="architecture-files" className="form-control" type="file" accept=".yaml,.yml,application/yaml,text/yaml" multiple
      disabled={!canUpdate || busy} onChange={(event) => void discover(event.currentTarget.files)} />
    {busy && <p className="mt-2" role="status">Working…</p>}
    {error && <div className="alert alert-danger mt-3" role="alert">{error}</div>}
    {result && <div className="mt-3" aria-label="Architecture discovery results">
      <p><strong>Discovery status:</strong> {result.status}</p>
      <h3>Detected services</h3>
      {result.model.services.length === 0 ? <p>No supported services were discovered.</p> : <ul>
        {result.model.services.map((service) => <li key={service.id} className="mb-2">
          <strong>{service.name}</strong> — {service.workloadType}{service.image ? `; image ${service.image}` : ""}
          {service.ports.length > 0 ? `; ports ${service.ports.join(", ")}` : ""}
          {service.dependencies.length > 0 ? `; declared dependencies ${service.dependencies.join(", ")}` : ""}
          <div className="small text-muted">Declared in {service.source.file} ({service.source.format})</div>
          {(() => {
            const recommendations = recommendationsForService(service);
            if (!recommendations.length) return <p className="small text-muted">No application observability recommendations: this service matches a known infrastructure name or image. Override is not available from discovery.</p>;
            return <div className="recommendations mt-2"><h4>Inferred recommendations</h4>
              <p className="small text-muted">Low confidence. Suggestions do not prove HTTP behavior or monitoring. The selected checks validate signal presence, not error-rate or p95 thresholds.</p>
              {recommendations.map((recommendation) => {
                const key = `${service.id}:${recommendation.id}`;
                return <div className="border rounded p-2 mb-2" key={key}>
                  <label><input type="checkbox" disabled={!canUpdate || busy} checked={Boolean(selected[key])}
                    onChange={(event) => setSelected((current) => ({ ...current, [key]: event.target.checked }))} /> {recommendation.title}</label>
                  <p className="small mb-1">{recommendation.rationale}</p>
                  <details><summary>Evidence, confidence and assumptions</summary><p>Confidence: {recommendation.confidence}</p><ul>{recommendation.evidence.map((item) => <li key={item}>{item}</li>)}{recommendation.assumptions.map((item) => <li key={item}>Assumption: {item}</li>)}</ul></details>
                  {selected[key] && <label className="form-label mt-2" htmlFor={`recommendation-${key}`}>{recommendation.signal === "health" ? "Verified health path" : "Metric name from service configuration"}
                    <input id={`recommendation-${key}`} className="form-control" value={values[key] ?? ""} disabled={!canUpdate || busy}
                      placeholder={recommendation.signal === "health" ? "Enter an existing endpoint path" : "Enter an existing Prometheus metric name"}
                      onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))} />
                  </label>}
                </div>;
              })}
              {canUpdate && <button className="btn btn-sm btn-outline-primary" type="button" disabled={busy} onClick={() => {
                const chosen = recommendations.flatMap((recommendation) => {
                  const key = `${service.id}:${recommendation.id}`;
                  const value = values[key]?.trim();
                  return selected[key] && value ? [{ recommendation, value }] : [];
                });
                const merged = mergeRecommendationsIntoModel(existingExpectedModel, service, chosen);
                setDraftConflicts(merged.conflicts);
                setError(merged.error ?? null);
                setModelText(JSON.stringify(merged.model, null, 2)); setMergeDraft(!merged.error); setSaved(false);
              }}>Add selected recommendations to model draft</button>}
              {canUpdate && <button className="btn btn-sm btn-link" type="button" onClick={() => {
                if (!window.confirm("Reset the draft to an empty model? Saving it will replace and remove all existing requirements.")) return;
                setModelText(JSON.stringify(expectedModelDraftForService(service), null, 2)); setMergeDraft(false); setDraftConflicts([]); setSaved(false);
              }}>Start with empty model draft (destructive reset)</button>}
            </div>;
          })()}
        </li>)}
      </ul>}
      <h3>Detected resources</h3>
      {result.model.resources.length === 0 ? <p>No supported resources were discovered.</p> : <ul>{result.model.resources.map((resource) =>
        <li key={resource.id}>{resource.name} — {resource.kind ?? resource.resourceType}; declared in {resource.source.file}</li>)}</ul>}
      {result.diagnostics.length > 0 && <><h3>Diagnostics</h3><ul>{result.diagnostics.map((diagnostic, index) =>
        <li key={`${diagnostic.code}-${index}`}><strong>{diagnostic.severity}</strong>: {diagnostic.message}{diagnostic.file ? ` (${diagnostic.file})` : ""}</li>)}</ul></>}
    </div>}
    {canUpdate && modelText && <div className="mt-3">
      <label className="form-label" htmlFor="expected-model-draft">Review and edit expected model JSON</label>
      {draftConflicts.length > 0 && <div className="alert alert-warning" role="alert">Recommendation IDs already exist and were preserved unchanged: {draftConflicts.join(", ")}. Review the existing requirement before editing.</div>}
      <textarea id="expected-model-draft" className="form-control font-monospace" rows={12} value={modelText}
        onChange={(event) => { setModelText(event.target.value); setSaved(false); }} spellCheck={false} />
      <p className="small text-muted mt-2">Review and edit this draft. Inferred suggestions become user-confirmed only when you select them, provide exact metric names or paths, and explicitly save. Existing project requirements remain unchanged until save succeeds.</p>
      <button className="btn btn-primary" type="button" disabled={!modelToSave || busy} onClick={() => void save()}>
        {busy ? "Saving…" : "Save reviewed expected model"}
      </button>
      {saved && <span className="ms-2 text-success" role="status">Saved. The next scan will use this project model.</span>}
    </div>}
  </section>;
}

function isExistingModelPresent(value: unknown): boolean {
  return value !== null && value !== undefined && !(typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}
