import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  defaultSettings,
  normalizeGithubNotificationsReadRetentionDays,
} from "../../../appSettings";
import {
  rejectUnavailableExternalSource,
  type ExternalSourcesBoundary,
  type GithubMaterializedRefreshHandler,
  type GithubMaterializedRefreshRequest,
} from "../../../ExternalSourcesContext";
import {
  isSafeExternalHttpUrl,
  type ExternalBulletKey,
  type ExternalSourcePageSnapshot,
} from "../../../domain/externalSources";
import {
  notificationWebUrl,
  type GitHubNotification,
} from "../../../domain/notifications";
import type { AuthGateState } from "../../../hooks/useAuthGate";
import type { GithubConnection } from "../../../hooks/useGithubAuth";
import { useDesktopNotifications } from "../../../hooks/useDesktopNotifications";
import { useExternalSource } from "../../../hooks/useExternalSource";
import { openExternal } from "../../../services/browser";
import { createExternalSourceHost } from "../../../services/externalSourceHost";
import {
  githubSourceConnectionId,
  type GithubAccountIdentity,
} from "../../../services/githubAccountIdentity";
import {
  createGithubMaterializedBridgePump,
  githubMaterializedBridgeToken,
  type GithubMaterializedBridgePump,
} from "../../../services/githubMaterializedBridge";
import {
  createGithubNotificationsProvider,
  GITHUB_EXTERNAL_KEY_PROVIDER,
  GITHUB_NOTIFICATIONS_PROVIDER_ID,
  GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
} from "../../../services/githubNotificationsProvider";
import {
  loadGithubNotificationViewedAt,
  recordGithubNotificationViewedAt,
  type GithubNotificationViewedAt,
} from "./githubNotificationViewedStore";

function useProjectionClock(active: boolean, intervalMs: number): number {
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return nowMs;
}

export interface UseGithubNotificationsRuntimeInput {
  readonly connection: GithubConnection;
  readonly authState: AuthGateState;
  readonly account: GithubAccountIdentity | null;
  readonly online: boolean;
  readonly pluginEnabled: boolean;
  readonly desktopNotificationsEnabled: boolean;
  readonly readRetentionDays?: number;
}

export interface GithubNotificationsRuntime {
  readonly externalSources: ExternalSourcesBoundary;
}

