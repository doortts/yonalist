import { useCallback, useEffect, useMemo, useRef } from "react";

export const DEFAULT_DWELL_MS = 1_000;
export const DEFAULT_EVICTION_MS = 600_000;
export const DEFAULT_MAX_CONCURRENT_PREFETCHES = 4;

type Timer = ReturnType<typeof setTimeout>;

/** Monotonic when available; jsdom test environments may lack performance. */
function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

/** One thing the queue can warm: a stable cache `key` plus its payload. */
export interface VisiblePrefetchQueueEntry<E> {
  key: string;
  value: E;
}

export interface UseVisiblePrefetchQueueOptions<E> {
  /** Currently-visible entries, most-clickable first. */
  entries: Array<VisiblePrefetchQueueEntry<E>>;
  /** Master switch: dwell timers are only armed while this is true. */
  enabled: boolean;
  dwellMs?: number;
  evictionMs?: number;
  maxConcurrentPrefetches?: number;
  /**
   * An opaque string that, when changed, forces the scheduling effect to run
   * again even if the visible set is unchanged. Adapters fold caller state that
   * gates dwell re-arming or eviction (online status, selected row) into it so
   * those transitions are re-evaluated at the right time.
   */
  rescheduleSignature?: string;
  /** Warms the entry; resolves true only when it is now genuinely cached. */
  prefetchEntry: (value: E) => Promise<boolean>;
  /**
   * Run-time gate consulted at fire time (never at schedule time). Returning
   * false skips the fetch without counting toward completed/durations.
   */
  shouldPrefetch?: (value: E) => boolean;
  /** Entries for which this returns true are never evicted while protected. */
  isProtected?: (value: E) => boolean;
  /** Side effect run once an entry is actually evicted. */
  onEvicted?: (value: E) => void;
  onError?: (message: string) => void;
}

export interface VisiblePrefetchQueueStats {
  enabled: boolean;
  visible: number;
  queued: number;
  active: number;
  cached: number;
  completed: number;
  totalDurationMs: number;
  lastDurationMs: number | null;
}

interface LatestOptions<E> extends UseVisiblePrefetchQueueOptions<E> {
  dwellMs: number;
  evictionMs: number;
  maxConcurrentPrefetches: number;
}

/**
 * Shared machinery behind the visible-item and visible-notification prefetch
 * hooks: a dwell timer per visible entry, a concurrency-capped drain loop, an
 * off-screen eviction timer, and a pull-based stats getter. The two callers
 * are thin adapters that supply entry construction plus the per-entry prefetch
 * operation, protection rule, and eviction side effect.
 *
 * Returns a referentially-stable `getStats` function instead of stats state:
 * prefetch progress is bookkeeping, not UI state, and publishing it through
 * setState re-rendered the owning component (App) on every queue transition.
 * Consumers that display stats (the status bar) poll the getter instead.
 *
 * All caller callbacks (prefetchEntry/shouldPrefetch/isProtected/onEvicted/
 * onError) are read through `latest.current` at FIRE time, never captured in a
 * timer closure, so a row that scrolled back or a selection that moved is
 * always judged against current state rather than a stale render.
 */
