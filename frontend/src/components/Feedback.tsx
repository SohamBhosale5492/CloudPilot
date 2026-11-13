import { getErrorMessage } from "../api/client";

export function Loading({ label = "Loading" }: { label?: string }) {
  return <div className="state-block" role="status"><span className="spinner-border spinner-border-sm me-2" />{label}…</div>;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="alert alert-danger d-flex align-items-start justify-content-between gap-3" role="alert">
      <span>{getErrorMessage(error)}</span>
      {onRetry && <button className="btn btn-sm btn-outline-danger" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><strong>{title}</strong><p>{detail}</p></div>;
}

export function NotFoundState({ label }: { label: string }) {
  return <div className="alert alert-warning" role="status">{label} was not found or is not available to this tenant.</div>;
}
