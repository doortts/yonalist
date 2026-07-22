import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalSourceProvider } from "../domain/externalSources";
import {
  EXTERNAL_SOURCE_COMPLETION_ERROR,
  EXTERNAL_SOURCE_REFRESH_ERROR,
  createExternalSourceHost,
  toExternalSourcePublicError
} from "./externalSourceHost";
import {
  loadExternalSourceSnapshot,
  persistExternalSourceSnapshot
} from "./externalSourceSnapshotStore";

interface Item {
  readonly id: string;
  readonly title: string;
}

const connectionId = "github.example/alice";
const cached = { id: "cached", title: "Cached" };
const partial = { id: "partial", title: "Partial" };
const first = { id: "first", title: "First" };
const second = { id: "second", title: "Second" };
const syncedAt = new Date("2026-07-21T23:00:00.000Z");
const now = new Date("2026-07-22T00:00:00.000Z");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
      const { id, title } = value as Partial<Item>;
      return typeof id === "string" && typeof title === "string"
        ? { id, title }
        : null;
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

describe("external source host", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one request and one poll timer across two leases", async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValue([first]);
    const handle = createExternalSourceHost(providerWith(load), connectionId, {
      pollIntervalMs: 60_000,
      now: () => now
    });

    const releaseA = handle.acquire();
    const releaseB = handle.acquire();

    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(2);

    releaseA();
    releaseB();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent refreshes", async () => {
    const pending = deferred<readonly Item[]>();
    const load = vi.fn(() => pending.promise);
    const handle = createExternalSourceHost(providerWith(load), connectionId);

    const refreshA = handle.refresh();
    const refreshB = handle.refresh();

    expect(refreshB).toBe(refreshA);
    expect(load).toHaveBeenCalledOnce();
    pending.resolve([first]);
    await refreshA;
  });

  it("restores a cached snapshot without changing snapshot references", () => {
    const provider = providerWith(vi.fn().mockResolvedValue([]));
    persistExternalSourceSnapshot(provider.id, connectionId, [cached], syncedAt);

    const handle = createExternalSourceHost(provider, connectionId);
    const state = handle.getState();

    expect(state).toMatchObject({
      items: [cached],
      loaded: true,
      loading: false,
      error: null,
      syncedAt: syncedAt.toISOString()
    });
    expect(handle.getState()).toBe(state);
  });

  it("shows partial rows but preserves the previous complete cache on failure", async () => {
    const provider = providerWith(async ({ publishPartial }) => {
      publishPartial([partial]);
      throw new Error("page 2 failed");
    });
    persistExternalSourceSnapshot(provider.id, connectionId, [cached], syncedAt);
    const handle = createExternalSourceHost(provider, connectionId);

    await expect(handle.refresh()).rejects.toThrow(EXTERNAL_SOURCE_REFRESH_ERROR);

    expect(handle.getState()).toMatchObject({
      items: [partial],
      loaded: true,
      loading: false,
      error: EXTERNAL_SOURCE_REFRESH_ERROR,
      syncedAt: syncedAt.toISOString()
    });
    expect(
      loadExternalSourceSnapshot(provider.id, connectionId, provider.decodeItem)
        ?.items
    ).toEqual([cached]);
  });

  it("never exposes provider secrets through public load errors", async () => {
    const provider = providerWith(
      vi.fn().mockRejectedValue(
        new Error("ghp_secret: upstream body at /Users/alice/private/response.json")
      )
    );
    const handle = createExternalSourceHost(provider, connectionId);

    await expect(handle.refresh()).rejects.toThrow(EXTERNAL_SOURCE_REFRESH_ERROR);

    expect(handle.getState().error).toBe(EXTERNAL_SOURCE_REFRESH_ERROR);
    expect(JSON.stringify(handle.getState())).not.toMatch(
      /ghp_secret|upstream body|\/Users\/alice/
    );
  });

  it("replaces the displayed and persisted complete snapshot", async () => {
    const load = vi
      .fn<ExternalSourceProvider<Item>["load"]>()
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([first]);
    const provider = providerWith(load);
    const handle = createExternalSourceHost(provider, connectionId, {
      now: () => now
    });

    await handle.refresh();
    await handle.refresh();

    expect(handle.getState().items).toEqual([first]);
    expect(
      loadExternalSourceSnapshot(provider.id, connectionId, provider.decodeItem)
        ?.items
    ).toEqual([first]);
  });

  it("aborts the active request on final release without exposing an error", async () => {
    const load = vi.fn<ExternalSourceProvider<Item>["load"]>()
      .mockImplementation(({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("provider cancellation detail", "AbortError"));
          });
        })
      );
    const handle = createExternalSourceHost(providerWith(load), connectionId);
    const release = handle.acquire();

    release();
    await Promise.resolve();
    await Promise.resolve();

    expect(load.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(handle.getState()).toMatchObject({ loading: false, error: null });
  });

  it("ignores a late response after disposal", async () => {
    const pending = deferred<readonly Item[]>();
    const provider = providerWith(vi.fn(() => pending.promise));
    const handle = createExternalSourceHost(provider, connectionId, {
      now: () => now
    });
    const listener = vi.fn();
    handle.subscribe(listener);
    const refresh = handle.refresh();
    const stateBeforeDispose = handle.getState();

    handle.dispose();
    listener.mockClear();
    pending.resolve([first]);
    await refresh;

    expect(listener).not.toHaveBeenCalled();
    expect(handle.getState()).toBe(stateBeforeDispose);
    expect(
      loadExternalSourceSnapshot(provider.id, connectionId, provider.decodeItem)
    ).toBeNull();
  });
});

describe("external source public errors", () => {
  it("maps aborts to null and all other causes to fixed messages", () => {
    expect(
      toExternalSourcePublicError(
        "refresh",
        new DOMException("sensitive cancellation", "AbortError")
      )
    ).toBeNull();
    expect(toExternalSourcePublicError("refresh", "sensitive response")).toBe(
      EXTERNAL_SOURCE_REFRESH_ERROR
    );
    expect(toExternalSourcePublicError("completion", new Error("secret"))).toBe(
      EXTERNAL_SOURCE_COMPLETION_ERROR
    );
  });
});
