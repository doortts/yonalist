import { useCallback, useEffect, useRef } from "react";
import {
  isReadAndQuiet,
  notificationWebUrl,
  type GitHubNotification,
} from "../domain/notifications";
import { fetchUnreadNotificationUpdates } from "../services/notifications";
import {
  ensureNotificationPermission,
  sendDesktopNotification,
} from "../services/desktopNotifications";
import type { GithubNotificationViewedAt } from "../features/notes/githubNotifications/githubNotificationViewedStore";
import type { GithubConnection } from "./useGithubAuth";

const POLL_INTERVAL_MS = 60 * 1000;

interface UseDesktopNotificationsInput {
  connection: GithubConnection;
  viewedAt: GithubNotificationViewedAt;
  online: boolean;
  enabled: boolean;
  demoMode: boolean;
}

/**
 * Fires OS notifications from the GitHub Notifications feed only. The app list
 * can keep its full all=true cache strategy while this hook performs a small
 * unread-only conditional check for native toasts.
 */
export function useDesktopNotifications({
  connection,
  viewedAt,
  online,
  enabled,
  demoMode,
}: UseDesktopNotificationsInput) {
  const running = useRef(false);

  useEffect(() => {
    if (enabled && !demoMode) {
      void ensureNotificationPermission();
    }
  }, [enabled, demoMode]);

  const notify = useCallback(
    async (updates: GitHubNotification[]) => {
      for (const notification of updates) {
        if (
          isReadAndQuiet(
            notification,
            viewedAt[notificationWebUrl(notification, connection.webBaseUrl)],
          )
        ) {
          continue;
        }
        await sendDesktopNotification({
          title: notification.repository.full_name,
          body: notification.subject.title,
        });
      }
    },
    [connection.webBaseUrl, viewedAt],
  );

  const checkForUnreadUpdates = useCallback(async () => {
    if (
      running.current ||
      !enabled ||
      demoMode ||
      !online ||
      !connection.token.trim()
    ) {
      return;
    }
    running.current = true;
    try {
      const updates = await fetchUnreadNotificationUpdates({
        token: connection.token,
        apiBaseUrl: connection.apiBaseUrl,
      });
      await notify(updates);
    } catch {
      // Native notifications are best-effort; GN projection refresh reports
      // its own user-visible loading and error states.
    } finally {
      running.current = false;
    }
  }, [
    connection.apiBaseUrl,
    connection.token,
    demoMode,
    enabled,
    notify,
    online,
  ]);

  useEffect(() => {
    if (!enabled || demoMode || !online || !connection.token.trim()) {
      return;
    }
    void checkForUnreadUpdates();
    const interval = window.setInterval(
      checkForUnreadUpdates,
      POLL_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [checkForUnreadUpdates, connection.token, demoMode, enabled, online]);
}
