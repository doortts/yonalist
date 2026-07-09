import { useMemo, useRef } from "react";
import { warmMarkdownBodies } from "../components/MarkdownBody";
import { flattenComments } from "../domain/conversation";
import type { GitHubNotification } from "../domain/notifications";
import {
  fetchNotificationDetail,
  type NotificationDetailContent
} from "../services/notificationDetail";
import type { GithubConnection } from "./useGithubAuth";
import {
  useVisiblePrefetchQueue,
  type VisiblePrefetchQueueStats
} from "./useVisiblePrefetchQueue";

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

export type VisibleNotificationPrefetchStats = VisiblePrefetchQueueStats;

interface PrefetchValue {
  key: string;
  notification: GitHubNotification;
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
  const active =
    options.enabled &&
    options.online &&
    Boolean(options.connection.token.trim());

  const latest = useRef(options);
  latest.current = options;

  const entries = useMemo(
    () =>
      active
        ? options.visibleNotifications.map((notification) => {
            const key = entryKey(notification, options.connection);
            return { key, value: { key, notification } };
          })
        : [],
    [
      active,
      options.connection.apiBaseUrl,
      options.connection.token,
      options.visibleNotifications
    ]
  );

  return useVisiblePrefetchQueue<PrefetchValue>({
    entries,
    enabled: options.enabled,
    dwellMs: options.dwellMs,
    evictionMs: options.evictionMs,
    maxConcurrentPrefetches: options.maxConcurrentPrefetches,
    // Deselecting a notification re-runs scheduling so a now-unprotected row
    // can begin evicting.
    rescheduleSignature: options.selectedId ?? "",
    // Run-time gate: never fetch unless still enabled, online, and authed.
    shouldPrefetch: () => {
      const current = latest.current;
      return (
        current.enabled &&
        current.online &&
        Boolean(current.connection.token.trim())
      );
    },
    // Keep the selected notification's warmed detail even after it leaves view.
    isProtected: (value) => value.notification.id === latest.current.selectedId,
    prefetchEntry: async (value) => {
      const current = latest.current;
      const detail = await fetchNotificationDetail({
        token: current.connection.token.trim(),
        apiBaseUrl: current.connection.apiBaseUrl,
        webBaseUrl: current.connection.webBaseUrl,
        notification: value.notification
      });
      await warmMarkdownBodies(markdownBodiesFromDetail(detail));
      return !detail.commentsError;
    },
    onError: options.onError
  });
}
