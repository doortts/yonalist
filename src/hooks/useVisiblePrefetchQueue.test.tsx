import { render } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVisiblePrefetchQueue } from "./useVisiblePrefetchQueue";
import type { VisiblePrefetchQueueStats } from "./useVisiblePrefetchQueue";

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

type StringEntry = { key: string; value: string };

interface HarnessProps {
  entries: StringEntry[];
  enabled?: boolean;
  dwellMs?: number;
  evictionMs?: number;
  maxConcurrentPrefetches?: number;
  rescheduleSignature?: string;
  prefetchEntry: (value: string) => Promise<boolean>;
  shouldPrefetch?: (value: string) => boolean;
  isProtected?: (value: string) => boolean;
  onEvicted?: (value: string) => void;
  onError?: (message: string) => void;
  onGetStats?: (getStats: () => VisiblePrefetchQueueStats) => void;
}

function Harness({
  entries,
  enabled = true,
  dwellMs,
  evictionMs,
  maxConcurrentPrefetches,
  rescheduleSignature,
  prefetchEntry,
  shouldPrefetch,
  isProtected,
  onEvicted,
  onError,
  onGetStats
}: HarnessProps) {
  const getStats = useVisiblePrefetchQueue<string>({
    entries,
    enabled,
    dwellMs,
    evictionMs,
    maxConcurrentPrefetches,
    rescheduleSignature,
    prefetchEntry,
    shouldPrefetch,
    isProtected,
    onEvicted,
    onError
  });
  useEffect(() => {
    onGetStats?.(getStats);
  }, [onGetStats, getStats]);
  return null;
}

function entry(key: string): StringEntry {
  return { key, value: key };
}

