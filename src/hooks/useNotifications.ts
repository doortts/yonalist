import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GithubConnection } from "./useGithubAuth";
import {
  isReadAndQuiet,
  notificationWebUrl,
  reconcileNotifications,
  type GitHubNotification
} from "../domain/notifications";
import { sampleNotifications } from "../fixtures/sampleNotifications";
import { openExternal } from "../services/browser";
import { fetchNotifications } from "../services/notifications";
import {
  loadCachedNotifications,
  loadViewedAt,
  markViewed,
  persistCachedNotifications,
  type ViewedAtMap
} from "../services/notificationStores";
import { tracePerf, tracePerfOnce } from "../services/perfTrace";

const POLL_INTERVAL_MS = 60 * 1000;

export interface UseNotificationsResult {
  notifications: GitHubNotification[];
  unreadCount: number;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  demoMode: boolean;
  viewedAt: ViewedAtMap;
  refresh: () => void;
  markNotificationViewed: (notification: GitHubNotification) => void;
  openNotification: (notification: GitHubNotification) => void;
}

export function useNotifications(
  connection: GithubConnection,
  online: boolean,
  enabled: boolean,
  /** Project-visibility filter; repositories mapped to false are hidden. */
  isRepoVisible?: (repositoryFullName: string) => boolean
): UseNotificationsResult {
  const token = connection.token.trim();
  const demoMode = !token;

  const [fetched, setFetched] = useState<GitHubNotification[] | null>(() =>
    token ? loadCachedNotifications(connection.apiBaseUrl) : null
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewedAt, setViewedAt] = useState<ViewedAtMap>(() => loadViewedAt());
  const requestSeq = useRef(0);

  useEffect(() => {
    if (!token) {
      setFetched(null);
      return;
    }
    const cached = loadCachedNotifications(connection.apiBaseUrl);
    setFetched(cached ?? null);
    if (cached) {
      tracePerfOnce("notifications-cache-loaded", "notifications_cache_loaded", {
        count: cached.length,
        apiBaseUrl: connection.apiBaseUrl
      });
    }
  }, [token, connection.apiBaseUrl]);

  const load = useCallback(() => {
    if (!token || !online) {
      return;
    }
    const seq = ++requestSeq.current;
    const startedAt = performance.now();
    tracePerf("notifications_remote_start", {
      apiBaseUrl: connection.apiBaseUrl
    });
    setLoading(true);
    fetchNotifications({
      token,
      apiBaseUrl: connection.apiBaseUrl,
      onPartialResult: (partial) => {
        if (requestSeq.current === seq) {
          setFetched((previous) => reconcileNotifications(previous, partial));
          persistCachedNotifications(connection.apiBaseUrl, partial);
          tracePerf("notifications_partial_result", {
            count: partial.length,
            durationMs: performance.now() - startedAt
          });
        }
      }
    })
      .then((result) => {
        if (requestSeq.current === seq) {
          setFetched((previous) => reconcileNotifications(previous, result));
          persistCachedNotifications(connection.apiBaseUrl, result);
          setError(null);
          tracePerf("notifications_remote_done", {
            count: result.length,
            durationMs: performance.now() - startedAt
          });
        }
      })
      .catch((cause) => {
        if (requestSeq.current === seq) {
          setError(cause instanceof Error ? cause.message : String(cause));
          tracePerf("notifications_remote_error", {
            message: cause instanceof Error ? cause.message : String(cause),
            durationMs: performance.now() - startedAt
          });
        }
      })
      .finally(() => {
        if (requestSeq.current === seq) {
          setLoading(false);
        }
      });
  }, [token, online, connection.apiBaseUrl]);

  useEffect(() => {
    if (!enabled || !token || !online) {
      return;
    }
    load();
    const interval = window.setInterval(load, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [enabled, token, online, load]);

  const all = useMemo(
    () => (demoMode ? sampleNotifications() : fetched ?? []),
    [demoMode, fetched]
  );
  const loaded = demoMode || fetched !== null;

  const repoVisible = useCallback(
    (notification: GitHubNotification) =>
      isRepoVisible?.(notification.repository.full_name) ?? true,
    [isRepoVisible]
  );

  const notifications = useMemo(
    () =>
      all.filter((notification) => repoVisible(notification)),
    [all, repoVisible]
  );

  const unreadCount = useMemo(
    () =>
      notifications.filter(
        (notification) =>
          !isReadAndQuiet(
            notification,
            viewedAt[notificationWebUrl(notification, connection.webBaseUrl)]
          )
      ).length,
    [notifications, viewedAt, connection.webBaseUrl]
  );

  const markNotificationViewed = useCallback(
    (notification: GitHubNotification) => {
      const url = notificationWebUrl(notification, connection.webBaseUrl);
      setViewedAt(markViewed(url));
    },
    [connection.webBaseUrl]
  );

  const openNotification = useCallback(
    (notification: GitHubNotification) => {
      const url = notificationWebUrl(notification, connection.webBaseUrl);
      void openExternal(url);
      setViewedAt(markViewed(url));
    },
    [connection.webBaseUrl]
  );

  // Referentially stable result so consumers (and the memoized Notifications
  // pane fed from it) only re-render when a field actually changes.
  return useMemo(
    () => ({
      notifications,
      unreadCount,
      loaded,
      loading,
      error,
      demoMode,
      viewedAt,
      refresh: load,
      markNotificationViewed,
      openNotification
    }),
    [
      notifications,
      unreadCount,
      loaded,
      loading,
      error,
      demoMode,
      viewedAt,
      load,
      markNotificationViewed,
      openNotification
    ]
  );
}
