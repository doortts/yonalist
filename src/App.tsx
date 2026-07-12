import {
  type CSSProperties,
  type FormEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition
} from "react";
import { Toast } from "@base-ui/react/toast";
import { NotebookPen } from "lucide-react";
import {
  APP_SNACKBAR_TIMEOUT_MS,
  AppSnackbarToasts,
  appToastManager,
  showAppSnackbar
} from "./components/AppSnackbar";
import {
  defaultSettings,
  loadSettings,
  normalizeSettings,
  persistSettings,
  settingsNeedNormalization,
  type AppSettings
} from "./appSettings";
import { GithubConnectionContext } from "./GithubConnectionContext";
import { MarkdownStyleContext } from "./MarkdownStyleContext";
import { VaultRootContext } from "./VaultRootContext";
import {
  AppStatusBar,
  type StatusBarMetrics
} from "./components/AppStatusBar";
import { ItemDetail } from "./components/ItemDetail";
import {
  ItemListPane,
  type ItemStateFilter
} from "./components/ItemListPane";
import { LoginPage } from "./components/LoginPage";
import {
  NewIssuePage,
  type RepositoryEntry
} from "./components/NewIssuePage";
import { NotificationDetail } from "./components/NotificationDetail";
import { DetailRenderSnapshotOverlay } from "./components/DetailRenderSnapshotOverlay";
import { NotificationsPane } from "./components/NotificationsPane";
import { OutboxModal } from "./components/OutboxModal";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import {
  SettingsCategoryPane,
  type SettingsSection
} from "./components/SettingsCategoryPane";
// Settings never render on the first screen; code-split them out of the
// initial bundle.
const SettingsPage = lazy(() =>
  import("./components/SettingsPage").then((module) => ({
    default: module.SettingsPage
  }))
);
import { Sidebar, type ListFilter } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import {
  getMarkdownRenderCacheStats,
  preloadMarkdownRenderer
} from "./components/MarkdownBody";
import { toggleFavorite } from "./domain/favorites";
import {
  createCommentOutboxOperation,
  createOperationId
} from "./domain/outbox";
import {
  DEFAULT_ITEM_SORT,
  mergeItemDocuments,
  repositoryItemsWithInboxFallback,
  withVaultItemPath,
  type ItemSort
} from "./domain/items";
import { commentFilePath, itemMainPath } from "./domain/paths";
import {
  isReadAndQuiet,
  notificationWebUrl,
  subjectNumber,
  type GitHubNotification
} from "./domain/notifications";
import type { ConversationComment } from "./domain/conversation";
import type {
  CommentDocument,
  ItemKind,
  ItemDocument,
  OutboxOperationDocument
} from "./domain/types";
import type { CommentSubmitAction } from "./components/CommentComposer";
import type { CommentReplyDraft } from "./components/CommentThread";
import { SAMPLE_VAULT_ROOT } from "./fixtures/sampleItems";
import { useGithubAuth } from "./hooks/useGithubAuth";
import { useAuthGate } from "./hooks/useAuthGate";
import { useAppBadge } from "./hooks/useAppBadge";
import { useGithubServers } from "./hooks/useGithubServers";
import { useDetailContentPaintReady } from "./hooks/useDetailContentPaintReady";
import { useDetailRenderSnapshotCapture } from "./hooks/useDetailRenderSnapshotCapture";
import { useDetailDisplayTiming } from "./hooks/useDetailDisplayTiming";
import {
  useDetailRevalidation,
  type DetailRevalidationTarget
} from "./hooks/useDetailRevalidation";
import { useItemThread } from "./hooks/useItemThread";
import { useNotificationDetail } from "./hooks/useNotificationDetail";
import { useDesktopNotifications } from "./hooks/useDesktopNotifications";
import { useNavigationListAccent } from "./hooks/useNavigationListAccent";
import { useNotifications } from "./hooks/useNotifications";
import { useProjectVisibility } from "./hooks/useProjectVisibility";
import { useRepositoryOpenCounts } from "./hooks/useRepositoryOpenCounts";
import { useRepositories } from "./hooks/useRepositories";
import {
  clearWorkItemsCache,
  useWorkItems,
  type WorkScope
} from "./hooks/useWorkItems";
import { paneWidthLimits, usePaneResize } from "./hooks/usePaneResize";
import { useOnlineStatus } from "./hooks/useOnlineStatus";
import { useScrollbarHover } from "./hooks/useScrollbarHover";
import { useTheme } from "./hooks/useTheme";
import { useDraftIssue } from "./hooks/useDraftIssue";
import { useOutboxSync } from "./hooks/useOutboxSync";
import { useSettingsReset } from "./hooks/useSettingsReset";
import { useVisibleItemPrefetch } from "./hooks/useVisibleItemPrefetch";
import { useVisibleNotificationPrefetch } from "./hooks/useVisibleNotificationPrefetch";
import { featureRegistry, getFeatureDefinition } from "./features/core/featureRegistry";
import {
  loadActiveFeature,
  persistActiveFeature
} from "./features/core/featureSelection";
import type { FeatureId, FeaturePanes } from "./features/core/featureTypes";
import { clearImageProxyCache } from "./services/imageProxy";
import { scheduleIdleTask } from "./services/idleQueue";
import {
  clearItemThreadCache,
  getItemThreadCacheStats
} from "./services/itemThread";
import { estimateRecordBytes } from "./services/cacheStats";
import {
  deleteDetailRenderSnapshot,
  getDetailRenderSnapshot
} from "./services/detailRenderCache";
import {
  clearNotificationDetailCache,
  getNotificationDetailCacheStats
} from "./services/notificationDetail";
import {
  clearNotificationCache,
  getNotificationCacheStats
} from "./services/notifications";
import { tracePerf, tracePerfOnce } from "./services/perfTrace";
import {
  loadItemDocumentBody,
  loadVaultState,
  persistCommentDocument,
  persistItemDocuments,
  persistOutboxOperation,
  rebuildVaultStateFromMarkdown
} from "./services/vaultStore";

// How many of the newest notifications to warm ahead of a click. The
// Notifications pane is not virtualized, so this caps the top-of-feed slice we
// prefetch rather than a measured viewport window.
const NOTIFICATION_PREFETCH_CAP = 30;

const neutralStatusMetrics: StatusBarMetrics = {
  listFetchDurationMs: null,
  detailDisplayDurationMs: null,
  prefetch: {
    enabled: false,
    visible: 0,
    queued: 0,
    active: 0,
    cached: 0,
    completed: 0,
    totalDurationMs: 0,
    lastDurationMs: null
  },
  caches: []
};


interface AppProps {
  initialOnline?: boolean;
}

interface CommentTarget {
  host: string;
  owner: string;
  repo: string;
  kind: ItemKind;
  number: number;
}

