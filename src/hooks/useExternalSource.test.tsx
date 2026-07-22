import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ExternalSourceProvider } from "../domain/externalSources";
import { createExternalSourceHost } from "../services/externalSourceHost";
import { persistExternalSourceSnapshot } from "../services/externalSourceSnapshotStore";
import { useExternalSource } from "./useExternalSource";

interface Item {
  readonly id: string;
}

const cached = { id: "cached" };
const fresh = { id: "fresh" };
const connectionId = "github.example/alice";

function providerWith(
  load: ExternalSourceProvider<Item>["load"]
): ExternalSourceProvider<Item> {
  return {
    id: "test-provider",
    title: "Test provider",
    decodeItem(value) {
      if (!value || typeof value !== "object") {
        return null;
      }
      const { id } = value as Partial<Item>;
      return typeof id === "string" ? { id } : null;
    },
    keyOf: (item, account) => ({
      providerId: "test-provider",
      connectionId: account,
      remoteId: item.id
    }),
    canComplete: () => false,
    normalizeSettings: (value) => value,
    project: () => [],
    load
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

it("shows cached state while disabled without acquiring a network lease", async () => {
  const load = vi.fn().mockResolvedValue([fresh]);
  const provider = providerWith(load);
  persistExternalSourceSnapshot(
    provider.id,
    connectionId,
    [cached],
    new Date("2026-07-22T00:00:00.000Z")
  );
  const handle = createExternalSourceHost(provider, connectionId);
  const { result } = renderHook(() => useExternalSource(handle, false));

  expect(result.current.items).toEqual([cached]);
  expect(load).not.toHaveBeenCalled();

  await act(() => handle.refresh());
  expect(result.current.items).toEqual([fresh]);
});

it("acquires and releases the host as enabled changes", async () => {
  const signals: AbortSignal[] = [];
  const load = vi.fn<ExternalSourceProvider<Item>["load"]>()
    .mockImplementation(({ signal }) => {
      signals.push(signal);
      return new Promise(() => undefined);
    });
  const handle = createExternalSourceHost(providerWith(load), connectionId);
  const { rerender, unmount } = renderHook(
    ({ enabled }) => useExternalSource(handle, enabled),
    { initialProps: { enabled: true } }
  );

  await waitFor(() => expect(load).toHaveBeenCalledOnce());
  rerender({ enabled: false });
  expect(signals[0]?.aborted).toBe(true);

  rerender({ enabled: true });
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  unmount();
  expect(signals[1]?.aborted).toBe(true);
});

it("returns a stable empty state when no handle is available", () => {
  const { result, rerender } = renderHook(() => useExternalSource<Item>(null, true));
  const initial = result.current;

  rerender();

  expect(result.current).toBe(initial);
  expect(result.current).toMatchObject({
    items: [],
    loaded: false,
    loading: false,
    error: null,
    syncedAt: null
  });
});