/** Owns the GitHub Notifications source used by the Notes external outline. */
export function useGithubNotificationsRuntime(
  input: UseGithubNotificationsRuntimeInput,
): GithubNotificationsRuntime {
  const [githubProjectionRequested, setGithubProjectionRequested] =
    useState(false);
  const [viewedAt, setViewedAt] = useState<GithubNotificationViewedAt>(
    loadGithubNotificationViewedAt,
  );
  const connected =
    input.pluginEnabled &&
    input.authState === "passed" &&
    input.account !== null &&
    input.online &&
    Boolean(input.connection.token.trim());
  const projectionActive = connected && githubProjectionRequested;
  const desktopNotificationsActive =
    connected && input.desktopNotificationsEnabled;
  const projectionNowMs = useProjectionClock(projectionActive, 60_000);
  const apiBaseUrl = input.connection.apiBaseUrl;
  const webBaseUrl = input.connection.webBaseUrl;
  const token = input.connection.token;
  const accountId = input.account?.id ?? null;
  const accountLogin = input.account?.login ?? null;
  const sourceConnectionId =
    accountId !== null ? githubSourceConnectionId(apiBaseUrl, accountId) : null;
  const sourceItemsRef = useRef<readonly GitHubNotification[]>([]);
  const openNotificationUrl = useCallback((url: string) => {
    if (!isSafeExternalHttpUrl(url)) return;
    void openExternal(url);
    setViewedAt(recordGithubNotificationViewedAt(url));
  }, []);
  const openGithubDetails = useCallback(
    (remoteId: string) => {
      const notification = sourceItemsRef.current.find(
        (item) => item.id === remoteId,
      );
      if (notification) {
        openNotificationUrl(notificationWebUrl(notification, webBaseUrl));
      }
    },
    [openNotificationUrl, webBaseUrl],
  );
  const notificationProvider = useMemo(
    () =>
      input.pluginEnabled && accountId !== null && accountLogin !== null
        ? createGithubNotificationsProvider({
            connection: { apiBaseUrl, webBaseUrl, token },
            account: { id: accountId, login: accountLogin },
            openDetails: openGithubDetails,
          })
        : null,
    [
      accountId,
      accountLogin,
      apiBaseUrl,
      input.pluginEnabled,
      openGithubDetails,
      token,
      webBaseUrl,
    ],
  );
  const notificationSourceHandle = useMemo(
    () =>
      notificationProvider && sourceConnectionId
        ? createExternalSourceHost(notificationProvider, sourceConnectionId)
        : null,
    [notificationProvider, sourceConnectionId],
  );
  useEffect(
    () => () => notificationSourceHandle?.dispose(),
    [notificationSourceHandle],
  );
  const notificationSourceState = useExternalSource(
    notificationSourceHandle,
    projectionActive,
  );
  sourceItemsRef.current = notificationSourceState.items;

  const githubMaterializedRefreshRef =
    useRef<GithubMaterializedRefreshHandler | null>(null);
  const githubMaterializedBridgePumpRef =
    useRef<GithubMaterializedBridgePump<GithubMaterializedRefreshRequest> | null>(
      null,
    );
  if (githubMaterializedBridgePumpRef.current === null) {
    githubMaterializedBridgePumpRef.current =
      createGithubMaterializedBridgePump(
        (request) =>
          githubMaterializedRefreshRef.current?.(request) ??
          Promise.resolve("skipped"),
      );
  }
  const githubMaterializedBridgePump = githubMaterializedBridgePumpRef.current;
  const [
    githubMaterializedRefreshVersion,
    setGithubMaterializedRefreshVersion,
  ] = useState(0);
  const materializedGithubSourceIdentityRef = useRef({
    handle: notificationSourceHandle,
    webBaseUrl,
  });
  useEffect(() => {
    const previousIdentity = materializedGithubSourceIdentityRef.current;
    if (
      previousIdentity.handle === notificationSourceHandle &&
      previousIdentity.webBaseUrl === webBaseUrl
    ) {
      return;
    }
    materializedGithubSourceIdentityRef.current = {
      handle: notificationSourceHandle,
      webBaseUrl,
    };
    githubMaterializedBridgePump.invalidate();
  }, [githubMaterializedBridgePump, notificationSourceHandle, webBaseUrl]);
  useEffect(
    () => () => githubMaterializedBridgePump.dispose(),
    [githubMaterializedBridgePump],
  );
  useEffect(() => {
    if (!projectionActive || sourceConnectionId === null) return;
    if (githubMaterializedRefreshRef.current === null) return;
    const token = githubMaterializedBridgeToken(
      sourceConnectionId,
      notificationSourceState,
    );
    if (token === null) return;
    githubMaterializedBridgePump.submit({
      token,
      request: {
        connectionId: sourceConnectionId,
        webBaseUrl,
        items: notificationSourceState.items,
        syncedAt: notificationSourceState.syncedAt ?? new Date().toISOString(),
      },
    });
  }, [
    githubMaterializedBridgePump,
    githubMaterializedRefreshVersion,
    notificationSourceState,
    projectionActive,
    sourceConnectionId,
    webBaseUrl,
  ]);

  const githubPage = useMemo<ExternalSourcePageSnapshot | null>(
    () =>
      input.pluginEnabled
        ? {
            providerId: GITHUB_NOTIFICATIONS_PROVIDER_ID,
            connectionId: sourceConnectionId,
            title: GITHUB_NOTIFICATIONS_PROVIDER_TITLE,
            availability:
              input.authState === "required" && Boolean(token)
                ? "authentication-required"
                : !token
                  ? "disconnected"
                  : !input.online
                    ? "offline"
                    : accountId === null
                      ? "connecting"
                      : "online",
            items:
              sourceConnectionId && notificationProvider
                ? notificationProvider.project({
                    items: notificationSourceState.items,
                    connectionId: sourceConnectionId,
                    settings: notificationProvider.normalizeSettings({
                      readRetentionDays:
                        normalizeGithubNotificationsReadRetentionDays(
                          input.readRetentionDays ??
                            defaultSettings.githubNotificationsReadRetentionDays,
                        ),
                      viewedAt,
                    }),
                    now: new Date(projectionNowMs),
                  })
                : [],
            loaded: notificationSourceState.loaded,
            loading: notificationSourceState.loading,
            error: notificationSourceState.error,
            syncedAt: notificationSourceState.syncedAt,
            completingKeys: notificationSourceState.completingKeys,
            completionErrors: notificationSourceState.completionErrors,
          }
        : null,
    [
      accountId,
      input.authState,
      input.online,
      input.pluginEnabled,
      input.readRetentionDays,
      notificationProvider,
      notificationSourceState,
      projectionNowMs,
      sourceConnectionId,
      token,
      viewedAt,
    ],
  );
  const requestGithubProjection = useCallback((requested: boolean) => {
    setGithubProjectionRequested((current) =>
      current === requested ? current : requested,
    );
  }, []);
  const registerGithubMaterializedRefresh = useCallback(
    (handler: GithubMaterializedRefreshHandler) => {
      githubMaterializedRefreshRef.current = handler;
      setGithubMaterializedRefreshVersion((version) => version + 1);
      return () => {
        if (githubMaterializedRefreshRef.current !== handler) return;
        githubMaterializedRefreshRef.current = null;
        githubMaterializedBridgePump.invalidate();
        setGithubMaterializedRefreshVersion((version) => version + 1);
      };
    },
    [githubMaterializedBridgePump],
  );
  const refresh = useCallback(
    (providerId: string): Promise<void> =>
      connected &&
      providerId === GITHUB_NOTIFICATIONS_PROVIDER_ID &&
      notificationSourceHandle
        ? notificationSourceHandle.refresh()
        : rejectUnavailableExternalSource(),
    [connected, notificationSourceHandle],
  );
  const complete = useCallback(
    (key: ExternalBulletKey): Promise<void> =>
      connected &&
      key.providerId === GITHUB_EXTERNAL_KEY_PROVIDER &&
      key.connectionId === sourceConnectionId &&
      notificationSourceHandle
        ? notificationSourceHandle.complete(key)
        : rejectUnavailableExternalSource(),
    [connected, notificationSourceHandle, sourceConnectionId],
  );
  const openDetails = useCallback(
    (key: ExternalBulletKey, fallbackUrl?: string) => {
      if (key.providerId !== GITHUB_EXTERNAL_KEY_PROVIDER) return;
      const notification =
        key.connectionId === sourceConnectionId
          ? sourceItemsRef.current.find((item) => item.id === key.remoteId)
          : undefined;
      if (notification) {
        openNotificationUrl(notificationWebUrl(notification, webBaseUrl));
      } else if (
        fallbackUrl !== undefined &&
        isSafeExternalHttpUrl(fallbackUrl)
      ) {
        openNotificationUrl(fallbackUrl);
      }
    },
    [openNotificationUrl, sourceConnectionId, webBaseUrl],
  );
  const externalSources = useMemo<ExternalSourcesBoundary>(
    () => ({
      pages: githubPage ? [githubPage] : [],
      projectionNowMs,
      githubProjectionRequested,
      requestGithubProjection,
      registerGithubMaterializedRefresh,
      refresh,
      complete,
      openDetails,
    }),
    [
      complete,
      githubPage,
      githubProjectionRequested,
      openDetails,
      projectionNowMs,
      refresh,
      registerGithubMaterializedRefresh,
      requestGithubProjection,
    ],
  );

  useDesktopNotifications({
    connection: input.connection,
    viewedAt,
    online: input.online,
    enabled: desktopNotificationsActive,
    demoMode: false,
  });

  return { externalSources };
}
