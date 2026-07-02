import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings } from "../appSettings";
import {
  isReadAndQuiet,
  notificationWebUrl,
  type GitHubNotification
} from "../domain/notifications";
import { sampleNotifications } from "../fixtures/sampleNotifications";
import { fetchNotifications } from "../services/notifications";
import {
  loadHiddenIds,
  loadViewedAt,
  markViewed,
  persistHiddenIds,
  type ViewedAtMap
} from "../services/notificationStores";

const POLL_INTERVAL_MS = 60 * 1000;

export interface UseNotificationsResult {
  notifications: GitHubNotification[];
  hiddenNotifications: GitHubNotification[];
  unreadCount: number;
  loading: boolean;
  error: string | null;
  demoMode: boolean;
  viewedAt: ViewedAtMap;
  refresh: () => void;
  markNotificationViewed: (notification: GitHubNotification) => void;
  openNotification: (notification: GitHubNotification) => void;
  hideNotification: (id: string) => void;
  unhideNotification: (id: string) => void;
}

export function useNotifications(
  settings: AppSettings,
  online: boolean,
  enabled: boolean
): UseNotificationsResult {
  const token = settings.personalAccessToken.trim();
  const demoMode = !token;

  const [fetched, setFetched] = useState<GitHubNotification[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewedAt, setViewedAt] = useState<ViewedAtMap>(() => loadViewedAt());
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => loadHiddenIds());
  const requestSeq = useRef(0);

  const load = useCallback(() => {
    if (!token || !online) {
      return;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    fetchNotifications({ token, apiBaseUrl: settings.apiBaseUrl })
      .then((result) => {
        if (requestSeq.current === seq) {
          setFetched(result);
          setError(null);
        }
      })
      .catch((cause) => {
        if (requestSeq.current === seq) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (requestSeq.current === seq) {
          setLoading(false);
        }
      });
  }, [token, online, settings.apiBaseUrl]);

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

  const notifications = useMemo(
    () => all.filter((notification) => !hiddenIds.has(notification.id)),
    [all, hiddenIds]
  );
  const hiddenNotifications = useMemo(
    () => all.filter((notification) => hiddenIds.has(notification.id)),
    [all, hiddenIds]
  );

  const unreadCount = useMemo(
    () =>
      notifications.filter(
        (notification) =>
          !isReadAndQuiet(
            notification,
            viewedAt[notificationWebUrl(notification, settings.webBaseUrl)]
          )
      ).length,
    [notifications, viewedAt, settings.webBaseUrl]
  );

  const markNotificationViewed = useCallback(
    (notification: GitHubNotification) => {
      const url = notificationWebUrl(notification, settings.webBaseUrl);
      setViewedAt(markViewed(url));
    },
    [settings.webBaseUrl]
  );

  const openNotification = useCallback(
    (notification: GitHubNotification) => {
      const url = notificationWebUrl(notification, settings.webBaseUrl);
      window.open(url, "_blank", "noopener,noreferrer");
      setViewedAt(markViewed(url));
    },
    [settings.webBaseUrl]
  );

  useEffect(() => {
    persistHiddenIds(hiddenIds);
  }, [hiddenIds]);

  const hideNotification = useCallback((id: string) => {
    setHiddenIds((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }, []);

  const unhideNotification = useCallback((id: string) => {
    setHiddenIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  return {
    notifications,
    hiddenNotifications,
    unreadCount,
    loading,
    error,
    demoMode,
    viewedAt,
    refresh: load,
    markNotificationViewed,
    openNotification,
    hideNotification,
    unhideNotification
  };
}