export function useVisiblePrefetchQueue<E>(
  options: UseVisiblePrefetchQueueOptions<E>
): () => VisiblePrefetchQueueStats {
  const dwellMs = options.dwellMs ?? DEFAULT_DWELL_MS;
  const evictionMs = options.evictionMs ?? DEFAULT_EVICTION_MS;
  const maxConcurrentPrefetches = Math.max(
    1,
    options.maxConcurrentPrefetches ?? DEFAULT_MAX_CONCURRENT_PREFETCHES
  );

  const entries = options.entries;
  const visibleSignature = useMemo(
    () => entries.map((entry) => entry.key).join("\n"),
    [entries]
  );

  const latest = useRef<LatestOptions<E>>({
    ...options,
    dwellMs,
    evictionMs,
    maxConcurrentPrefetches
  });
  latest.current = {
    ...options,
    dwellMs,
    evictionMs,
    maxConcurrentPrefetches
  };

  const entriesByKey = useRef(new Map<string, VisiblePrefetchQueueEntry<E>>());
  const visibleKeys = useRef(new Set<string>());
  const dwellTimers = useRef(new Map<string, Timer>());
  const evictionTimers = useRef(new Map<string, Timer>());
  const pendingKeys = useRef<string[]>([]);
  const inflightKeys = useRef(new Set<string>());
  const prefetchedKeys = useRef(new Set<string>());
  const lastDurationMs = useRef<number | null>(null);
  const completedCount = useRef(0);
  const totalDurationMs = useRef(0);

  const getStats = useCallback(
    (): VisiblePrefetchQueueStats => ({
      enabled: latest.current.enabled,
      visible: visibleKeys.current.size,
      queued: pendingKeys.current.length,
      active: inflightKeys.current.size,
      cached: prefetchedKeys.current.size,
      completed: completedCount.current,
      totalDurationMs: totalDurationMs.current,
      lastDurationMs: lastDurationMs.current
    }),
    []
  );

  useEffect(() => {
    const nextVisibleKeys = new Set(entries.map((entry) => entry.key));
    const previousVisibleKeys = visibleKeys.current;

    for (const entry of entries) {
      // Re-register every visible entry each run so a returning row is known
      // again even after eviction pruned it from entriesByKey.
      entriesByKey.current.set(entry.key, entry);
      const eviction = evictionTimers.current.get(entry.key);
      if (eviction) {
        clearTimeout(eviction);
        evictionTimers.current.delete(entry.key);
      }
      // Dwell is only armed while enabled; already-cached, in-flight, or
      // already-dwelling keys are left alone.
      if (
        !options.enabled ||
        prefetchedKeys.current.has(entry.key) ||
        inflightKeys.current.has(entry.key) ||
        dwellTimers.current.has(entry.key)
      ) {
        continue;
      }
      const timer = setTimeout(() => {
        dwellTimers.current.delete(entry.key);
        enqueuePrefetch(entry.key);
      }, dwellMs);
      dwellTimers.current.set(entry.key, timer);
    }

    visibleKeys.current = nextVisibleKeys;

    for (const key of previousVisibleKeys) {
      if (!nextVisibleKeys.has(key)) {
        clearDwell(key);
        scheduleEviction(key);
      }
    }

    for (const key of prefetchedKeys.current) {
      if (!nextVisibleKeys.has(key)) {
        scheduleEviction(key);
      }
    }
    // rescheduleSignature folds in caller state (online, selected row) that
    // gates dwell re-arming and eviction, so those transitions re-run this
    // effect without listing every raw dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    visibleSignature,
    options.enabled,
    dwellMs,
    evictionMs,
    maxConcurrentPrefetches,
    options.rescheduleSignature
  ]);

  useEffect(() => {
    return () => {
      for (const timer of dwellTimers.current.values()) {
        clearTimeout(timer);
      }
      for (const timer of evictionTimers.current.values()) {
        clearTimeout(timer);
      }
      dwellTimers.current.clear();
      evictionTimers.current.clear();
      pendingKeys.current = [];
    };
  }, []);

  return getStats;

  function clearDwell(key: string) {
    const timer = dwellTimers.current.get(key);
    if (timer) {
      clearTimeout(timer);
      dwellTimers.current.delete(key);
    }
  }

  function scheduleEviction(key: string) {
    removePending(key);
    if (!prefetchedKeys.current.has(key) && !inflightKeys.current.has(key)) {
      return;
    }
    if (evictionTimers.current.has(key)) {
      return;
    }
    const entry = entriesByKey.current.get(key);
    if (!entry || visibleKeys.current.has(key)) {
      return;
    }
    // Protection is consulted through latest.current both here (arming) and
    // when the timer fires, so a still-selected row never starts evicting.
    if (latest.current.isProtected?.(entry.value)) {
      return;
    }
    const timer = setTimeout(() => {
      evictionTimers.current.delete(key);
      const latestEntry = entriesByKey.current.get(key);
      const current = latest.current;
      if (
        !latestEntry ||
        visibleKeys.current.has(key) ||
        current.isProtected?.(latestEntry.value)
      ) {
        return;
      }
      prefetchedKeys.current.delete(key);
      inflightKeys.current.delete(key);
      current.onEvicted?.(latestEntry.value);
      // Forget the entry after the side effect: the visibility effect
      // re-registers it if it ever comes back, so this is safe and avoids the
      // entriesByKey leak an evict-without-prune would cause.
      entriesByKey.current.delete(key);
    }, latest.current.evictionMs);
    evictionTimers.current.set(key, timer);
  }

  function enqueuePrefetch(key: string) {
    if (
      pendingKeys.current.includes(key) ||
      inflightKeys.current.has(key) ||
      prefetchedKeys.current.has(key)
    ) {
      return;
    }
    pendingKeys.current.push(key);
    drainPrefetchQueue();
  }

  function removePending(key: string) {
    const next = pendingKeys.current.filter((candidate) => candidate !== key);
    if (next.length !== pendingKeys.current.length) {
      pendingKeys.current = next;
    }
  }

  function drainPrefetchQueue() {
    const maxConcurrent = latest.current.maxConcurrentPrefetches;
    while (
      inflightKeys.current.size < maxConcurrent &&
      pendingKeys.current.length > 0
    ) {
      const key = pendingKeys.current.shift() as string;
      if (
        inflightKeys.current.has(key) ||
        prefetchedKeys.current.has(key) ||
        !entriesByKey.current.get(key)
      ) {
        continue;
      }
      inflightKeys.current.add(key);
      void runPrefetch(key);
    }
  }

  async function runPrefetch(key: string) {
    if (prefetchedKeys.current.has(key)) {
      inflightKeys.current.delete(key);
      drainPrefetchQueue();
      return;
    }
    const entry = entriesByKey.current.get(key);
    const current = latest.current;
    if (
      !entry ||
      !current.enabled ||
      (current.shouldPrefetch && !current.shouldPrefetch(entry.value))
    ) {
      inflightKeys.current.delete(key);
      drainPrefetchQueue();
      return;
    }
    const startedAt = nowMs();
    try {
      const cached = await current.prefetchEntry(entry.value);
      if (cached) {
        prefetchedKeys.current.add(key);
      }
    } catch (cause) {
      current.onError?.(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inflightKeys.current.delete(key);
      lastDurationMs.current = nowMs() - startedAt;
      completedCount.current += 1;
      totalDurationMs.current += lastDurationMs.current;
      drainPrefetchQueue();
    }
  }
}
