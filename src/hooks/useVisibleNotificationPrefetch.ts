import { useEffect, useMemo, useRef, useState } from "react";
import { warmMarkdownBodies } from "../components/MarkdownBody";
import type { ConversationComment } from "../domain/conversation";
import type { GitHubNotification } from "../domain/notifications";
import {
  fetchNotificationDetail,
  type NotificationDetailContent
} from "../services/notificationDetail";
import type { GithubConnection } from "./useGithubAuth";

const DEFAULT_DWELL_MS = 1_000;
const DEFAULT_EVICTION_MS = 600_000;
const DEFAULT_MAX_CONCURRENT_PREFETCHES = 4;

type Timer = ReturnType<typeof setTimeout>;

export interface UseVisibleNotificationPrefetchOptions {
  /**
   * Notifications the user is currently looking at, most-clickable first. The
   * Notifications pane is not virtualized, so the caller passes a capped top-N
   * slice of the filtered list rather than a measured viewport window.
   */
  visibleNotifications: GitHubNotification[];
  selectedId: string | null;
  connection: GithubConnection;
  online: boolean;
  enabled: boolean;
  dwellMs?: number;
  evictionMs?: number;
  maxConcurrentPrefetches?: number;
  onError?: (message: string) => void;
}

export interface VisibleNotificationPrefetchStats {
  enabled: boolean;
  visible: number;
  queued: number;
  active: number;
  cached: number;
  completed: number;
  totalDurationMs: number;
  lastDurationMs: number | null;
}

interface PrefetchEntry {
  key: string;
  notification: GitHubNotification;
}

interface LatestOptions
  extends Omit<UseVisibleNotificationPrefetchOptions, "visibleNotifications"> {
  dwellMs: number;
  evictionMs: number;
  maxConcurrentPrefetches: number;
}

/**
 * Cache identity for a notification's detail. It matches the
 * fetchNotificationDetail cache key inputs (apiBaseUrl, subject.url,
 * updated_at) so a bumped notification re-warms while an unchanged one does
 * not, plus an auth marker so switching accounts re-warms.
 */
function entryKey(
  notification: GitHubNotification,
  connection: GithubConnection
): string {
  return [
    connection.apiBaseUrl,
    connection.token.trim() ? "auth" : "anon",
    notification.subject.url ?? notification.id,
    notification.updated_at
  ].join("|");
}

function flattenComments(comments: ConversationComment[]): ConversationComment[] {
  return comments.flatMap((comment) => [
    comment,
    ...flattenComments(comment.replies ?? [])
  ]);
}

function markdownBodiesFromDetail(detail: NotificationDetailContent): string[] {
  return [detail.body, ...flattenComments(detail.comments).map((c) => c.body)];
}

/**
 * Warms the notification detail cache and pre-renders its markdown for rows the
 * user is actually looking at. It calls the same public
 * `fetchNotificationDetail` used at click time (which caches into its own LRU),
 * so prefetch never bypasses that cache's freshness rules. No local vault
 * persistence exists for notifications, so eviction simply forgets the row so a
 * returning notification re-warms; the detail LRU handles its own retention.
 */
