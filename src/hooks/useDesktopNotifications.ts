import { useEffect, useRef } from "react";
import {
  isReadAndQuiet,
  notificationWebUrl,
  type GitHubNotification
} from "../domain/notifications";
import {
  ensureNotificationPermission,
  sendDesktopNotification
} from "../services/desktopNotifications";
import type { ViewedAtMap } from "../services/notificationStores";

const SUMMARY_THRESHOLD = 5;

interface UseDesktopNotificationsInput {
  notifications: GitHubNotification[];
  viewedAt: ViewedAtMap;
  webBaseUrl: string;
  enabled: boolean;
  demoMode: boolean;
}

/**
 * Fires OS notifications when new unread items arrive, mirroring the Flutter
 * client: the very first populated list only seeds the baseline (no toast);
 * afterwards, unseen unread notifications trigger a toast — one per item up
 * to five, or a single summary beyond that.
 */
export function useDesktopNotifications({
  notifications,
  viewedAt,
  webBaseUrl,
  enabled,
  demoMode
}: UseDesktopNotificationsInput) {
  const knownIds = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (enabled && !demoMode) {
      void ensureNotificationPermission();
    }
  }, [enabled, demoMode]);

  useEffect(() => {
    if (!enabled || demoMode) {
      // Keep the baseline in sync so re-enabling doesn't replay old items.
      knownIds.current = new Set(notifications.map((item) => item.id));
      return;
    }

    // First populated list: seed the baseline silently.
    if (knownIds.current === null) {
      knownIds.current = new Set(notifications.map((item) => item.id));
      return;
    }

    const seen = knownIds.current;
    const fresh = notifications.filter(
      (notification) =>
        !seen.has(notification.id) &&
        !isReadAndQuiet(
          notification,
          viewedAt[notificationWebUrl(notification, webBaseUrl)]
        )
    );

    // Update the baseline to the current set regardless of what we notify.
    knownIds.current = new Set(notifications.map((item) => item.id));

    if (fresh.length === 0) {
      return;
    }

    if (fresh.length > SUMMARY_THRESHOLD) {
      void sendDesktopNotification({
        title: "Yonalist",
        body: `${fresh.length} new GitHub notifications`
      });
      return;
    }

    for (const notification of fresh) {
      void sendDesktopNotification({
        title: notification.repository.full_name,
        body: notification.subject.title
      });
    }
  }, [notifications, viewedAt, webBaseUrl, enabled, demoMode]);
}
