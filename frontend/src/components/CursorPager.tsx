import { ChevronLeft, ChevronRight } from "lucide-react";

export function CursorPager({
  hasMore,
  canGoBack,
  loading,
  onPrevious,
  onNext
}: {
  hasMore: boolean;
  canGoBack: boolean;
  loading: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <nav className="cursor-pager" aria-label="Results pages">
      <button className="btn btn-outline-secondary btn-sm" onClick={onPrevious} disabled={!canGoBack || loading}>
        <ChevronLeft size={15} aria-hidden="true" /> Previous
      </button>
      <span className="text-muted small">{loading ? "Loading page…" : "Cursor-paginated results"}</span>
      <button className="btn btn-outline-secondary btn-sm" onClick={onNext} disabled={!hasMore || loading}>
        Next <ChevronRight size={15} aria-hidden="true" />
      </button>
    </nav>
  );
}
