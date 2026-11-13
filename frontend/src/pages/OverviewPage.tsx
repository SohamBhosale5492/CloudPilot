import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, HeartPulse, Server } from "lucide-react";
import { Link } from "react-router-dom";
import { useApi } from "../api/ApiProvider";
import type { HealthResponse } from "../types/api";
import { Loading } from "../components/Feedback";
import { PageHeading, SectionHeading } from "../layouts/AppShell";

export function OverviewPage() {
  const api = useApi();
  const [health, setHealth] = useState<{ live?: HealthResponse; ready?: HealthResponse; error?: string }>({});
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([api.liveness(controller.signal), api.readiness(controller.signal)])
      .then(([live, ready]) => {
        if (controller.signal.aborted) return;
        setHealth({
          ...(live.status === "fulfilled" ? { live: live.value } : { error: "Liveness check unavailable." }),
          ...(ready.status === "fulfilled" ? { ready: ready.value } : { error: "Readiness check unavailable." })
        });
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api]);

  return <>
    <PageHeading title="Overview" description="A live view of the CloudPilot API and workspace entry points." />
    <div className="overview-status-panel">
      <SectionHeading title="Service health" detail="Reported by the configured CloudPilot API." />
      {loading ? <Loading label="Checking service health" /> : <div className="health-grid">
        <HealthLine icon={<HeartPulse size={17} />} label="Liveness" status={health.live?.status ?? "unavailable"} />
        <HealthLine icon={<Server size={17} />} label="Readiness" status={health.ready?.status ?? "unavailable"} />
      </div>}
      {health.error && <p className="small text-muted mt-3 mb-0">{health.error}</p>}
    </div>
    <div className="overview-note">
      <div><span className="eyebrow">WORKSPACE</span><h2>Start with a project</h2><p>Open a project to review its scan history, findings, and available remediation records.</p></div>
      <Link className="btn btn-outline-primary" to="/projects">Browse projects <ArrowRight size={15} /></Link>
    </div>
    <p className="data-provenance-note">No aggregate counts are shown because the API does not provide an aggregate dashboard endpoint.</p>
  </>;
}

function HealthLine({ icon, label, status }: { icon: ReactNode; label: string; status: string }) {
  const ok = status === "ok" || status === "ready";
  return <div className="health-line"><div className="health-icon">{icon}</div><div><span>{label}</span><strong className={ok ? "text-success" : "text-secondary"}>{status}</strong></div><span className={`health-indicator ${ok ? "up" : "down"}`} /></div>;
}