function hostFromWebBaseUrl(webBaseUrl: string): string {
  try {
    return new URL(webBaseUrl).host;
  } catch {
    return webBaseUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

function notificationSubjectKind(
  notification: GitHubNotification
): ItemKind | null {
  switch (notification.subject.type) {
    case "Issue":
      return "issue";
    case "PullRequest":
      return "pull";
    case "Discussion":
      return "discussion";
    default:
      return null;
  }
}

function countConversationMarkdownBodies(comments: ConversationComment[]): number {
  return comments.reduce(
    (count, comment) =>
      count + 1 + countConversationMarkdownBodies(comment.replies ?? []),
    0
  );
}

function matchesFilter(item: ItemDocument, filter: ListFilter): boolean {
  switch (filter) {
    case "favorites":
      return item.frontMatter.local.favorite;
    case "issues":
      return item.frontMatter.kind === "issue";
    case "pulls":
      return item.frontMatter.kind === "pull";
    case "discussions":
      return item.frontMatter.kind === "discussion";
    default:
      return true;
  }
}

function matchesStateFilter(item: ItemDocument, filter: ItemStateFilter): boolean {
  if (filter === "open") {
    return item.frontMatter.state === "open";
  }
  return item.frontMatter.state === "closed" || item.frontMatter.state === "merged";
}

function itemSortEquals(left: ItemSort, right: ItemSort): boolean {
  return left.field === right.field && left.direction === right.direction;
}

function AuthRestorePage({ onOpenNotes }: { onOpenNotes: () => void }) {
  return (
    <main className="login-shell" aria-label="Restoring GitHub session">
      <TitleBar />
      <div className="login-card">
        <div className="login-card-header">
          <p className="eyebrow">Yonalist</p>
          <h1>GitHub 세션 복구 중</h1>
          <p className="login-copy">
            저장된 인증 정보를 확인하고 있습니다.
          </p>
        </div>
        <button type="button" className="text-button" onClick={onOpenNotes}>
          <NotebookPen size={16} aria-hidden="true" />
          <span>Notes</span>
        </button>
      </div>
    </main>
  );
}

export default function App({ initialOnline }: AppProps) {
  useScrollbarHover();
  const { online, toggleOnline } = useOnlineStatus(initialOnline);
  const [drafts, setDrafts] = useState<ItemDocument[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ListFilter>("all");
  const [itemStateFilter, setItemStateFilter] =
    useState<ItemStateFilter>("open");
  const [itemSortByScope, setItemSortByScope] = useState<
    Record<string, ItemSort>
  >({});
  const [repositoryFilter, setRepositoryFilter] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [replyDraft, setReplyDraft] = useState<CommentReplyDraft | undefined>();
  // Reconnect-sync offers are only valid once the current vault's queued
  // operations are actually loaded for the active Inbox; Notes must neither
  // consume nor discard a reconnect edge (see useOutboxSync.reconnectEligible).
  const [inboxVaultReady, setInboxVaultReady] = useState(false);
  const [showNewIssue, setShowNewIssue] = useState(false);
  const [activeFeatureId, setActiveFeatureId] =
    useState<FeatureId>(loadActiveFeature);
  const activeFeature = getFeatureDefinition(activeFeatureId);
  const inboxActive = activeFeatureId === "inbox";
  const showSettings = activeFeatureId === "settings";
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("appearance");
  // Notifications are the landing view once authentication passes.
  const [showNotifications, setShowNotifications] = useState(true);
  const [loadedItemBodies, setLoadedItemBodies] = useState<Record<string, string>>({});
  const [visiblePrefetchItems, setVisiblePrefetchItems] = useState<ItemDocument[]>([]);
  const [visibleNotificationPrefetchItems, setVisibleNotificationPrefetchItems] =
    useState<GitHubNotification[]>([]);
  const [conversationRefreshKey, setConversationRefreshKey] = useState(0);
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [settingsStatus, setSettingsStatus] = useState("");
  const {
    paneWidths,
    paneCollapsed,
    detailMaximized,
    togglePaneCollapsed,
    toggleDetailMaximized,
    startResize,
    resizeWithKeyboard
  } = usePaneResize();
  // Whether the currently shown detail's header is on screen. Detail panes lift
  // this up via StickyTitle; the fixed titlebar maximize toggle is shown only
  // when it is false (header scrolled away, or a header-less shell), because
  // otherwise the same action is offered inline in the header. Defaults false
  // so header-less views (settings, new issue, empty detail) keep the corner
  // toggle.
  const [detailHeaderVisible, setDetailHeaderVisible] = useState(false);
  const servers = useGithubServers();
  const auth = useGithubAuth(servers);
  const vaultRoot = settings.vaultFolder.trim() || SAMPLE_VAULT_ROOT;
  const authGate = useAuthGate({ auth, servers, online });

  function changeActiveFeature(nextFeatureId: FeatureId) {
    if (nextFeatureId !== activeFeatureId && nextFeatureId !== "inbox") {
      outboxSync.setReconnectSyncPrompt(null);
    }
    setActiveFeatureId(nextFeatureId);
  }
  // Mirror changeActiveFeature through a ref so render-stable callbacks can call
  // the latest closure without listing it (a new identity each render) in deps.
  const changeActiveFeatureRef = useRef(changeActiveFeature);
  changeActiveFeatureRef.current = changeActiveFeature;

  useEffect(() => {
    persistActiveFeature(activeFeatureId);
  }, [activeFeatureId]);

  useEffect(() => {
    setSettings((current) =>
      settingsNeedNormalization(current) ? normalizeSettings(current) : current
    );
  }, []);

  useEffect(() => {
    tracePerfOnce("app-mounted", "app_mounted", {
      online,
      selectedServer: servers.selectedUrl
    });
  }, [online, servers.selectedUrl]);

  useEffect(() => {
    tracePerf(`auth_gate_${authGate.state}`, {
      signedIn: auth.signedIn,
      restoringSession: auth.restoringSession
    });
  }, [authGate.state, auth.restoringSession, auth.signedIn]);

  // Session caches hold per-connection data; switching servers or tokens
  // must not leak the previous session's threads, notifications, or images.
  const previousConnectionKey = useRef<string | null>(null);
  useEffect(() => {
    const key = `${auth.connection.apiBaseUrl}|${auth.connection.token}`;
    if (previousConnectionKey.current !== null && previousConnectionKey.current !== key) {
      clearNotificationCache();
      clearItemThreadCache();
      clearNotificationDetailCache();
      clearImageProxyCache();
      clearWorkItemsCache();
    }
    previousConnectionKey.current = key;
  }, [auth.connection.apiBaseUrl, auth.connection.token]);

  // Local vault data loads immediately, in parallel with the background auth
  // check — offline-first means the first screen never waits on the network.
  useEffect(() => {
    setInboxVaultReady(false);
    if (!inboxActive) {
      outboxSync.setReconnectSyncPrompt(null);
      return;
    }
    let cancelled = false;
    const startedAt = performance.now();
    tracePerf("vault_load_start", { vaultRoot });
    void loadVaultState(vaultRoot)
      .then((state) => {
        if (cancelled) {
          return;
        }
        setDrafts(state.items);
        outboxSync.setOutbox(state.outbox);
        setInboxVaultReady(true);
        tracePerf("vault_load_done", {
          items: state.items.length,
          outbox: state.outbox.length,
          durationMs: performance.now() - startedAt
        });
      })
      .catch((error) => {
        console.error("Failed to load vault state", error);
        tracePerf("vault_load_error", {
          message: error instanceof Error ? error.message : String(error),
          durationMs: performance.now() - startedAt
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboxActive, vaultRoot]);

  // Warm the markdown renderer chunk while the app is idle so the first
  // opened detail does not pay the dynamic-import cost on click.
  useEffect(() => scheduleIdleTask(() => void preloadMarkdownRenderer()), []);

  const rebuiltVaultRoot = useRef<string | null>(null);
  useEffect(() => {
    if (
      !inboxActive ||
      authGate.state !== "passed" ||
      rebuiltVaultRoot.current === vaultRoot
    ) {
      return;
    }
    rebuiltVaultRoot.current = vaultRoot;
    let cancelled = false;
    const cancelIdle = scheduleIdleTask(() => {
      const startedAt = performance.now();
      tracePerf("vault_rebuild_start", { vaultRoot });
      void rebuildVaultStateFromMarkdown(vaultRoot)
        .then((state) => {
          if (cancelled) {
            return;
          }
          setDrafts(state.items);
          outboxSync.setOutbox(state.outbox);
          tracePerf("vault_rebuild_done", {
            items: state.items.length,
            outbox: state.outbox.length,
            durationMs: performance.now() - startedAt
          });
        })
        .catch((error) => {
          tracePerf("vault_rebuild_error", {
            message: error instanceof Error ? error.message : String(error),
            durationMs: performance.now() - startedAt
          });
        });
    }, 2500);
    return () => {
      cancelled = true;
      cancelIdle();
    };
    // One-shot idle vault rebuild keyed on vaultRoot (guarded above); outboxSync
    // is a fresh object each render and adding it would cancel the pending rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authGate.state, inboxActive, vaultRoot]);

  const repositoryScope = useMemo<WorkScope>(() => {
    if (repositoryFilter) {
      const [owner, ...rest] = repositoryFilter.split("/");
      return { type: "repo", owner, name: rest.join("/") };
    }
    return { type: "inbox" };
  }, [repositoryFilter]);
  const itemSortScopeKey = repositoryFilter
    ? `repository:${repositoryFilter}`
    : `inbox:${filter}`;
  const itemSort = itemSortByScope[itemSortScopeKey] ?? DEFAULT_ITEM_SORT;
  const setScopedItemSort = useCallback(
    (nextSort: ItemSort) => {
      setItemSortByScope((current) => {
        const currentSort = current[itemSortScopeKey] ?? DEFAULT_ITEM_SORT;
        if (itemSortEquals(currentSort, nextSort)) {
          return current;
        }
        return { ...current, [itemSortScopeKey]: nextSort };
      });
    },
    [itemSortScopeKey]
  );
  const inboxWorkItems = useWorkItems(
    auth.connection,
    online,
    { type: "inbox" },
    vaultRoot,
    inboxActive,
    itemSort
  );
  const projectWorkItems = useWorkItems(
    auth.connection,
    online,
    repositoryScope,
    vaultRoot,
    inboxActive && Boolean(repositoryFilter),
    itemSort
  );
  const workItems = repositoryFilter ? projectWorkItems : inboxWorkItems;
  const inboxItems = useMemo(
    () => mergeItemDocuments(drafts, inboxWorkItems.items, vaultRoot, itemSort),
    [drafts, inboxWorkItems.items, itemSort, vaultRoot]
  );
  const items = useMemo(
    () => mergeItemDocuments(drafts, workItems.items, vaultRoot, itemSort),
    [drafts, itemSort, workItems.items, vaultRoot]
  );
  const listItems = useMemo(
    () =>
      repositoryItemsWithInboxFallback(
        items,
        inboxItems,
        repositoryFilter,
        projectWorkItems.loading,
        itemSort
      ),
    [inboxItems, itemSort, items, projectWorkItems.loading, repositoryFilter]
  );
  const unfilteredNotifications = useNotifications(
    auth.connection,
    online,
    inboxActive && authGate.state === "passed"
  );
  const repositoryGroups = useRepositories(
    auth.connection,
    online && inboxActive,
    inboxItems,
    unfilteredNotifications.notifications
  );
  useEffect(() => {
    if (
      authGate.state !== "passed" ||
      !inboxActive ||
      !online ||
      workItems.demoMode ||
      workItems.items.length === 0
    ) {
      return;
    }

    return scheduleIdleTask(() => {
      void persistItemDocuments(
        vaultRoot,
        workItems.items.map((item) => withVaultItemPath(vaultRoot, item))
      );
    });
  }, [authGate.state, inboxActive, online, workItems.demoMode, workItems.items, vaultRoot]);
  const notificationRepoNames = useMemo(
    () =>
      new Set(
        unfilteredNotifications.notifications
          .map((notification) => notification.repository.full_name)
          .filter((fullName): fullName is string => Boolean(fullName))
      ),
    [unfilteredNotifications.notifications]
  );
  const projectVisibility = useProjectVisibility(
    repositoryGroups.groups,
    notificationRepoNames,
    authGate.state === "passed" &&
      unfilteredNotifications.loaded &&
      repositoryGroups.loaded &&
      !repositoryGroups.loading
  );
  const selectedRepositoryForCounts =
    activeFeatureId !== "inbox" || showNotifications ? null : repositoryFilter;
  const visibleRepositoryCounts = useRepositoryOpenCounts(
    auth.connection,
    online,
    projectVisibility.visibleGroups,
    selectedRepositoryForCounts
  );
  // Notifications follow the Projects 표시 selection: repositories the user
  // unchecked are filtered out; repositories we do not manage stay visible.
  const isRepoVisible = projectVisibility.isVisible;
  const notificationRepoFilter = useMemo(() => {
    const managed = new Map<string, boolean>();
    for (const group of repositoryGroups.groups) {
      for (const repository of group.repositories) {
        managed.set(repository.fullName, isRepoVisible(repository));
      }
    }
    return (repositoryFullName: string) => managed.get(repositoryFullName) ?? true;
  }, [repositoryGroups.groups, isRepoVisible]);
  const filteredNotificationItems = useMemo(
    () =>
      unfilteredNotifications.notifications.filter((notification) =>
        notificationRepoFilter(notification.repository.full_name)
      ),
    [unfilteredNotifications.notifications, notificationRepoFilter]
  );
  const filteredUnreadNotificationCount = useMemo(
    () =>
      filteredNotificationItems.filter(
        (notification) =>
          !isReadAndQuiet(
            notification,
            unfilteredNotifications.viewedAt[
              notificationWebUrl(notification, auth.connection.webBaseUrl)
            ]
          )
      ).length,
    [
      filteredNotificationItems,
      unfilteredNotifications.viewedAt,
      auth.connection.webBaseUrl
    ]
  );
  const notifications = useMemo(
    () => ({
      ...unfilteredNotifications,
      notifications: filteredNotificationItems,
      unreadCount: filteredUnreadNotificationCount
    }),
    [
      unfilteredNotifications,
      filteredNotificationItems,
      filteredUnreadNotificationCount
    ]
  );
  // A sync that pushed changes invalidates cached conversations and re-pulls
  // both lists so the pushed changes come back with server-side ids.
  const refreshAfterOutboxSync = useCallback(() => {
    clearItemThreadCache();
    clearNotificationDetailCache();
    setConversationRefreshKey((current) => current + 1);
    workItems.refresh();
    notifications.refresh();
    // workItems/notifications objects are rebuilt each render; their .refresh
    // callbacks (already listed) are stable, so depend on those, not the objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workItems.refresh, notifications.refresh]);
  const outboxSync = useOutboxSync({
    vaultRoot,
    connection: auth.connection,
    online,
    syncQueuedOnReconnect: settings.syncQueuedOnReconnect,
    items,
    setDrafts,
    setLoadedItemBodies,
    onAfterSync: refreshAfterOutboxSync,
    // Reconnect offers are only valid once the active Inbox's queued vault data
    // is loaded; Notes must neither consume nor discard a reconnect edge.
    reconnectEligible: inboxActive && inboxVaultReady
  });
  const displayedUnreadNotificationCount =
    repositoryGroups.loaded ? notifications.unreadCount : 0;
  useAppBadge(authGate.state === "passed" ? displayedUnreadNotificationCount : 0);
  useDesktopNotifications({
    connection: auth.connection,
    viewedAt: notifications.viewedAt,
    online,
    enabled:
      inboxActive &&
      settings.desktopNotifications &&
      authGate.state === "passed",
    demoMode: notifications.demoMode,
    isRepoVisible: notificationRepoFilter
  });
  const [selectedNotification, setSelectedNotification] =
    useState<GitHubNotification | null>(null);
  const activeSelectedNotification =
    activeFeatureId === "inbox" && showNotifications ? selectedNotification : null;
  useEffect(() => {
    if (activeFeatureId !== "inbox" || !showNotifications) {
      return;
    }
    if (notifications.notifications.length === 0 && notifications.loading) {
      return;
    }
    tracePerfOnce("notifications-list-visible", "notifications_list_visible", {
      count: notifications.notifications.length,
      unreadCount: notifications.unreadCount,
      loading: notifications.loading,
      demoMode: notifications.demoMode
    });
  }, [
    activeFeatureId,
    showNotifications,
    notifications.notifications.length,
    notifications.unreadCount,
    notifications.loading,
    notifications.demoMode
  ]);
  const notificationDetail = useNotificationDetail(
    activeSelectedNotification,
    auth.connection,
    online,
    conversationRefreshKey
  );
  const selectedNotificationCommentTarget = useMemo<CommentTarget | null>(() => {
    if (!selectedNotification) {
      return null;
    }
    const kind = notificationSubjectKind(selectedNotification);
    const number = subjectNumber(selectedNotification.subject);
    if (!kind || number === null) {
      return null;
    }
    return {
      host: hostFromWebBaseUrl(auth.connection.webBaseUrl),
      owner: selectedNotification.repository.owner.login,
      repo: selectedNotification.repository.name,
      kind,
      number
    };
  }, [selectedNotification, auth.connection.webBaseUrl]);
  const {
    mode: themeMode,
    setMode: setThemeMode,
    lightTheme,
    setLightTheme,
    darkTheme,
    setDarkTheme
  } = useTheme();

  const repositories = useMemo<RepositoryEntry[]>(() => {
    const counts = new Map<string, RepositoryEntry>();
    for (const item of items) {
      const key = `${item.frontMatter.owner}/${item.frontMatter.repo}`;
      const current = counts.get(key) ?? {
        key,
        host: item.frontMatter.host,
        owner: item.frontMatter.owner,
        repo: item.frontMatter.repo,
        count: 0
      };
      current.count += 1;
      counts.set(key, current);
    }
    return [...counts.values()].sort((left, right) => left.key.localeCompare(right.key));
  }, [items]);

  const filterCounts = useMemo<Record<ListFilter, number>>(
    () => ({
      all: inboxItems.length,
      favorites: inboxItems.filter((item) => item.frontMatter.local.favorite).length,
      issues: inboxItems.filter((item) => item.frontMatter.kind === "issue").length,
      pulls: inboxItems.filter((item) => item.frontMatter.kind === "pull").length,
      discussions: inboxItems.filter((item) => item.frontMatter.kind === "discussion")
        .length
    }),
    [inboxItems]
  );

  const stateScopedItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return listItems.filter((item) => {
      if (!repositoryFilter && !matchesFilter(item, filter)) {
        return false;
      }
      if (
        repositoryFilter &&
        `${item.frontMatter.owner}/${item.frontMatter.repo}` !== repositoryFilter
      ) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      const haystack = [
        item.frontMatter.title,
        item.frontMatter.owner,
        item.frontMatter.repo,
        `#${item.frontMatter.number}`,
        item.frontMatter.labels.join(" "),
        item.body || loadedItemBodies[item.path] || ""
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [listItems, filter, repositoryFilter, query, loadedItemBodies]);

  const itemStateCounts = useMemo(
    () =>
      stateScopedItems.reduce(
        (counts, item) => {
          if (item.frontMatter.state === "open") {
            counts.open += 1;
          } else if (
            item.frontMatter.state === "closed" ||
            item.frontMatter.state === "merged"
          ) {
            counts.closed += 1;
          }
          return counts;
        },
        { open: 0, closed: 0 }
      ),
    [stateScopedItems]
  );

  const filteredItems = useMemo(
    () =>
      stateScopedItems.filter((item) => matchesStateFilter(item, itemStateFilter)),
    [stateScopedItems, itemStateFilter]
  );
  const activeNavigationKey = showSettings
    ? "app:settings"
    : activeFeatureId === "notes"
      ? "workspace:notes"
      : showNotifications
      ? "github:notifications"
      : repositoryFilter
        ? `repository:${repositoryFilter}`
        : `inbox:${filter}`;
  const navigationListAccentStyle = useNavigationListAccent(activeNavigationKey);

  const displayedItemStateCounts =
    repositoryFilter && visibleRepositoryCounts.selectedStateCounts
      ? visibleRepositoryCounts.selectedStateCounts
      : itemStateCounts;

  const selectedItem =
    filteredItems.find((item) => item.path === selectedPath) ??
    (repositoryFilter ? undefined : filteredItems[0]);
  const appendOutboxOperation = useCallback(
    (operation: OutboxOperationDocument) => {
      outboxSync.setOutbox((current) => [...current, operation]);
    },
    // outboxSync is rebuilt each render; setOutbox (a stable useState setter,
    // already listed) is the only member used here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outboxSync.setOutbox]
  );
  // The branch replaced boolean settings state with the feature registry, so
  // adapt the hook's setShowSettings toggle onto changeActiveFeature. Keep this
  // render-stable (calling the latest closure via the ref) so useDraftIssue's
  // openNewIssue keeps a stable identity and ItemListPane's React.memo bailout
  // holds across app-level state churn (e.g. notification polls).
  const setShowSettingsFromDraftIssue = useCallback(
    (show: boolean) =>
      changeActiveFeatureRef.current(show ? "settings" : "inbox"),
    []
  );
  const { draftIssue, setDraftIssue, openNewIssue, queueIssue } = useDraftIssue({
    vaultRoot,
    repositories,
    selectedItem,
    setDrafts,
    setSelectedPath,
    setShowNewIssue,
    setShowSettings: setShowSettingsFromDraftIssue,
    appendOutboxOperation
  });
  const selectedItemWithBody = useMemo(() => {
    if (!selectedItem) {
      return selectedItem;
    }
    const loadedBody = loadedItemBodies[selectedItem.path];
    if (selectedItem.body || loadedBody === undefined) {
      return selectedItem;
    }
    return { ...selectedItem, body: loadedBody };
  }, [selectedItem, loadedItemBodies]);

  useEffect(() => {
    if (
      !inboxActive ||
      !selectedItem ||
      selectedItem.body ||
      loadedItemBodies[selectedItem.path] !== undefined
    ) {
      return;
    }
    let cancelled = false;
    void loadItemDocumentBody(vaultRoot, selectedItem)
      .then((body) => {
        if (!cancelled) {
          setLoadedItemBodies((current) => ({
            ...current,
            [selectedItem.path]: body
          }));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadedItemBodies((current) => ({
            ...current,
            [selectedItem.path]: ""
          }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [inboxActive, selectedItem, loadedItemBodies, vaultRoot]);

  const detailVisible =
    authGate.state === "passed" &&
    activeFeatureId === "inbox" &&
    !showNewIssue &&
    !showNotifications;
  const itemThread = useItemThread(
    detailVisible ? selectedItemWithBody ?? null : null,
    auth.connection,
    online,
    conversationRefreshKey
  );

  const getItemPrefetchStats = useVisibleItemPrefetch({
    visibleItems: detailVisible ? visiblePrefetchItems : [],
    selectedPath: selectedItem?.path ?? null,
    vaultRoot,
    connection: auth.connection,
    online,
    enabled:
      detailVisible &&
      settings.prefetchVisibleItems !== false &&
      authGate.state === "passed" &&
      !workItems.demoMode &&
      !showNewIssue &&
      !showNotifications,
    loadedBodies: loadedItemBodies,
    refreshKey: conversationRefreshKey,
    onBodyPrefetched: (path, body) => {
      setLoadedItemBodies((current) =>
        current[path] === undefined ? { ...current, [path]: body } : current
      );
    },
    onBodyInvalidated: (path) => {
      setLoadedItemBodies((current) => {
        if (current[path] === undefined) {
          return current;
        }
        const next = { ...current };
        delete next[path];
        return next;
      });
    },
    onError: (message) => {
      tracePerf("visible_item_prefetch_error", { message });
    }
  });

  // The Notifications pane is not virtualized and its rows are cheap, so warm
  // the pane's filtered rows — the rows the user can currently click after
  // search/Only new are applied. The cap bounds concurrent detail fetches; the
  // prefetch hook further limits them.
  const notificationPrefetchTargets = useMemo(
    () => visibleNotificationPrefetchItems.slice(0, NOTIFICATION_PREFETCH_CAP),
    [visibleNotificationPrefetchItems]
  );
  const notificationPrefetchEnabled =
    activeFeatureId === "inbox" &&
    showNotifications &&
    settings.prefetchVisibleItems !== false &&
    authGate.state === "passed" &&
    !notifications.demoMode &&
    !showNewIssue;
  const getNotificationPrefetchStats = useVisibleNotificationPrefetch({
    visibleNotifications: notificationPrefetchEnabled
      ? notificationPrefetchTargets
      : [],
    selectedId: activeSelectedNotification?.id ?? null,
    connection: auth.connection,
    online,
    enabled: notificationPrefetchEnabled,
    onError: (message) => {
      tracePerf("visible_notification_prefetch_error", { message });
    }
  });
  const activeDetailKey =
    activeFeatureId !== "inbox"
      ? null
      : showNotifications
        ? selectedNotification
          ? `notification:${selectedNotification.id}`
          : null
        : detailVisible && selectedItem
          ? `item:${selectedItem.path}`
          : null;
  // Identifies what the shared `.detail-scroll` container is currently showing.
  // The same DOM node is reused across every selection and content mode, so a
  // change here means the pane switched targets and its scroll must snap back
  // to the top (see the reset effect below). Same-target re-clicks leave this
  // key unchanged, so the previous scroll position is preserved.
  const detailScrollResetKey =
    activeFeatureId === "settings"
      ? `settings:${settingsSection}`
      : activeFeatureId === "notes"
        ? "notes"
        : showNewIssue
          ? "new-issue"
          : showNotifications
            ? `notification:${selectedNotification?.id ?? "none"}`
            : `item:${selectedItem?.path ?? "none"}`;
  const detailScrollRef = useRef<HTMLDivElement>(null);

  // Snap the detail pane back to the top whenever it switches to a different
  // work item, notification, or content mode. Because the scroll container is
  // reused across selections, the previous target's offset would otherwise
  // carry over into the newly opened detail.
  useEffect(() => {
    const node = detailScrollRef.current;
    if (!node) {
      return;
    }
    // jsdom implements `scrollTop` but not `scrollTo`; prefer `scrollTo` in
    // real browsers and fall back to assigning `scrollTop` when it is absent.
    if (typeof node.scrollTo === "function") {
      node.scrollTo({ top: 0, left: 0 });
    } else {
      node.scrollTop = 0;
    }
  }, [detailScrollResetKey]);

  const selectedBodyReady =
    !selectedItem ||
    Boolean(selectedItem.body) ||
    loadedItemBodies[selectedItem.path] !== undefined;
  const detailReady =
    activeFeatureId === "inbox" &&
    (showNotifications
      ? Boolean(
          selectedNotification && notificationDetail.detail && !notificationDetail.loading
        )
      : Boolean(selectedItem && selectedBodyReady && !itemThread.loading));
  const expectedDetailMarkdownBodies =
    activeFeatureId !== "inbox"
      ? 0
      : showNotifications
        ? notificationDetail.detail
          ? 1 + countConversationMarkdownBodies(notificationDetail.detail.comments)
          : 0
        : selectedItem
          ? 1 + countConversationMarkdownBodies(itemThread.thread?.comments ?? [])
          : 0;
  const detailContentReady = useDetailContentPaintReady(
    detailScrollRef,
    activeDetailKey,
    detailReady,
    expectedDetailMarkdownBodies
  );
  const activeDetailRenderSnapshot =
    activeDetailKey && !detailContentReady
      ? getDetailRenderSnapshot(activeDetailKey)
      : null;
  useDetailRenderSnapshotCapture({
    rootRef: detailScrollRef,
    detailKey: activeDetailKey,
    enabled: detailReady && detailContentReady
  });
  const detailRevalidationTarget = useMemo<DetailRevalidationTarget | null>(() => {
    if (!activeDetailKey || !auth.connection.token.trim()) {
      return null;
    }
    if (showNotifications) {
      return selectedNotification
        ? {
            kind: "notification",
            key: activeDetailKey,
            token: auth.connection.token,
            apiBaseUrl: auth.connection.apiBaseUrl,
            webBaseUrl: auth.connection.webBaseUrl,
            notification: selectedNotification
          }
        : null;
    }
    if (!detailVisible || !selectedItem || selectedItem.frontMatter.number <= 0) {
      return null;
    }
    return {
      kind: "item",
      key: activeDetailKey,
      connection: auth.connection,
      item: {
        kind: selectedItem.frontMatter.kind,
        owner: selectedItem.frontMatter.owner,
        repo: selectedItem.frontMatter.repo,
        number: selectedItem.frontMatter.number
      }
    };
  }, [
    activeDetailKey,
    auth.connection,
    detailVisible,
    selectedItem,
    selectedNotification,
    showNotifications
  ]);
  const refreshActiveDetailAfterRemoteChange = useCallback(() => {
    if (activeDetailKey) {
      deleteDetailRenderSnapshot(activeDetailKey);
    }
    setConversationRefreshKey((current) => current + 1);
  }, [activeDetailKey]);
  useDetailRevalidation({
    target: detailRevalidationTarget,
    enabled:
      online &&
      detailReady &&
      detailContentReady &&
      authGate.state === "passed" &&
      activeFeatureId === "inbox" &&
      !showNewIssue,
    onChanged: refreshActiveDetailAfterRemoteChange,
    onError: (message) => tracePerf("detail_revalidation_error", { message })
  });
  // Selection renders run as a transition so heavy detail renders stay
  // interruptible (clicking another row mid-render is never blocked).
  // `selectionPending` also keeps the paint-timing hook from completing a
  // measurement against a frame painted before the transition commits.
  const [selectionPending, startSelectionTransition] = useTransition();
  const { getDetailDisplayDurationMs, startDetailTransition } =
    useDetailDisplayTiming(
      activeDetailKey,
      !selectionPending &&
        (Boolean(activeDetailRenderSnapshot) ||
          (detailReady && detailContentReady))
    );
  const selectItemPath = useCallback(
    (path: string) => {
      const startedAt =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      startDetailTransition(startedAt);
      startSelectionTransition(() => {
        setSelectedPath(path);
        setShowNewIssue(false);
      });
    },
    [startDetailTransition, startSelectionTransition]
  );
  const markNotificationViewed = unfilteredNotifications.markNotificationViewed;
  const selectNotification = useCallback(
    (notification: GitHubNotification) => {
      startSelectionTransition(() => {
        setSelectedNotification(notification);
        markNotificationViewed(notification);
      });
    },
    [markNotificationViewed, startSelectionTransition]
  );

  // Pull-based status metrics: the status bar polls this stable getter on its
  // own interval, so metric churn (prefetch progress, cache growth, paint
  // timings) never re-renders the app shell. State-held inputs are mirrored
  // through a ref refreshed each render; everything else is read from O(1)
  // cache-stat getters at poll time. Body byte estimation (O(total bytes))
  // also runs at poll time, which only happens in dev/perf builds.
  const statusMetricsInputs = useRef({
    activeFeatureId,
    listFetchDurationMs: workItems.lastFetchDurationMs,
    showNotifications,
    loadedItemBodies
  });
  statusMetricsInputs.current = {
    activeFeatureId,
    listFetchDurationMs: workItems.lastFetchDurationMs,
    showNotifications,
    loadedItemBodies
  };
  const getStatusMetrics = useCallback((): StatusBarMetrics => {
    const inputs = statusMetricsInputs.current;
    // Notes (and any non-Inbox feature) never touches the Inbox caches, so the
    // status bar reads neutral metrics rather than polling stale getters.
    if (inputs.activeFeatureId !== "inbox") {
      return neutralStatusMetrics;
    }
    return {
      listFetchDurationMs: inputs.listFetchDurationMs,
      detailDisplayDurationMs: getDetailDisplayDurationMs(),
      // Surface whichever prefetcher is active for the current view.
      prefetch: inputs.showNotifications
        ? getNotificationPrefetchStats()
        : getItemPrefetchStats(),
      caches: inputs.showNotifications
        ? [
            { label: "Notifications", ...getNotificationCacheStats() },
            {
              label: "Notification details",
              ...getNotificationDetailCacheStats()
            },
            { label: "Markdown", ...getMarkdownRenderCacheStats() }
          ]
        : [
            { label: "Bodies", ...estimateRecordBytes(inputs.loadedItemBodies) },
            { label: "Threads", ...getItemThreadCacheStats() },
            { label: "Markdown", ...getMarkdownRenderCacheStats() }
          ]
    };
    // activeFeatureId gates the whole readout (neutral off Inbox), so a feature
    // switch must give the status bar a fresh getter to re-poll immediately
    // rather than waiting for the next interval tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeFeatureId,
    getDetailDisplayDurationMs,
    getItemPrefetchStats,
    getNotificationPrefetchStats
  ]);

  const layoutStyle = {
    ...navigationListAccentStyle,
    // Collapsing zeroes the effective column width while the stored width is
    // preserved in the hook, so expanding restores the previous size.
    "--sidebar-width": paneCollapsed.sidebar ? "0px" : `${paneWidths.sidebar}px`,
    "--list-width": paneCollapsed.list ? "0px" : `${paneWidths.list}px`
  } as CSSProperties;

  useEffect(() => {
    const message = repositoryGroups.error ?? visibleRepositoryCounts.error;
    if (message) {
      showAppSnackbar(message);
    }
  }, [repositoryGroups.error, visibleRepositoryCounts.error]);

  function onToggleFavorite() {
    if (!selectedItem) {
      return;
    }
    if (drafts.some((draft) => draft.path === selectedItem.path)) {
      setDrafts((current) =>
        current.map((item) =>
          item.path === selectedItem.path ? toggleFavorite(item) : item
        )
      );
      return;
    }
    workItems.toggleFavorite(selectedItem.path);
  }

  function openSettings(section?: SettingsSection) {
    if (section) {
      setSettingsSection(section);
    }
    setRepositoryFilter(null);
    setShowNewIssue(false);
    setShowNotifications(false);
    changeActiveFeature("settings");
    setSettingsStatus("");
  }

  function openNotifications() {
    setRepositoryFilter(null);
    setShowNewIssue(false);
    setShowNotifications(true);
    changeActiveFeature("inbox");
  }

  function editQueuedComment(operation: OutboxOperationDocument) {
    const { target } = operation.frontMatter;

    openOutboxTarget(operation);
    if (target.parent_comment_id !== undefined || target.parent_comment_node_id) {
      setCommentDraft("");
      setReplyDraft({
        parentId: target.parent_comment_id,
        parentNodeId: target.parent_comment_node_id,
        body: operation.body,
        version: Date.now()
      });
    } else {
      setReplyDraft(undefined);
      setCommentDraft(operation.body);
    }
    outboxSync.discardOutboxOperation(operation);
  }

  function editQueuedIssue(operation: OutboxOperationDocument) {
    const { target } = operation.frontMatter;
    const localFilePath = operation.frontMatter.local_file_path;
    const draft = [...drafts, ...items, ...inboxItems].find(
      (item) => item.path === localFilePath
    );
    const title = draft?.frontMatter.title ?? operation.body;
    const repositoryKey = `${target.owner}/${target.repo}`;

    setDraftIssue({
      title,
      body: draft?.body ?? "",
      repositoryKey
    });
    setReplyDraft(undefined);
    setSelectedPath(localFilePath);
    setRepositoryFilter(repositoryKey);
    setFilter("all");
    setQuery("");
    setItemStateFilter("open");
    changeActiveFeature("inbox");
    setShowNotifications(false);
    outboxSync.setShowOutbox(false);
    setShowNewIssue(true);

    if (draft && !draft.body) {
      void loadItemDocumentBody(vaultRoot, draft)
        .then((body) => {
          setDraftIssue((current) =>
            current.title === title && current.repositoryKey === repositoryKey
              ? { ...current, body }
              : current
          );
        })
        .finally(() => outboxSync.discardOutboxOperation(operation));
    } else {
      outboxSync.discardOutboxOperation(operation);
    }
  }

  function editOutboxOperation(operation: OutboxOperationDocument) {
    if (operation.frontMatter.operation === "create_issue") {
      editQueuedIssue(operation);
      return;
    }
    editQueuedComment(operation);
  }

  function openOutboxTarget(operation: OutboxOperationDocument) {
    const { target } = operation.frontMatter;
    if (!target.kind || typeof target.number !== "number") {
      return;
    }

    const match = [...items, ...inboxItems, ...drafts].find(
      (item) =>
        item.frontMatter.host === target.host &&
        item.frontMatter.owner === target.owner &&
        item.frontMatter.repo === target.repo &&
        item.frontMatter.kind === target.kind &&
        item.frontMatter.number === target.number
    );
    const fallbackPath = itemMainPath(vaultRoot, {
      host: target.host,
      owner: target.owner,
      repo: target.repo,
      kind: target.kind,
      number: target.number
    });

    setSelectedPath(match?.path ?? fallbackPath);
    setRepositoryFilter(`${target.owner}/${target.repo}`);
    setFilter("all");
    setQuery("");
    setItemStateFilter(
      match?.frontMatter.state === "closed" || match?.frontMatter.state === "merged"
        ? "closed"
        : "open"
    );
    changeActiveFeature("inbox");
    setShowNewIssue(false);
    setShowNotifications(false);
    outboxSync.setShowOutbox(false);
  }

  function queueCommentForTarget(
    target: CommentTarget | null,
    action: CommentSubmitAction,
    bodyOverride?: string,
    parentComment?: ConversationComment
  ) {
    const body = (bodyOverride ?? commentDraft).trim();
    const closeAfterComment =
      action.type === "comment-and-close" ? action.close : undefined;
    if (!target || (!body && !closeAfterComment)) {
      return;
    }

    const id = createOperationId("comment");
    const createdAt = new Date().toISOString();
    const operation = createCommentOutboxOperation({
      id,
      host: target.host,
      owner: target.owner,
      repo: target.repo,
      itemKind: target.kind,
      number: target.number,
      parentCommentId: parentComment?.id,
      parentCommentNodeId: parentComment?.nodeId,
      closeAfterComment,
      localFilePath: commentFilePath(vaultRoot, {
        kind: target.kind,
        host: target.host,
        owner: target.owner,
        repo: target.repo,
        number: target.number,
        created_at: createdAt,
        local_id: id
      }),
      createdAt,
      vaultRoot
    });
    const comment: CommentDocument = {
      path: operation.frontMatter.local_file_path,
      body,
      frontMatter: {
        kind: "issue_comment",
        ...(parentComment?.id !== undefined
          ? { parent_remote_id: parentComment.id }
          : {}),
        ...(parentComment?.nodeId ? { parent_node_id: parentComment.nodeId } : {}),
        author: "local",
        created_at: createdAt,
        updated_at: createdAt,
        sync: { status: "pending" }
      }
    };
    const queuedOperation = { ...operation, body };

    appendOutboxOperation(queuedOperation);
    if (bodyOverride === undefined) {
      setCommentDraft("");
    }
    const persistence = body
      ? Promise.all([
          persistCommentDocument(vaultRoot, comment),
          persistOutboxOperation(vaultRoot, queuedOperation)
        ])
      : persistOutboxOperation(vaultRoot, queuedOperation);
    void persistence.then(() => outboxSync.syncQueuedOperation(queuedOperation));
    if (closeAfterComment) {
      showAppSnackbar(body ? "Close with comment queued." : "Close queued.");
    }
  }

  function queueItemComment(action: CommentSubmitAction) {
    if (!selectedItem) {
      return;
    }
    queueCommentForTarget(
      {
        host: selectedItem.frontMatter.host,
        owner: selectedItem.frontMatter.owner,
        repo: selectedItem.frontMatter.repo,
        kind: selectedItem.frontMatter.kind,
        number: selectedItem.frontMatter.number
      },
      action
    );
  }

  function queueItemReply(parent: ConversationComment, body: string) {
    if (!selectedItem || selectedItem.frontMatter.kind !== "discussion") {
      return;
    }
    setReplyDraft(undefined);
    queueCommentForTarget(
      {
        host: selectedItem.frontMatter.host,
        owner: selectedItem.frontMatter.owner,
        repo: selectedItem.frontMatter.repo,
        kind: selectedItem.frontMatter.kind,
        number: selectedItem.frontMatter.number
      },
      { type: "comment" },
      body,
      parent
    );
  }

  function queueNotificationComment(action: CommentSubmitAction) {
    queueCommentForTarget(selectedNotificationCommentTarget, action);
  }

  function queueNotificationReply(parent: ConversationComment, body: string) {
    if (selectedNotification?.subject.type !== "Discussion") {
      return;
    }
    setReplyDraft(undefined);
    queueCommentForTarget(
      selectedNotificationCommentTarget,
      { type: "comment" },
      body,
      parent
    );
  }

  function updateSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setSettings((current) => ({
      ...current,
      [key]: value
    }));
    setSettingsStatus("");
  }

  function saveSettings(event: FormEvent) {
    event.preventDefault();
    persistSettings(settings);
    setSettingsStatus("Settings saved");
  }

  // Settings → Reset flow: the hook drives resetApplicationData and step
  // progress; this callback restores App-owned state to its defaults.
  const { resetProgress, resetAllSettingsAndCaches } = useSettingsReset({
    vaultRoot,
    serverUrls: servers.urls,
    onRestoreDefaults: () => {
      auth.logout();
      servers.reset();
      projectVisibility.reset();
      setThemeMode("system");
      setLightTheme("default");
      setDarkTheme("dark");
      setSettings(defaultSettings);
      setDrafts([]);
      outboxSync.setOutbox([]);
      setSelectedPath(null);
      setSelectedNotification(null);
      setQuery("");
      setFilter("all");
      setItemStateFilter("open");
      setRepositoryFilter(null);
      setShowNewIssue(false);
      setShowNotifications(false);
      setDraftIssue({ title: "", body: "", repositoryKey: "" });
      setCommentDraft("");
    },
    onStatus: setSettingsStatus
  });

  const showingResetResult =
    showSettings && settingsSection === "reset" && resetProgress.status !== "idle";

  function renderInboxPanes(): FeaturePanes {
    return {
      middle: showNotifications ? (
        <NotificationsPane
          state={notifications}
          webBaseUrl={auth.connection.webBaseUrl}
          online={online}
          selectedId={selectedNotification?.id ?? null}
          onSelect={selectNotification}
          onVisibleNotificationsChange={setVisibleNotificationPrefetchItems}
        />
      ) : (
        <ItemListPane
          items={filteredItems}
          selectedPath={selectedItem?.path ?? null}
          stateFilter={itemStateFilter}
          stateCounts={displayedItemStateCounts}
          itemSort={itemSort}
          query={query}
          loading={workItems.loading}
          error={workItems.error}
          demoMode={workItems.demoMode}
          online={online}
          onItemSortChange={setScopedItemSort}
          onStateFilterChange={setItemStateFilter}
          onQueryChange={setQuery}
          onSelect={selectItemPath}
          onVisibleItemsChange={setVisiblePrefetchItems}
          onNewIssue={openNewIssue}
          onRefresh={workItems.refresh}
        />
      ),
      detail: showNewIssue ? (
        <NewIssuePage
          draft={draftIssue}
          repositories={repositories}
          online={online}
          onChange={setDraftIssue}
          onSubmit={queueIssue}
          onClose={() => setShowNewIssue(false)}
        />
      ) : showNotifications ? (
        <NotificationDetail
          notification={selectedNotification}
          state={notificationDetail}
          online={online}
          commentDraft={commentDraft}
          replyDraft={replyDraft}
          detailMaximized={detailMaximized}
          onToggleMaximize={toggleDetailMaximized}
          onHeaderVisibilityChange={setDetailHeaderVisible}
          onOpenInBrowser={notifications.openNotification}
          onCommentDraftChange={setCommentDraft}
          onQueueComment={queueNotificationComment}
          onQueueReply={queueNotificationReply}
        />
      ) : (
        <ItemDetail
          item={selectedItemWithBody}
          thread={itemThread}
          online={online}
          commentDraft={commentDraft}
          replyDraft={replyDraft}
          detailMaximized={detailMaximized}
          onToggleMaximize={toggleDetailMaximized}
          onHeaderVisibilityChange={setDetailHeaderVisible}
          onCommentDraftChange={setCommentDraft}
          onQueueComment={queueItemComment}
          onQueueReply={queueItemReply}
          onToggleFavorite={onToggleFavorite}
        />
      )
    };
  }

  function renderSettingsPanes(): FeaturePanes {
    return {
      middle: (
        <SettingsCategoryPane section={settingsSection} onSelect={setSettingsSection} />
      ),
      detail: (
        <Suspense fallback={<div className="detail-loading">Loading settings...</div>}>
          <SettingsPage
            section={settingsSection}
            settings={settings}
            status={settingsStatus}
            resetProgress={resetProgress}
            themeMode={themeMode}
            lightTheme={lightTheme}
            darkTheme={darkTheme}
            onThemeModeChange={setThemeMode}
            onLightThemeChange={setLightTheme}
            onDarkThemeChange={setDarkTheme}
            servers={servers}
            auth={auth}
            repositoryGroups={repositoryGroups.groups}
            projectVisibility={projectVisibility}
            onUpdate={updateSetting}
            onSave={saveSettings}
            onResetAll={resetAllSettingsAndCaches}
            onClose={() => changeActiveFeature("inbox")}
          />
        </Suspense>
      )
    };
  }

  const panes = activeFeature.renderPanes({
    renderInboxPanes,
    renderSettingsPanes
  });
  const ActiveFeatureProvider = activeFeature.Provider;

  if (activeFeature.requiresGithubAuth && authGate.state === "checking") {
    return <AuthRestorePage onOpenNotes={() => changeActiveFeature("notes")} />;
  }

  if (
    activeFeature.requiresGithubAuth &&
    authGate.state === "required" &&
    !showingResetResult
  ) {
    return (
      <LoginPage
        servers={servers}
        auth={auth}
        checking={false}
        error={authGate.error}
        onSkip={authGate.skipLogin}
        onOpenNotes={() => changeActiveFeature("notes")}
      />
    );
  }

  return (
    <GithubConnectionContext.Provider value={auth.connection}>
    <MarkdownStyleContext.Provider value={settings.markdownStyle}>
    <VaultRootContext.Provider value={vaultRoot}>
    <main
      className="app-shell"
      aria-label="Yonalist layout"
      style={layoutStyle}
      data-sidebar-collapsed={paneCollapsed.sidebar ? "true" : undefined}
      data-list-collapsed={paneCollapsed.list ? "true" : undefined}
      data-detail-maximized={detailMaximized ? "true" : undefined}
    >
      <TitleBar
        paneToggles={{
          sidebarCollapsed: paneCollapsed.sidebar,
          detailMaximized,
          onToggleSidebar: () => togglePaneCollapsed("sidebar"),
          onToggleMaximize: toggleDetailMaximized,
          showDetailMaximizeToggle: !detailHeaderVisible
        }}
      />
      <Sidebar
        online={online}
        loginRequired={!auth.signedIn}
        onToggleOnline={toggleOnline}
        filter={filter}
        onFilterChange={(next) => {
          setFilter(next);
          setRepositoryFilter(null);
          setShowNewIssue(false);
          setShowNotifications(false);
          changeActiveFeature("inbox");
        }}
        repositoryFilter={repositoryFilter}
        onRepositoryFilterChange={(key) => {
          setRepositoryFilter(key);
          setShowNewIssue(false);
          setShowNotifications(false);
          changeActiveFeature("inbox");
        }}
        repositoryGroups={visibleRepositoryCounts.groups}
        repositoriesLoading={repositoryGroups.loading}
        counts={filterCounts}
        settingsOpen={showSettings}
        onOpenSettings={openSettings}
        onOpenProjectSettings={() => openSettings("projects")}
        notificationsOpen={activeFeatureId === "inbox" && showNotifications}
        onOpenNotifications={openNotifications}
        unreadNotificationCount={
          // Until the repository filter basis has loaded, the raw unread
          // count would flash (e.g. 300 → 15); hold the badge back instead.
          displayedUnreadNotificationCount
        }
        notificationsLoading={
          notifications.loading || (!notifications.demoMode && !repositoryGroups.loaded)
        }
        activeFeatureId={activeFeatureId}
        featureEntries={featureRegistry}
        onFeatureChange={changeActiveFeature}
      />

      <div
        className="pane-resizer sidebar-list-resizer"
        role="separator"
        aria-label="Resize navigation pane"
        aria-orientation="vertical"
        aria-valuemin={paneWidthLimits.sidebar.min}
        aria-valuemax={paneWidthLimits.sidebar.max}
        aria-valuenow={paneWidths.sidebar}
        tabIndex={0}
        onPointerDown={(event) => startResize("sidebar", event)}
        onKeyDown={(event) => resizeWithKeyboard("sidebar", event)}
      />

      <ActiveFeatureProvider>
        {panes.middle}

        <div
          className="pane-resizer list-detail-resizer"
          role="separator"
          aria-label="Resize item list pane"
          aria-orientation="vertical"
          aria-valuemin={paneWidthLimits.list.min}
          aria-valuemax={paneWidthLimits.list.max}
          aria-valuenow={paneWidths.list}
          tabIndex={0}
          onPointerDown={(event) => startResize("list", event)}
          onKeyDown={(event) => resizeWithKeyboard("list", event)}
        />

        <section className="detail-pane" aria-label="Detail">
          <div className="pane-titlebar-spacer" />
          <div className="detail-scroll" ref={detailScrollRef}>
            {activeDetailRenderSnapshot && (
              <DetailRenderSnapshotOverlay html={activeDetailRenderSnapshot.html} />
            )}
            {panes.detail}
          </div>
        </section>
      </ActiveFeatureProvider>

      <AppStatusBar
        outboxCount={outboxSync.outbox.length}
        online={online}
        syncing={outboxSync.syncing}
        getMetrics={getStatusMetrics}
        onOpenOutbox={outboxSync.openOutbox}
      />

      {outboxSync.showOutbox && (
        <OutboxModal
          outbox={outboxSync.outbox}
          selectedIds={outboxSync.selectedOutboxIds}
          online={online}
          syncing={outboxSync.syncing}
          remoteChangedIds={outboxSync.remoteChangedOutboxIds}
          onToggleSelection={outboxSync.toggleOutboxSelection}
          onOpenTarget={openOutboxTarget}
          onEdit={editOutboxOperation}
          onDelete={outboxSync.deleteOutboxOperation}
          onSync={() => void outboxSync.syncSelectedOutbox()}
          onClose={() => outboxSync.setShowOutbox(false)}
        />
      )}
      <ConfirmDialog
        open={outboxSync.reconnectSyncPrompt !== null}
        onOpenChange={(next) => {
          if (!next) {
            outboxSync.setReconnectSyncPrompt(null);
          }
        }}
        title="대기 중인 변경 전송"
        description={
          outboxSync.reconnectSyncPrompt
            ? `오프라인에서 작성한 변경 ${outboxSync.reconnectSyncPrompt.count}건을 지금 원격으로 보낼까요?`
            : ""
        }
        confirmLabel="전송"
        cancelLabel="나중에"
        onConfirm={() => {
          if (outboxSync.reconnectSyncPrompt) {
            void outboxSync.autoFlushOutbox(
              outboxSync.reconnectSyncPrompt.operations
            );
          }
        }}
      />
      <Toast.Provider
        toastManager={appToastManager}
        timeout={APP_SNACKBAR_TIMEOUT_MS}
      >
        <Toast.Portal>
          <Toast.Viewport className="app-toast-viewport" aria-label="App messages">
            <AppSnackbarToasts />
          </Toast.Viewport>
        </Toast.Portal>
      </Toast.Provider>
    </main>
    </VaultRootContext.Provider>
    </MarkdownStyleContext.Provider>
    </GithubConnectionContext.Provider>
  );
}
