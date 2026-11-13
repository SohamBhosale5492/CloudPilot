import { useState } from "react";
import { useApi } from "../api/ApiProvider";
import { getErrorMessage } from "../api/client";
import type { ProjectTargetConfig } from "../types/api";
import { localPhase01TargetExample, validateTelemetryTargetConfig } from "../utils/target-config";

interface Props {
  projectId: string;
  current: unknown;
  expectedModel: unknown;
  canUpdate: boolean;
  onSaved(): void;
}

export function TelemetryTargetConfigPanel({ projectId, current, expectedModel, canUpdate, onSaved }: Props) {
  const api = useApi();
  const [editing, setEditing] = useState(false);
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const parsed: unknown = parse(json);
  const validation = editing && json ? validateTelemetryTargetConfig(parsed) : "";

  function beginEdit() {
    setJson(JSON.stringify(current && typeof current === "object" && !Array.isArray(current) ? current : {}, null, 2));
    setError(null); setSaved(false); setEditing(true);
  }

  async function save() {
    if (validation || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    setBusy(true); setError(null);
    try {
      await api.saveProjectTargetConfig(projectId, parsed as ProjectTargetConfig);
      setSaved(true); setEditing(false); onSaved();
    } catch (cause) { setError(getErrorMessage(cause)); }
    finally { setBusy(false); }
  }

  return <section className="surface-panel mb-4" aria-labelledby="telemetry-target-title">
    <div className="section-heading"><div><h2 id="telemetry-target-title">Telemetry targets</h2>
      <p>Live scans can inspect Prometheus request metrics, HTTP health, and Jaeger traces. Logs and alerts remain unknown unless an inspector is configured.</p></div>
      {canUpdate && !editing && <button className="btn btn-outline-primary" type="button" onClick={beginEdit}>Edit telemetry targets</button>}
    </div>
    <ul>
      <li>Prometheus: {configured(current, "prometheusBaseUrl") ? "configured" : "not configured"}</li>
      <li>HTTP health endpoint base: {configured(current, "healthBaseUrl") ? "configured" : "not configured"}</li>
      <li>Jaeger trace backend: {configured(current, "traceBackendUrl") ? "configured" : "not configured"}</li>
      <li>Per-requirement metric rules: {metricConfigCount(current)}</li>
    </ul>
    {!canUpdate && <p className="text-muted">Your role cannot change project telemetry targets.</p>}
    {editing && <>
      <p className="small text-muted">Use HTTP or HTTPS URLs. Do not include credentials. Private/local targets are allowed by the current scan runner. Metric config keys must match metric requirement IDs.</p>
      <p className="small">Local Phase 01 example: Prometheus at <code>http://127.0.0.1:9090</code>; demo service at <code>http://127.0.0.1:3000</code>. Confirm these addresses are reachable from the backend process.</p>
      <button className="btn btn-sm btn-outline-secondary mb-2" type="button" onClick={() => setJson(JSON.stringify(localPhase01TargetExample(expectedModel), null, 2))}>Load Phase 01 local lab example</button>
      <label className="form-label d-block" htmlFor="project-target-config">Target configuration JSON</label>
      <textarea id="project-target-config" className="form-control font-monospace" rows={12} value={json}
        onChange={(event) => { setJson(event.target.value); setSaved(false); }} spellCheck={false} />
      {validation && validation !== "" && <div className="text-danger mt-2" role="alert">{validation}</div>}
      {error && <div className="alert alert-danger mt-2" role="alert">{error}</div>}
      <div className="form-actions"><button className="btn btn-primary" type="button" disabled={Boolean(validation) || busy || !json} onClick={() => void save()}>{busy ? "Saving…" : "Save telemetry targets"}</button>
        <button className="btn btn-outline-secondary" type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button></div>
    </>}
    {saved && <p className="text-success" role="status">Telemetry targets saved. New scans will use this configuration.</p>}
    {!editing && error && <div className="alert alert-danger" role="alert">{error}</div>}
  </section>;
}

function parse(value: string): unknown {
  if (!value.trim()) return null;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function configured(value: unknown, key: "prometheusBaseUrl" | "healthBaseUrl" | "traceBackendUrl"): boolean {
  return Boolean(value && typeof value === "object" && key in value && typeof (value as Record<string, unknown>)[key] === "string");
}

function metricConfigCount(value: unknown): string {
  const configs = value && typeof value === "object" ? (value as Record<string, unknown>).metricConfigs : null;
  return configs && typeof configs === "object" && !Array.isArray(configs) ? `${Object.keys(configs).length} configured` : "0 configured";
}
