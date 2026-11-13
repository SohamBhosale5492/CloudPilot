import { useCallback, useEffect, useMemo, useState } from "react";
import type { Page } from "../types/api";

export interface CursorPageState<T> {
  page: Page<T> | null;
  loading: boolean;
  error: unknown;
  canGoBack: boolean;
  next: () => void;
  previous: () => void;
  refresh: () => void;
}

interface NavigationState {
  queryKey: string;
  cursor: string | undefined;
  trail: Array<string | undefined>;
}
interface LoadedPage<T> {
  queryKey: string;
  cursor: string | undefined;
  refreshVersion: number;
  page: Page<T>;
}
interface LoadError {
  queryKey: string;
  cursor: string | undefined;
  refreshVersion: number;
  error: unknown;
}

/** Loads one server page at a time and retains opaque cursors for back/next navigation. */
export function useCursorPage<T>(
  queryKey: string,
  loadPage: (cursor: string | undefined, signal: AbortSignal) => Promise<Page<T>>
): CursorPageState<T> {
  const [navigation, setNavigation] = useState<NavigationState>({ queryKey, cursor: undefined, trail: [] });
  const [loaded, setLoaded] = useState<LoadedPage<T> | null>(null);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);

  const cursor = navigation.queryKey === queryKey ? navigation.cursor : undefined;
  const trail = useMemo(() => navigation.queryKey === queryKey ? navigation.trail : [], [navigation, queryKey]);
  const loading = Boolean(queryKey && (
    loaded?.queryKey !== queryKey || loaded.cursor !== cursor || loaded.refreshVersion !== refreshVersion
  ) && (loadError?.queryKey !== queryKey || loadError.cursor !== cursor || loadError.refreshVersion !== refreshVersion));
  const page = loaded?.queryKey === queryKey ? loaded.page : null;
  const error = loadError?.queryKey === queryKey && loadError.cursor === cursor && loadError.refreshVersion === refreshVersion
    ? loadError.error : null;

  useEffect(() => {
    if (!queryKey) return;
    const controller = new AbortController();
    void loadPage(cursor, controller.signal)
      .then((value) => {
        if (!Array.isArray(value.items) || typeof value.hasMore !== "boolean" ||
            (value.hasMore && (typeof value.nextCursor !== "string" || value.nextCursor.length === 0))) {
          throw new Error("The API returned an invalid cursor page; results may be incomplete.");
        }
        if (!controller.signal.aborted) setLoaded({ queryKey, cursor, refreshVersion, page: value });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setLoadError({ queryKey, cursor, refreshVersion, error: reason });
      });
    return () => controller.abort();
  }, [cursor, loadPage, queryKey, refreshVersion]);

  const next = useCallback(() => {
    if (!page?.hasMore || !page.nextCursor) return;
    setNavigation({ queryKey, cursor: page.nextCursor, trail: [...trail, cursor] });
  }, [cursor, page, queryKey, trail]);
  const previous = useCallback(() => {
    if (!trail.length) return;
    setNavigation({ queryKey, cursor: trail[trail.length - 1], trail: trail.slice(0, -1) });
  }, [queryKey, trail]);
  const refresh = useCallback(() => setRefreshVersion((version) => version + 1), []);

  return { page, loading, error, canGoBack: trail.length > 0, next, previous, refresh };
}
