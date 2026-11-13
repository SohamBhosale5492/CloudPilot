import { useCallback } from "react";
import { useApi } from "../api/ApiProvider";
import { getErrorMessage } from "../api/client";
import { useCursorPage } from "../hooks/useCursorPage";
import { CursorPager } from "./CursorPager";

export function ProjectPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const api = useApi();
  const load = useCallback((cursor: string | undefined, signal: AbortSignal) => api.listProjects({ cursor, signal }), [api]);
  const state = useCursorPage("project-picker", load);
  return (
    <div className="project-picker">
      <label className="form-label" htmlFor="project-picker">Project</label>
      <select id="project-picker" className="form-select" value={value} onChange={(event) => onChange(event.target.value)} disabled={state.loading && !state.page}>
        <option value="">Choose a project…</option>
        {state.page?.items.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      {state.error != null && <div className="small text-danger mt-1">{getErrorMessage(state.error)}</div>}
      {state.page && <CursorPager hasMore={state.page.hasMore} canGoBack={state.canGoBack} loading={state.loading} onPrevious={state.previous} onNext={state.next} />}
    </div>
  );
}