export function useVisibleNotificationPrefetch(
  options: UseVisibleNotificationPrefetchOptions
): VisibleNotificationPrefetchStats {
  const dwellMs = options.dwellMs ?? DEFAULT_DWELL_MS;
  const evictionMs = options.evictionMs ?? DEFAULT_EVICTION_MS;
  const maxConcurrentPrefetches = Math.max(
    1,
    options.maxConcurrentPrefetches ?? DEFAULT_MAX_CONCURRENT_PREFETCHES
  );
  const active =
    options.enabled &&
    options.online &&
    Boolean(options.connection.token.trim());

  const [stats, setStats] = useState<VisibleNotificationPrefetchStats>({
    enabled: options.enabled,
    visible: 0,
    queued: 0,
    active: 0,
    cached: 0,
    completed: 0,
    totalDurationMs: 0,
    lastDurationMs: null
  });

  const entries = useMemo<PrefetchEntry[]>(
    () =>
      active
        ? options.visibleNotifications.map((notification) => ({
            key: entryKey(notification, options.connection),
            notification
          }))
        : [],
    [
      active,
      options.connection.apiBaseUrl,
      options.connection.token,
      options.visibleNotifications
    ]
  );
  const visibleSignature = entries.map((entry) => entry.key).join("\n");

  const latest = useRef<LatestOptions>({
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

  const entriesByKey = useRef(new Map<string, PrefetchEntry>());
  const visibleKeys = useRef(new Set<string>());
  const selectedKeys = useRef(new Set<string>());
  const dwellTimers = useRef(new Map<string, Timer>());
  const evictionTimers = useRef(new Map<string, Timer>());
  const pendingKeys = useRef<string[]>([]);
  const inflightKeys = useRef(new Set<string>());
  const prefetchedKeys = useRef(new Set<string>());
  const lastDurationMs = useRef<number | null>(null);
  const completedCount = useRef(0);
  const totalDurationMs = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    const nextVisibleKeys = new Set(entries.map((entry) => entry.key));
    const previousVisibleKeys = visibleKeys.current;

    for (const entry of entries) {
      entriesByKey.current.set(entry.key, entry);
      const eviction = evictionTimers.current.get(entry.key);
      if (eviction) {
        clearTimeout(eviction);
        evictionTimers.current.delete(entry.key);
      }
      if (
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

    // Track which known cache keys belong to the currently selected
    // notification so eviction leaves that row's warmed detail in place — even
    // once the selected row has scrolled out of the visible window.
    selectedKeys.current = new Set(
      latest.current.selectedId
        ? [...entriesByKey.current.values()]
            .filter(
              (entry) => entry.notification.id === latest.current.selectedId
            )
            .map((entry) => entry.key)
        : []
    );

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
    publishStats();
    // selectedId participates through selectedKeys above so an out-of-view
    // selected notification is not evicted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    visibleSignature,
    options.selectedId,
    dwellMs,
    evictionMs,
    maxConcurrentPrefetches
  ]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
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

  return stats;

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
    if (visibleKeys.current.has(key) || selectedKeys.current.has(key)) {
      return;
    }
    const timer = setTimeout(() => {
      evictionTimers.current.delete(key);
      if (visibleKeys.current.has(key) || selectedKeys.current.has(key)) {
        return;
      }
      prefetchedKeys.current.delete(key);
      inflightKeys.current.delete(key);
      entriesByKey.current.delete(key);
      publishStats();
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
    publishStats();
    drainPrefetchQueue();
  }

  function removePending(key: string) {
    const next = pendingKeys.current.filter((candidate) => candidate !== key);
    if (next.length !== pendingKeys.current.length) {
      pendingKeys.current = next;
      publishStats();
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
      void prefetchEntry(key);
    }
    publishStats();
  }

  async function prefetchEntry(key: string) {
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
      !current.online ||
      !current.connection.token.trim()
    ) {
      inflightKeys.current.delete(key);
      drainPrefetchQueue();
      return;
    }
    const startedAt =
      typeof performance === "undefined" ? Date.now() : performance.now();
    try {
      const detail = await fetchNotificationDetail({
        token: current.connection.token.trim(),
        apiBaseUrl: current.connection.apiBaseUrl,
        webBaseUrl: current.connection.webBaseUrl,
        notification: entry.notification
      });
      await warmMarkdownBodies(markdownBodiesFromDetail(detail));
      if (!detail.commentsError) {
        prefetchedKeys.current.add(key);
      }
    } catch (cause) {
      current.onError?.(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inflightKeys.current.delete(key);
      const endedAt =
        typeof performance === "undefined" ? Date.now() : performance.now();
      lastDurationMs.current = endedAt - startedAt;
      completedCount.current += 1;
      totalDurationMs.current += lastDurationMs.current;
      publishStats();
      drainPrefetchQueue();
    }
  }

  function publishStats() {
    if (!mounted.current) {
      return;
    }
    const next = {
      enabled: latest.current.enabled,
      visible: visibleKeys.current.size,
      queued: pendingKeys.current.length,
      active: inflightKeys.current.size,
      cached: prefetchedKeys.current.size,
      completed: completedCount.current,
      totalDurationMs: totalDurationMs.current,
      lastDurationMs: lastDurationMs.current
    };
    setStats((prev) =>
      prev.enabled === next.enabled &&
      prev.visible === next.visible &&
      prev.queued === next.queued &&
      prev.active === next.active &&
      prev.cached === next.cached &&
      prev.completed === next.completed &&
      prev.totalDurationMs === next.totalDurationMs &&
      prev.lastDurationMs === next.lastDurationMs
        ? prev
        : next
    );
  }
}
