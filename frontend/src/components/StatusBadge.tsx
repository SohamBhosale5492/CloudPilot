import type { ScanStatus, FindingOutcome, RemediationStatus } from "../types/api";

const CLASS_BY_STATUS: Record<string, string> = {
  pending: "status-pending",
  running: "status-running",
  completed: "status-completed",
  failed: "status-failed",
  pass: "status-completed",
  gap: "status-failed",
  unknown: "status-pending",
  inconclusive: "status-muted",
  open: "status-running",
  merged: "status-completed",
  closed: "status-muted"
};

export function StatusBadge({ status }: { status: ScanStatus | FindingOutcome | RemediationStatus | string }) {
  return <span className={`status-badge ${CLASS_BY_STATUS[status] ?? "status-muted"}`}>{status.replaceAll("_", " ")}</span>;
}
