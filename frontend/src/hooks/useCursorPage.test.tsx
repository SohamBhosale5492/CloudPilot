import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Page } from "../types/api";
import { useCursorPage } from "./useCursorPage";

describe("useCursorPage", () => {
  it("requests one API cursor page at a time and supports next/back navigation", async () => {
    const load = vi.fn(async (cursor: string | undefined): Promise<Page<number>> => cursor
      ? { items: [3], hasMore: false }
      : { items: [1, 2], nextCursor: "opaque-cursor", hasMore: true });
    const { result } = renderHook(() => useCursorPage("things", load));
    await waitFor(() => expect(result.current.page?.items).toEqual([1, 2]));
    expect(result.current.page?.hasMore).toBe(true);
    act(() => result.current.next());
    await waitFor(() => expect(result.current.page?.items).toEqual([3]));
    expect(load).toHaveBeenLastCalledWith("opaque-cursor", expect.any(AbortSignal));
    act(() => result.current.previous());
    await waitFor(() => expect(result.current.page?.items).toEqual([1, 2]));
  });

  it("does not invent a next page when the server has no cursor", async () => {
    const load = vi.fn(async () => ({ items: ["only page"], hasMore: false }));
    const { result } = renderHook(() => useCursorPage("single", load));
    await waitFor(() => expect(result.current.page).not.toBeNull());
    act(() => result.current.next());
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("surfaces a broken hasMore response instead of treating a first page as complete", async () => {
    const load = vi.fn(async () => ({ items: ["partial"], hasMore: true } as Page<string>));
    const { result } = renderHook(() => useCursorPage("broken", load));
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect((result.current.error as Error).message).toMatch(/results may be incomplete/i);
    expect(result.current.page).toBeNull();
  });
});
