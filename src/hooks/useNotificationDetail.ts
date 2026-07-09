import { useEffect, useRef, useState } from "react";
import type { GithubConnection } from "./useGithubAuth";
import type { GitHubNotification } from "../domain/notifications";
import { sampleNotificationDetail } from "../fixtures/sampleNotifications";
import {
  fetchNotificationDetail,
  getCachedNotificationDetail,
  getLatestCachedNotificationDetail,
  type NotificationDetailContent
} from "../services/notificationDetail";

export interface UseNotificationDetailResult {
  detail: NotificationDetailContent | null;
  loading: boolean;
  error: string | null;
  /**
   * Reserved for visible refresh affordances. Background revalidation keeps
   * this false so the detail pane does not flash loading UI.
   */
  refreshing: boolean;
}

/** Loads the conversation for the selected notification through the GitHub API. */
export function useNotificationDetail(
  notification: GitHubNotification | null,
  connection: GithubConnection,
  online: boolean,
  refreshKey = 0
): UseNotificationDetailResult {
  const [detail, setDetail] = useState<NotificationDetailContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const lastRefreshContext = useRef<{ key: string | null; refreshKey: number }>({
    key: null,
    refreshKey: 0
  });
  const token = connection.token.trim();
  const notificationKey = notification
    ? [
        connection.apiBaseUrl,
        notification.id,
        notification.subject.url ?? notification.subject.title,
        notification.updated_at
      ].join("|")
    : null;

  useEffect(() => {
    const previousRefreshContext = lastRefreshContext.current;
    const forceRefresh =
      notificationKey !== null &&
      previousRefreshContext.key === notificationKey &&
      previousRefreshContext.refreshKey !== refreshKey &&
      refreshKey > 0;
    lastRefreshContext.current = { key: notificationKey, refreshKey };

    if (!notification) {
      setDetail(null);
      setLoading(false);
      setError(null);
      setRefreshing(false);
      return;
    }

    if (!token) {
      setDetail(sampleNotificationDetail(notification));
      setLoading(false);
      setError(null);
      setRefreshing(false);
      return;
    }

    const cacheOptions = {
      apiBaseUrl: connection.apiBaseUrl,
      notification
    };

    if (!online) {
      // Prefer a cached or persisted conversation over an error while offline.
      const offlineDetail =
        getCachedNotificationDetail(cacheOptions) ??
        getLatestCachedNotificationDetail(cacheOptions);
      setLoading(false);
      setRefreshing(false);
      if (offlineDetail) {
        setDetail(offlineDetail);
        setError(null);
      } else {
        setError("Offline — the conversation loads when you reconnect.");
      }
      return;
    }

    // Synchronous cache hit for the current version -> show it with no spinner.
    const cached = getCachedNotificationDetail(cacheOptions);
    if (cached && !forceRefresh) {
      setDetail(cached);
      setLoading(false);
      setError(null);
      setRefreshing(false);
      return;
    }

    let cancelled = false;
    // Version miss: if a previous conversation for this subject is still
    // cached, show it immediately (stale-while-revalidate) and swap in the
    // fresh result when it arrives, instead of dropping to a skeleton.
    const stale = cached ?? getLatestCachedNotificationDetail(cacheOptions);
    if (stale) {
      setDetail(stale);
      setRefreshing(false);
    } else {
      setDetail(null);
      setRefreshing(false);
    }
    setLoading(!stale);
    setError(null);
    fetchNotificationDetail({
      token,
      apiBaseUrl: connection.apiBaseUrl,
      webBaseUrl: connection.webBaseUrl,
      notification,
      forceRefresh
    })
      .then((content) => {
        if (!cancelled) {
          setDetail(content);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          if (stale) {
            setDetail(stale);
            setError(null);
          } else {
            setDetail(null);
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    notification,
    notificationKey,
    token,
    online,
    connection.apiBaseUrl,
    connection.webBaseUrl,
    refreshKey
  ]);

  return { detail, loading, error, refreshing };
}