describe("useVisiblePrefetchQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("runs prefetchEntry only after the dwell delay", async () => {
    const prefetchEntry = vi.fn().mockResolvedValue(true);
    render(<Harness entries={[entry("a")]} prefetchEntry={prefetchEntry} />);

    await vi.advanceTimersByTimeAsync(999);
    expect(prefetchEntry).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(prefetchEntry).toHaveBeenCalledTimes(1);
    expect(prefetchEntry).toHaveBeenCalledWith("a");
  });

  it("cancels dwell when an entry leaves before the delay", async () => {
    const prefetchEntry = vi.fn().mockResolvedValue(true);
    const { rerender } = render(
      <Harness entries={[entry("a")]} prefetchEntry={prefetchEntry} />
    );

    await vi.advanceTimersByTimeAsync(500);
    rerender(<Harness entries={[]} prefetchEntry={prefetchEntry} />);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(prefetchEntry).not.toHaveBeenCalled();
  });

  it("never re-prefetches an entry whose key is unchanged", async () => {
    const prefetchEntry = vi.fn().mockResolvedValue(true);
    const { rerender } = render(
      <Harness entries={[entry("a")]} prefetchEntry={prefetchEntry} />
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(prefetchEntry).toHaveBeenCalledTimes(1);

    rerender(<Harness entries={[entry("a")]} prefetchEntry={prefetchEntry} />);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(prefetchEntry).toHaveBeenCalledTimes(1);
  });

  it("treats a changed key as a new entry", async () => {
    const prefetchEntry = vi.fn().mockResolvedValue(true);
    const { rerender } = render(
      <Harness entries={[entry("a")]} prefetchEntry={prefetchEntry} />
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(prefetchEntry).toHaveBeenCalledTimes(1);

    rerender(<Harness entries={[entry("b")]} prefetchEntry={prefetchEntry} />);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(prefetchEntry).toHaveBeenCalledTimes(2);
    expect(prefetchEntry).toHaveBeenLastCalledWith("b");
  });

  it("caps concurrency at maxConcurrentPrefetches and drains as promises settle", async () => {
    const resolvers: Array<(value: boolean) => void> = [];
    const prefetchEntry = vi.fn(
      () => new Promise<boolean>((resolve) => resolvers.push(resolve))
    );
    const entries = Array.from({ length: 6 }, (_, index) =>
      entry(String(index + 1))
    );

    render(
      <Harness
        entries={entries}
        prefetchEntry={prefetchEntry}
        maxConcurrentPrefetches={3}
      />
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(prefetchEntry).toHaveBeenCalledTimes(3);

    resolvers.shift()?.(true);
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();
    await flushPromises();

    expect(prefetchEntry).toHaveBeenCalledTimes(4);
  });

  it("defaults the cap to 4", async () => {
    const prefetchEntry = vi.fn(() => new Promise<boolean>(() => undefined));
    const entries = Array.from({ length: 6 }, (_, index) =>
      entry(String(index + 1))
    );

    render(<Harness entries={entries} prefetchEntry={prefetchEntry} />);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(prefetchEntry).toHaveBeenCalledTimes(4);
  });

  it("marks entries cached only when prefetchEntry resolves true", async () => {
    const prefetchEntry = vi.fn().mockResolvedValue(false);
    const { rerender } = render(
      <Harness
        entries={[entry("a")]}
        prefetchEntry={prefetchEntry}
        rescheduleSignature="v1"
      />
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(prefetchEntry).toHaveBeenCalledTimes(1);

    // The entry never left the visible list (eviction-free), but because the
    // last attempt did not resolve true it was not cached, so a later
    // scheduling pass re-arms the dwell and refetches — mirroring the
    // commentsError retry semantics.
    rerender(
      <Harness
        entries={[entry("a")]}
        prefetchEntry={prefetchEntry}
        rescheduleSignature="v2"
      />
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(prefetchEntry).toHaveBeenCalledTimes(2);
  });

  it("evicts after evictionMs off-screen: clears cached state, calls onEvicted, and forgets the entry", async () => {
    const onEvicted = vi.fn();
    const prefetchEntry = vi.fn().mockResolvedValue(true);
    const { rerender } = render(
      <Harness
        entries={[entry("a")]}
        prefetchEntry={prefetchEntry}
        onEvicted={onEvicted}
      />
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(prefetchEntry).toHaveBeenCalledTimes(1);

    rerender(
      <Harness entries={[]} prefetchEntry={prefetchEntry} onEvicted={onEvicted} />
    );
    await vi.advanceTimersByTimeAsync(599_999);
    expect(onEvicted).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onEvicted).toHaveBeenCalledWith("a");

    // Entry was forgotten: returning to view re-prefetches.
    rerender(
      <Harness
        entries={[entry("a")]}
        prefetchEntry={prefetchEntry}
        onEvicted={onEvicted}
      />
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(prefetchEntry).toHaveBeenCalledTimes(2);
  });

  it("returning before evictionMs keeps the warm entry", async () => {
    const onEvicted = vi.fn();
    const prefetchEntry = vi.fn().mockResolvedValue(true);
    const { rerender } = render(
      <Harness
        entries={[entry("a")]}
        prefetchEntry={prefetchEntry}
        onEvicted={onEvicted}
      />
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(prefetchEntry).toHaveBeenCalledTimes(1);

    rerender(
      <Harness entries={[]} prefetchEntry={prefetchEntry} onEvicted={onEvicted} />
    );
    await vi.advanceTimersByTimeAsync(300_000);
    rerender(
      <Harness
        entries={[entry("a")]}
        prefetchEntry={prefetchEntry}
        onEvicted={onEvicted}
      />
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(onEvicted).not.toHaveBeenCalled();
    expect(prefetchEntry).toHaveBeenCalledTimes(1);
  });

  it("never evicts protected entries and evicts normally after protection lifts", async () => {
    const onEvicted = vi.fn();
    const prefetchEntry = vi.fn().mockResolvedValue(true);

    const { rerender } = render(
      <Harness
        entries={[entry("a")]}
        prefetchEntry={prefetchEntry}
        onEvicted={onEvicted}
        isProtected={(value) => value === "a"}
        rescheduleSignature="s1"
      />
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(prefetchEntry).toHaveBeenCalledTimes(1);

    // Off-screen but protected: no eviction even after a full eviction window.
    rerender(
      <Harness
        entries={[]}
        prefetchEntry={prefetchEntry}
        onEvicted={onEvicted}
        isProtected={(value) => value === "a"}
        rescheduleSignature="s2"
      />
    );
    await vi.advanceTimersByTimeAsync(600_000);
    expect(onEvicted).not.toHaveBeenCalled();

    // Protection lifts (drive via rescheduleSignature); now it evicts.
    rerender(
      <Harness
        entries={[]}
        prefetchEntry={prefetchEntry}
        onEvicted={onEvicted}
        isProtected={() => false}
        rescheduleSignature="s3"
      />
    );
    await vi.advanceTimersByTimeAsync(600_000);
    expect(onEvicted).toHaveBeenCalledWith("a");
  });

  it("reports onError with the thrown message and still drains the queue", async () => {
    const onError = vi.fn();
    const prefetchEntry = vi.fn((value: string) =>
      value === "a"
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(true)
    );

    render(
      <Harness
        entries={[entry("a"), entry("b")]}
        prefetchEntry={prefetchEntry}
        maxConcurrentPrefetches={1}
        onError={onError}
      />
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    await flushPromises();

    expect(onError).toHaveBeenCalledWith("boom");
    expect(prefetchEntry).toHaveBeenCalledTimes(2);
    expect(prefetchEntry).toHaveBeenLastCalledWith("b");
  });

  it("exposes settled stats through a stable getter and survives StrictMode double effects", async () => {
    const getters: Array<() => VisiblePrefetchQueueStats> = [];
    const onGetStats = (getStats: () => VisiblePrefetchQueueStats) => {
      getters.push(getStats);
    };
    const prefetchEntry = vi.fn().mockResolvedValue(true);

    const { rerender } = render(
      <StrictMode>
        <Harness
          entries={[entry("a")]}
          prefetchEntry={prefetchEntry}
          onGetStats={onGetStats}
          rescheduleSignature="r1"
        />
      </StrictMode>
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();

    const getStats = getters[getters.length - 1];
    const settled = getStats();
    expect(settled).toEqual(
      expect.objectContaining({
        enabled: true,
        visible: 1,
        cached: 1,
        completed: 1
      })
    );

    // A scheduling pass that changes nothing observable keeps both the getter
    // identity (no re-render churn) and the reported values unchanged.
    rerender(
      <StrictMode>
        <Harness
          entries={[entry("a")]}
          prefetchEntry={prefetchEntry}
          onGetStats={onGetStats}
          rescheduleSignature="r2"
        />
      </StrictMode>
    );
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();

    expect(getters[getters.length - 1]).toBe(getStats);
    expect(getStats()).toEqual(settled);
  });
});
