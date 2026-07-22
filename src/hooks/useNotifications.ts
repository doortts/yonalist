import { useCallback, useMemo, useState } from "react";
import type { GithubConnection } from "./useGithubAuth";
import {
  isReadAndQuiet,
  notificationWebUrl,
  type GitHubNotification
} from "../domain/notifications";
import { sampleNotifications } from "../fixtures/sampleNotifications";
import { openExternal } from "../services/browser";
import type { ExternalSourceState } from "../services/externalSourceHost";
import {
  loadViewedAt,
  markViewed,
  type ViewedAtMap
} from "../services/notificationStores";

const emptyNotifications: readonly GitHubNotification[] = [];

export interface NotificationsSourceInput {
  readonly state: ExternalSourceState<GitHubNotification>;
  refresh(): Promise<void>;
}

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
  source: NotificationsSourceInput | null,
  /** Project-visibility filter; repositories mapped to false are hidden. */
  isRepoVisible?: (repositoryFullName: string) => boolean
): UseNotificationsResult {
  const demoMode = !connection.token.trim();
  const [viewedAt, setViewedAt] = useState<ViewedAtMap>(() => loadViewedAt());
  const all = useMemo(
    () =>
      demoMode
        ? sampleNotifications()
        : source?.state.items ?? emptyNotifications,
    [demoMode, source?.state.items]
  );
  const notifications = useMemo(
    () =>
      all.filter(
        (notification) =>
          isRepoVisible?.(notification.repository.full_name) ?? true
      ),
    [all, isRepoVisible]
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
  const refreshSource = source?.refresh;
  const refresh = useCallback(() => {
    void refreshSource?.().catch(() => undefined);
  }, [refreshSource]);
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

  return useMemo(
    () => ({
      notifications,
      unreadCount,
      loaded: demoMode || (source?.state.loaded ?? false),
      loading:
        demoMode ? false : !source?.state.loaded || source.state.loading,
      error: demoMode ? null : source?.state.error ?? null,
      demoMode,
      viewedAt,
      refresh,
      markNotificationViewed,
      openNotification
    }),
    [
      notifications,
      unreadCount,
      demoMode,
      source?.state.loaded,
      source?.state.loading,
      source?.state.error,
      viewedAt,
      refresh,
      markNotificationViewed,
      openNotification
    ]
  );
}
