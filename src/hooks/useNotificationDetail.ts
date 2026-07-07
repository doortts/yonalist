import { useEffect, useState } from "react";
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
   * True while a stale (previous-version) conversation is shown and a newer
   * version is being fetched in the background. Consumers may ignore this.
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
  const token = connection.token.trim();

  useEffect(() => {
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
    if (cached) {
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
    const stale = getLatestCachedNotificationDetail(cacheOptions);
    if (stale) {
      setDetail(stale);
      setRefreshing(true);
    } else {
      setDetail(null);
      setRefreshing(false);
    }
    setLoading(true);
    setError(null);
    fetchNotificationDetail({
      token,
      apiBaseUrl: connection.apiBaseUrl,
      webBaseUrl: connection.webBaseUrl,
      notification
    })
      .then((content) => {
        if (!cancelled) {
          setDetail(content);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setDetail(null);
          setError(cause instanceof Error ? cause.message : String(cause));
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
    token,
    online,
    connection.apiBaseUrl,
    connection.webBaseUrl,
    refreshKey
  ]);

  return { detail, loading, error, refreshing };
}
