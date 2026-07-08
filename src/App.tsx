import {
  type CSSProperties,
  type FormEvent,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Toast } from "@base-ui/react/toast";
import "./components/ui/toast.css";
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
  type DraftIssue,
  type RepositoryEntry
} from "./components/NewIssuePage";
import { NotificationDetail } from "./components/NotificationDetail";
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
import { getMarkdownRenderCacheStats } from "./components/MarkdownBody";
import { toggleFavorite } from "./domain/favorites";
import {
  createCommentOutboxOperation,
  createIssueOutboxOperation
} from "./domain/outbox";
import { mergeItemDocuments, withVaultItemPath } from "./domain/items";
import { commentFilePath, draftIssuePath, itemMainPath } from "./domain/paths";
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
import { SAMPLE_VAULT_ROOT } from "./fixtures/sampleItems";
import { useGithubAuth } from "./hooks/useGithubAuth";
import { useAuthGate } from "./hooks/useAuthGate";
import { useAppBadge } from "./hooks/useAppBadge";
import { useGithubServers } from "./hooks/useGithubServers";
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
import { useVisibleItemPrefetch } from "./hooks/useVisibleItemPrefetch";
import { useVisibleNotificationPrefetch } from "./hooks/useVisibleNotificationPrefetch";
import {
  resetApplicationData,
  type ResetApplicationStepId
} from "./services/appReset";
import {
  idleResetProgress,
  type ResetProgressItem,
  type ResetProgressState,
  type ResetProgressStepStatus
} from "./resetProgress";
import { createGitHubClient } from "./services/github";
import { clearImageProxyCache } from "./services/imageProxy";
import { scheduleIdleTask } from "./services/idleQueue";
import {
  clearItemThreadCache,
  getItemThreadCacheStats
} from "./services/itemThread";
import { estimateRecordBytes } from "./services/cacheStats";
import { clearNotificationDetailCache } from "./services/notificationDetail";
import { clearNotificationCache } from "./services/notifications";
import { tracePerf, tracePerfOnce } from "./services/perfTrace";
import { isRemoteReachable } from "./services/remoteReachability";
import { syncOutboxOperations, type OutboxSyncResult } from "./services/sync";
import {
  commentDocumentContents,
  deleteVaultDocument,
  itemDocumentContents,
  loadItemDocumentBody,
  loadVaultState,
  moveVaultDocument,
  persistCommentDocument,
  persistItemDocument,
  persistItemDocuments,
  persistOutboxOperation,
  rebuildVaultStateFromMarkdown
} from "./services/vaultStore";

// Auto-dismiss timing matches the legacy fixed snackbar (6s).
const APP_SNACKBAR_TIMEOUT_MS = 6000;

// How many of the newest notifications to warm ahead of a click. The
// Notifications pane is not virtualized, so this caps the top-of-feed slice we
// prefetch rather than a measured viewport window.
const NOTIFICATION_PREFETCH_CAP = 20;

// A standalone manager lets feedback fire from effects and event handlers in
// the App body without needing the `useToastManager` hook (which must run
// under a Toast.Provider that App itself renders).
const appToastManager = Toast.createToastManager();

function showAppSnackbar(message: string) {
  appToastManager.add({ title: message, timeout: APP_SNACKBAR_TIMEOUT_MS });
}

// Renders the queued toasts inside the provider using the shared manager.
function AppSnackbarToasts() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <Toast.Root key={toast.id} toast={toast} className="app-snackbar">
      <Toast.Title />
    </Toast.Root>
  ));
}

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

const resetStepTemplates: Array<{
  id: ResetApplicationStepId | "restore-defaults";
  label: string;
}> = [
  { id: "session-tokens", label: "Sign out saved GitHub sessions" },
  { id: "runtime-caches", label: "Clear in-memory notification and thread caches" },
  { id: "local-storage", label: "Clear local settings and browser caches" },
  { id: "vault-cache", label: "Clear vault index, avatar, and search caches" },
  { id: "restore-defaults", label: "Restore app preferences to defaults" }
];

function createResetProgress(): ResetProgressState {
  return {
    status: "running",
    message: "Resetting settings and caches...",
    steps: resetStepTemplates.map((step) => ({
      ...step,
      status: "pending"
    }))
  };
}

function createOperationId(prefix: string): string {
  const unique =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${unique}`;
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

function AuthRestorePage() {
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
  const [repositoryFilter, setRepositoryFilter] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [outbox, setOutbox] = useState<OutboxOperationDocument[]>([]);
  const [selectedOutboxIds, setSelectedOutboxIds] = useState<Set<string>>(new Set());
  const [showOutbox, setShowOutbox] = useState(false);
  // Pending reconnect-sync confirmation; the captured operations are flushed
  // only if the user accepts. Null when no prompt is open.
  const [reconnectSyncPrompt, setReconnectSyncPrompt] = useState<{
    operations: OutboxOperationDocument[];
    count: number;
  } | null>(null);
  const [showNewIssue, setShowNewIssue] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("appearance");
  // Notifications are the landing view once authentication passes.
  const [showNotifications, setShowNotifications] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);
  const [loadedItemBodies, setLoadedItemBodies] = useState<Record<string, string>>({});
  const [visiblePrefetchItems, setVisiblePrefetchItems] = useState<ItemDocument[]>([]);
  const [conversationRefreshKey, setConversationRefreshKey] = useState(0);
  const [detailDisplayDurationMs, setDetailDisplayDurationMs] =
    useState<number | null>(null);
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [settingsStatus, setSettingsStatus] = useState("");
  const [resetProgress, setResetProgress] =
    useState<ResetProgressState>(idleResetProgress);
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
    let cancelled = false;
    const startedAt = performance.now();
    tracePerf("vault_load_start", { vaultRoot });
    void loadVaultState(vaultRoot)
      .then((state) => {
        if (cancelled) {
          return;
        }
        setDrafts(state.items);
        setOutbox(state.outbox);
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
  }, [vaultRoot]);

  const rebuiltVaultRoot = useRef<string | null>(null);
  useEffect(() => {
    if (authGate.state !== "passed" || rebuiltVaultRoot.current === vaultRoot) {
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
          setOutbox(state.outbox);
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
  }, [authGate.state, vaultRoot]);

  const repositoryScope = useMemo<WorkScope>(() => {
    if (repositoryFilter) {
      const [owner, ...rest] = repositoryFilter.split("/");
      return { type: "repo", owner, name: rest.join("/") };
    }
    return { type: "inbox" };
  }, [repositoryFilter]);
  const inboxWorkItems = useWorkItems(
    auth.connection,
    online,
    { type: "inbox" },
    vaultRoot
  );
  const projectWorkItems = useWorkItems(
    auth.connection,
    online,
    repositoryScope,
    vaultRoot,
    Boolean(repositoryFilter)
  );
  const workItems = repositoryFilter ? projectWorkItems : inboxWorkItems;
  const inboxItems = useMemo(
    () => mergeItemDocuments(drafts, inboxWorkItems.items, vaultRoot),
    [drafts, inboxWorkItems.items, vaultRoot]
  );
  const items = useMemo(
    () => mergeItemDocuments(drafts, workItems.items, vaultRoot),
    [drafts, workItems.items, vaultRoot]
  );
  const unfilteredNotifications = useNotifications(
    auth.connection,
    online,
    authGate.state === "passed"
  );
  const repositoryGroups = useRepositories(
    auth.connection,
    online,
    inboxItems,
    unfilteredNotifications.notifications
  );
  // Conflict hint: comment targets that changed remotely after the comment
  // was queued, so the user can re-read the thread before syncing.
  const remoteChangedOutboxIds = useMemo(() => {
    const changed = new Set<string>();
    for (const operation of outbox) {
      if (operation.frontMatter.operation !== "create_comment") {
        continue;
      }
      const { target } = operation.frontMatter;
      const item = items.find(
        (candidate) =>
          candidate.frontMatter.owner === target.owner &&
          candidate.frontMatter.repo === target.repo &&
          candidate.frontMatter.number === target.number
      );
      if (item && item.frontMatter.updated_at > operation.frontMatter.created_at) {
        changed.add(operation.frontMatter.id);
      }
    }
    return changed;
  }, [outbox, items]);

  useEffect(() => {
    if (
      authGate.state !== "passed" ||
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
  }, [authGate.state, online, workItems.demoMode, workItems.items, vaultRoot]);
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
    showSettings || showNotifications ? null : repositoryFilter;
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
  const notifications = {
    ...unfilteredNotifications,
    notifications: filteredNotificationItems,
    unreadCount: filteredUnreadNotificationCount
  };
  const displayedUnreadNotificationCount =
    repositoryGroups.loaded ? notifications.unreadCount : 0;
  useAppBadge(authGate.state === "passed" ? displayedUnreadNotificationCount : 0);
  useDesktopNotifications({
    connection: auth.connection,
    viewedAt: notifications.viewedAt,
    online,
    enabled: settings.desktopNotifications && authGate.state === "passed",
    demoMode: notifications.demoMode,
    isRepoVisible: notificationRepoFilter
  });
  const [selectedNotification, setSelectedNotification] =
    useState<GitHubNotification | null>(null);
  useEffect(() => {
    if (!showNotifications) {
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
    showNotifications,
    notifications.notifications.length,
    notifications.unreadCount,
    notifications.loading,
    notifications.demoMode
  ]);
  const notificationDetail = useNotificationDetail(
    selectedNotification,
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
  const [draftIssue, setDraftIssue] = useState<DraftIssue>({
    title: "",
    body: "",
    repositoryKey: ""
  });



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
    return items.filter((item) => {
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
  }, [items, filter, repositoryFilter, query, loadedItemBodies]);

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
  }, [selectedItem, loadedItemBodies, vaultRoot]);

  const detailVisible =
    authGate.state === "passed" &&
    !showSettings &&
    !showNewIssue &&
    !showNotifications;
  const itemThread = useItemThread(
    detailVisible ? selectedItemWithBody ?? null : null,
    auth.connection,
    online,
    conversationRefreshKey
  );

  const prefetchStats = useVisibleItemPrefetch({
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
      !showSettings &&
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

  // The Notifications pane is not virtualized and its rows are cheap, so rather
  // than measure a scroll viewport we warm the top slice of the newest-first
  // filtered feed — the rows the user is most likely to click first. The cap
  // bounds concurrent detail fetches; the prefetch hook further limits them.
  const notificationPrefetchTargets = useMemo(
    () => notifications.notifications.slice(0, NOTIFICATION_PREFETCH_CAP),
    [notifications.notifications]
  );
  const notificationPrefetchEnabled =
    showNotifications &&
    settings.prefetchVisibleItems !== false &&
    authGate.state === "passed" &&
    !notifications.demoMode &&
    !showSettings &&
    !showNewIssue;
  const notificationPrefetchStats = useVisibleNotificationPrefetch({
    visibleNotifications: notificationPrefetchEnabled
      ? notificationPrefetchTargets
      : [],
    selectedId: selectedNotification?.id ?? null,
    connection: auth.connection,
    online,
    enabled: notificationPrefetchEnabled,
    onError: (message) => {
      tracePerf("visible_notification_prefetch_error", { message });
    }
  });
  const activeDetailKey = showNotifications
    ? selectedNotification
      ? `notification:${selectedNotification.id}`
      : null
    : detailVisible && selectedItem
      ? `item:${selectedItem.path}`
      : null;
  const detailStartedAt = useRef<number | null>(null);
  // Identifies what the shared `.detail-scroll` container is currently showing.
  // The same DOM node is reused across every selection and content mode, so a
  // change here means the pane switched targets and its scroll must snap back
  // to the top (see the reset effect below). Same-target re-clicks leave this
  // key unchanged, so the previous scroll position is preserved.
  const detailScrollResetKey = showSettings
    ? `settings:${settingsSection}`
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
  const detailReady = showNotifications
    ? Boolean(selectedNotification && notificationDetail.detail && !notificationDetail.loading)
    : Boolean(selectedItem && selectedBodyReady && !itemThread.loading);

  useEffect(() => {
    if (!activeDetailKey) {
      detailStartedAt.current = null;
      setDetailDisplayDurationMs(null);
      return;
    }
    if (detailStartedAt.current === null) {
      detailStartedAt.current =
        typeof performance !== "undefined" ? performance.now() : Date.now();
    }
    setDetailDisplayDurationMs(null);
  }, [activeDetailKey]);

  useEffect(() => {
    if (!activeDetailKey || !detailReady || detailStartedAt.current === null) {
      return;
    }
    const finishedAt =
      typeof performance === "undefined" ? Date.now() : performance.now();
    setDetailDisplayDurationMs(finishedAt - detailStartedAt.current);
    detailStartedAt.current = null;
  }, [activeDetailKey, detailReady]);

  const statusMetrics = useMemo<StatusBarMetrics>(
    () => {
      const bodyStats = estimateRecordBytes(loadedItemBodies);
      const threadStats = getItemThreadCacheStats();
      const markdownStats = getMarkdownRenderCacheStats();
      return {
        listFetchDurationMs: workItems.lastFetchDurationMs,
        detailDisplayDurationMs,
        // Surface whichever prefetcher is active for the current view.
        prefetch: showNotifications ? notificationPrefetchStats : prefetchStats,
        caches: [
          { label: "Bodies", ...bodyStats },
          { label: "Threads", ...threadStats },
          { label: "Markdown", ...markdownStats }
        ]
      };
    },
    [
      detailDisplayDurationMs,
      itemThread.thread,
      loadedItemBodies,
      notificationPrefetchStats,
      prefetchStats,
      showNotifications,
      workItems.lastFetchDurationMs
    ]
  );

  const layoutStyle = {
    ...navigationListAccentStyle,
    // Collapsing zeroes the effective column width while the stored width is
    // preserved in the hook, so expanding restores the previous size.
    "--sidebar-width": paneCollapsed.sidebar ? "0px" : `${paneWidths.sidebar}px`,
    "--list-width": paneCollapsed.list ? "0px" : `${paneWidths.list}px`
  } as CSSProperties;

  // When connectivity returns (browser event or manual toggle), queued work is
  // never sent silently: for signed-in sessions we first confirm the actual
  // remote is reachable, then ask before flushing; unsigned sessions surface
  // the queue for review so it is never forgotten. The transition is evaluated
  // once per offline→online edge (guarded by previousOnline), so a cancelled or
  // unreachable probe is not re-asked until the next reconnect.
  const previousOnline = useRef(online);
  useEffect(() => {
    if (
      online &&
      !previousOnline.current &&
      settings.syncQueuedOnReconnect &&
      outbox.length > 0
    ) {
      const retryable = outbox.filter(
        (operation) => operation.frontMatter.status !== "blocked"
      );
      if (auth.connection.token.trim() && retryable.length > 0) {
        void promptReconnectSyncIfReachable(retryable);
      } else if (!auth.connection.token.trim()) {
        setSelectedOutboxIds(
          new Set(outbox.map((operation) => operation.frontMatter.id))
        );
        setShowOutbox(true);
      }
    }
    previousOnline.current = online;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, outbox, settings.syncQueuedOnReconnect]);

  // Sync feedback surfaces as an auto-dismissing toast. Reset the state after
  // queuing so an identical follow-up message re-fires the toast.
  useEffect(() => {
    if (!syncFeedback) {
      return;
    }
    showAppSnackbar(syncFeedback);
    setSyncFeedback(null);
  }, [syncFeedback]);

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

  function openOutbox() {
    setSelectedOutboxIds(new Set(outbox.map((operation) => operation.frontMatter.id)));
    setShowOutbox(true);
  }

  function openSettings(section?: SettingsSection) {
    if (section) {
      setSettingsSection(section);
    }
    setRepositoryFilter(null);
    setShowNewIssue(false);
    setShowNotifications(false);
    setShowSettings(true);
    setSettingsStatus("");
  }

  function openNotifications() {
    setRepositoryFilter(null);
    setShowNewIssue(false);
    setShowSettings(false);
    setShowNotifications(true);
  }

  function openNewIssue() {
    setShowSettings(false);
    setDraftIssue((current) => ({
      ...current,
      repositoryKey:
        current.repositoryKey ||
        (selectedItem
          ? `${selectedItem.frontMatter.owner}/${selectedItem.frontMatter.repo}`
          : repositories[0]?.key ?? "")
    }));
    setShowNewIssue(true);
  }

  function toggleOutboxSelection(id: string) {
    setSelectedOutboxIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function applySyncedOutboxResult(result: OutboxSyncResult) {
    const { operation, remote } = result;
    if (!remote) {
      return;
    }

    if (remote.type === "issue") {
      const draft = items.find(
        (item) => item.path === operation.frontMatter.local_file_path
      );
      if (!draft) {
        await deleteVaultDocument(vaultRoot, operation.path);
        return;
      }

      const syncedFrontMatter = {
        ...draft.frontMatter,
        number: remote.number,
        node_id: remote.node_id,
        html_url: remote.html_url,
        updated_at: remote.updated_at ?? new Date().toISOString(),
        synced_at: new Date().toISOString(),
        sync: { status: "synced" as const }
      };
      const syncedItem: ItemDocument = {
        path: itemMainPath(vaultRoot, syncedFrontMatter),
        frontMatter: syncedFrontMatter,
        body: draft.body
      };

      await moveVaultDocument(
        vaultRoot,
        draft.path,
        syncedItem.path,
        itemDocumentContents(syncedItem)
      );
      setDrafts((current) =>
        current.map((item) => (item.path === draft.path ? syncedItem : item))
      );
    }

    if (remote.type === "comment") {
      const target = operation.frontMatter.target;
      if (target.kind && typeof target.number === "number") {
        const createdAt = remote.created_at ?? new Date().toISOString();
        const comment: CommentDocument = {
          path: commentFilePath(vaultRoot, {
            kind: target.kind,
            host: target.host,
            owner: target.owner,
            repo: target.repo,
            number: target.number,
            created_at: createdAt,
            remote_id: remote.id
          }),
          body: remote.body ?? operation.body,
          frontMatter: {
            kind: "issue_comment",
            remote_id:
              typeof remote.id === "number" ? remote.id : Number(remote.id) || undefined,
            node_id: remote.node_id,
            ...(target.parent_comment_id !== undefined
              ? { parent_remote_id: target.parent_comment_id }
              : {}),
            ...(target.parent_comment_node_id
              ? { parent_node_id: target.parent_comment_node_id }
              : {}),
            author: "local",
            created_at: createdAt,
            updated_at: remote.updated_at ?? createdAt,
            sync: { status: "synced" }
          }
        };

        await moveVaultDocument(
          vaultRoot,
          operation.frontMatter.local_file_path,
          comment.path,
          commentDocumentContents(comment)
        );
      }
    }

    await deleteVaultDocument(vaultRoot, operation.path);
  }

  interface SyncOutcome {
    synced: number;
    failed: number;
    blocked: number;
  }

  /**
   * Pushes the given operations to GitHub and reconciles the vault/outbox.
   * Transient failures stay "failed" (retryable); definitive rejections
   * (target gone, validation) become "blocked" so they are never auto-retried.
   */
  async function performSync(
    selected: OutboxOperationDocument[]
  ): Promise<SyncOutcome | null> {
    if (selected.length === 0) {
      return null;
    }

    const token = auth.connection.token.trim();
    if (!token) {
      // Without credentials the queue is drained locally (prototype mode).
      const syncedIds = new Set(selected.map((operation) => operation.frontMatter.id));
      setOutbox((current) =>
        current.filter((operation) => !syncedIds.has(operation.frontMatter.id))
      );
      setSelectedOutboxIds(new Set());
      setShowOutbox(false);
      return { synced: selected.length, failed: 0, blocked: 0 };
    }

    setSyncing(true);
    try {
      const client = createGitHubClient({
        token,
        apiBaseUrl: auth.connection.apiBaseUrl,
        webBaseUrl: auth.connection.webBaseUrl
      });
      const results = await syncOutboxOperations(client, selected, items);
      await Promise.all(
        results
          .filter((result) => result.ok)
          .map((result) => applySyncedOutboxResult(result))
      );
      const syncedIds = new Set(
        results.filter((result) => result.ok).map((result) => result.operation.frontMatter.id)
      );
      const failures = new Map(
        results
          .filter((result) => !result.ok)
          .map((result) => [result.operation.frontMatter.id, result])
      );

      const operationsById = new Map(
        outbox.map((operation) => [operation.frontMatter.id, operation])
      );
      for (const operation of selected) {
        operationsById.set(operation.frontMatter.id, operation);
      }
      const failedOperations = Array.from(failures.entries()).flatMap(
        ([id, failure]) => {
          const operation = operationsById.get(id);
          if (!operation) {
            return [];
          }
          return [
            {
              ...operation,
              frontMatter: {
                ...operation.frontMatter,
                status: failure.permanent ? ("blocked" as const) : ("failed" as const),
                last_error: failure.error ?? "Sync failed."
              }
            }
          ];
        }
      );
      await Promise.all(
        failedOperations.map((operation) =>
          persistOutboxOperation(vaultRoot, operation)
        )
      );
      setOutbox((current) =>
        current
          .filter((operation) => !syncedIds.has(operation.frontMatter.id))
          .map(
            (operation) =>
              failedOperations.find(
                (failed) => failed.frontMatter.id === operation.frontMatter.id
              ) ?? operation
          )
      );
      setSelectedOutboxIds(new Set());
      return {
        synced: syncedIds.size,
        failed: failedOperations.filter(
          (operation) => operation.frontMatter.status === "failed"
        ).length,
        blocked: failedOperations.filter(
          (operation) => operation.frontMatter.status === "blocked"
        ).length
      };
    } finally {
      setSyncing(false);
    }
  }

  function describeSyncOutcome(outcome: SyncOutcome): string {
    const parts: string[] = [];
    if (outcome.synced > 0) {
      parts.push(
        `Synced ${outcome.synced} queued change${outcome.synced === 1 ? "" : "s"}`
      );
    }
    if (outcome.failed > 0) {
      parts.push(`${outcome.failed} failed`);
    }
    if (outcome.blocked > 0) {
      parts.push(`${outcome.blocked} blocked`);
    }
    return parts.join(" · ");
  }

  function refreshAfterSync(outcome: SyncOutcome) {
    if (outcome.synced === 0) {
      return;
    }
    clearItemThreadCache();
    clearNotificationDetailCache();
    setConversationRefreshKey((current) => current + 1);
    workItems.refresh();
    notifications.refresh();
  }

  async function syncSelectedOutbox() {
    const selected = outbox.filter((operation) =>
      selectedOutboxIds.has(operation.frontMatter.id)
    );
    const outcome = await performSync(selected);
    if (!outcome) {
      return;
    }
    refreshAfterSync(outcome);
    setSyncFeedback(describeSyncOutcome(outcome));
    if (outcome.failed === 0 && outcome.blocked === 0) {
      setShowOutbox(false);
    }
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
    setShowSettings(false);
    setShowNewIssue(false);
    setShowNotifications(false);
    setShowOutbox(false);
  }

  /**
   * On reconnect, confirm the configured server is actually reachable before
   * offering to flush. `navigator.onLine` (and the manual toggle) only prove a
   * network exists — an intranet GHE host can stay unreachable behind a live
   * internet connection — so we probe the real endpoint first. Only when it
   * answers do we surface the confirmation; any failure stays silent, and the
   * next offline→online transition re-evaluates.
   */
  async function promptReconnectSyncIfReachable(
    operations: OutboxOperationDocument[]
  ) {
    const reachable = await isRemoteReachable(auth.connection);
    if (!reachable) {
      return;
    }
    setReconnectSyncPrompt({ operations, count: operations.length });
  }

  /** Reconnect flush: sync everything retryable after the user confirms. */
  async function autoFlushOutbox(operations: OutboxOperationDocument[]) {
    const outcome = await performSync(operations);
    if (!outcome) {
      return;
    }
    refreshAfterSync(outcome);
    setSyncFeedback(describeSyncOutcome(outcome));
    if (outcome.failed > 0 || outcome.blocked > 0) {
      // Leave nothing preselected: blocked entries should not be one-click
      // retried, and the user should review what went wrong.
      setSelectedOutboxIds(new Set());
      setShowOutbox(true);
    }
  }

  async function syncQueuedOperation(operation: OutboxOperationDocument) {
    if (!online || !auth.connection.token.trim()) {
      return;
    }

    const outcome = await performSync([operation]);
    if (!outcome) {
      return;
    }
    refreshAfterSync(outcome);
    setSyncFeedback(describeSyncOutcome(outcome));
    if (outcome.failed > 0 || outcome.blocked > 0) {
      setSelectedOutboxIds(new Set([operation.frontMatter.id]));
      setShowOutbox(true);
    }
  }

  function queueCommentForTarget(
    target: CommentTarget | null,
    action: CommentSubmitAction,
    bodyOverride?: string,
    parentComment?: ConversationComment
  ) {
    const body = (bodyOverride ?? commentDraft).trim();
    if (!body || !target) {
      return;
    }

    const id = createOperationId("comment");
    const createdAt = new Date().toISOString();
    const closeAfterComment = action === "comment-and-close" && target.kind === "issue";
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

    setOutbox((current) => [...current, queuedOperation]);
    if (bodyOverride === undefined) {
      setCommentDraft("");
    }
    void Promise.all([
      persistCommentDocument(vaultRoot, comment),
      persistOutboxOperation(vaultRoot, queuedOperation)
    ]).then(() => syncQueuedOperation(queuedOperation));
    if (closeAfterComment) {
      showAppSnackbar("Comment and close queued.");
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
    queueCommentForTarget(
      {
        host: selectedItem.frontMatter.host,
        owner: selectedItem.frontMatter.owner,
        repo: selectedItem.frontMatter.repo,
        kind: selectedItem.frontMatter.kind,
        number: selectedItem.frontMatter.number
      },
      "comment",
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
    queueCommentForTarget(
      selectedNotificationCommentTarget,
      "comment",
      body,
      parent
    );
  }

  function queueIssue(event: FormEvent) {
    event.preventDefault();
    if (!draftIssue.title.trim()) {
      return;
    }

    const repository =
      repositories.find((entry) => entry.key === draftIssue.repositoryKey) ??
      repositories[0];
    if (!repository) {
      return;
    }

    const localId = createOperationId("issue");
    const draftPath = draftIssuePath(vaultRoot, {
      host: repository.host,
      owner: repository.owner,
      repo: repository.repo,
      local_id: localId
    });
    const newItem: ItemDocument = {
      path: draftPath,
      body: draftIssue.body,
      frontMatter: {
        kind: "issue",
        host: repository.host,
        owner: repository.owner,
        repo: repository.repo,
        number: 0,
        title: draftIssue.title,
        state: "open",
        author: "local",
        labels: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        local: { favorite: false },
        sync: { status: "pending" }
      }
    };
    const operation = createIssueOutboxOperation({
      id: localId,
      host: repository.host,
      owner: repository.owner,
      repo: repository.repo,
      localFilePath: draftPath,
      createdAt: new Date().toISOString(),
      vaultRoot
    });
    const queuedOperation = { ...operation, body: draftIssue.title };

    void persistItemDocument(vaultRoot, newItem);
    void persistOutboxOperation(vaultRoot, queuedOperation);
    setDrafts((current) => [newItem, ...current]);
    setSelectedPath(draftPath);
    setOutbox((current) => [...current, queuedOperation]);
    setDraftIssue({ title: "", body: "", repositoryKey: "" });
    setShowNewIssue(false);
    setShowSettings(false);
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

  function updateResetStep(
    id: ResetProgressItem["id"],
    status: ResetProgressStepStatus,
    detail?: string
  ) {
    setResetProgress((current) => ({
      ...current,
      steps: current.steps.map((step) =>
        step.id === id
          ? {
              ...step,
              status,
              detail: detail ?? step.detail
            }
          : step
      )
    }));
  }

  function failCurrentResetStep(message: string) {
    setResetProgress((current) => ({
      status: "failed",
      message: `Reset failed: ${message}`,
      steps: current.steps.map((step) =>
        step.status === "running"
          ? {
              ...step,
              status: "failed",
              detail: message
            }
          : step
      )
    }));
  }

  async function resetAllSettingsAndCaches() {
    setResetProgress(createResetProgress());
    setSettingsStatus("Resetting...");
    try {
      await resetApplicationData({
        vaultRoot,
        serverUrls: servers.urls,
        onStep: ({ id, status }) => {
          updateResetStep(id, status === "complete" ? "done" : "running");
        }
      });
      updateResetStep("restore-defaults", "running");
      auth.logout();
      servers.reset();
      projectVisibility.reset();
      setThemeMode("system");
      setLightTheme("default");
      setDarkTheme("dark");
      setSettings(defaultSettings);
      setDrafts([]);
      setOutbox([]);
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
      updateResetStep("restore-defaults", "done");
      setSettingsStatus("Settings and caches reset");
      setResetProgress((current) => ({
        ...current,
        status: "done",
        message: "Reset complete. Vault Markdown files and outbox documents were kept."
      }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      failCurrentResetStep(message);
      setSettingsStatus(`Reset failed: ${message}`);
      showAppSnackbar(`Reset failed: ${message}`);
    }
  }

  const showingResetResult =
    showSettings && settingsSection === "reset" && resetProgress.status !== "idle";

  if (authGate.state === "checking") {
    return <AuthRestorePage />;
  }

  if (authGate.state === "required" && !showingResetResult) {
    return (
      <LoginPage
        servers={servers}
        auth={auth}
        checking={false}
        error={authGate.error}
        onSkip={authGate.skipLogin}
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
          setShowSettings(false);
          setShowNewIssue(false);
          setShowNotifications(false);
        }}
        repositoryFilter={repositoryFilter}
        onRepositoryFilterChange={(key) => {
          setRepositoryFilter(key);
          setShowSettings(false);
          setShowNewIssue(false);
          setShowNotifications(false);
        }}
        repositoryGroups={visibleRepositoryCounts.groups}
        repositoriesLoading={repositoryGroups.loading}
        counts={filterCounts}
        settingsOpen={showSettings}
        onOpenSettings={openSettings}
        onOpenProjectSettings={() => openSettings("projects")}
        notificationsOpen={showNotifications}
        onOpenNotifications={openNotifications}
        unreadNotificationCount={
          // Until the repository filter basis has loaded, the raw unread
          // count would flash (e.g. 300 → 15); hold the badge back instead.
          displayedUnreadNotificationCount
        }
        notificationsLoading={
          notifications.loading || (!notifications.demoMode && !repositoryGroups.loaded)
        }
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

      {showSettings ? (
        <SettingsCategoryPane section={settingsSection} onSelect={setSettingsSection} />
      ) : showNotifications ? (
        <NotificationsPane
          state={notifications}
          webBaseUrl={auth.connection.webBaseUrl}
          online={online}
          selectedId={selectedNotification?.id ?? null}
          onSelect={(notification) => {
            setSelectedNotification(notification);
            notifications.markNotificationViewed(notification);
          }}
        />
      ) : (
        <ItemListPane
          items={filteredItems}
          selectedPath={selectedItem?.path ?? null}
          stateFilter={itemStateFilter}
          stateCounts={displayedItemStateCounts}
          query={query}
          loading={workItems.loading}
          error={workItems.error}
          demoMode={workItems.demoMode}
          online={online}
          onStateFilterChange={setItemStateFilter}
          onQueryChange={setQuery}
          onSelect={(path) => {
            const startedAt =
              typeof performance !== "undefined" ? performance.now() : Date.now();
            detailStartedAt.current = startedAt;
            setDetailDisplayDurationMs(null);
            if (path === selectedItem?.path && detailReady) {
              setDetailDisplayDurationMs(0);
              detailStartedAt.current = null;
            }
            setSelectedPath(path);
            setShowNewIssue(false);
            setShowSettings(false);
          }}
          onVisibleItemsChange={setVisiblePrefetchItems}
          onNewIssue={openNewIssue}
          onRefresh={workItems.refresh}
        />
      )}

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
        {showSettings ? (
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
              onClose={() => setShowSettings(false)}
            />
          </Suspense>
        ) : showNewIssue ? (
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
            detailMaximized={detailMaximized}
            onToggleMaximize={toggleDetailMaximized}
            onHeaderVisibilityChange={setDetailHeaderVisible}
            onCommentDraftChange={setCommentDraft}
            onQueueComment={queueItemComment}
            onQueueReply={queueItemReply}
            onToggleFavorite={onToggleFavorite}
          />
        )}
        </div>
      </section>

      <AppStatusBar
        outboxCount={outbox.length}
        online={online}
        syncing={syncing}
        metrics={statusMetrics}
        onOpenOutbox={openOutbox}
      />

      {showOutbox && (
        <OutboxModal
          outbox={outbox}
          selectedIds={selectedOutboxIds}
          online={online}
          syncing={syncing}
          remoteChangedIds={remoteChangedOutboxIds}
          onToggleSelection={toggleOutboxSelection}
          onOpenTarget={openOutboxTarget}
          onSync={() => void syncSelectedOutbox()}
          onClose={() => setShowOutbox(false)}
        />
      )}
      <ConfirmDialog
        open={reconnectSyncPrompt !== null}
        onOpenChange={(next) => {
          if (!next) {
            setReconnectSyncPrompt(null);
          }
        }}
        title="대기 중인 변경 전송"
        description={
          reconnectSyncPrompt
            ? `오프라인에서 작성한 변경 ${reconnectSyncPrompt.count}건을 지금 원격으로 보낼까요?`
            : ""
        }
        confirmLabel="전송"
        cancelLabel="나중에"
        onConfirm={() => {
          if (reconnectSyncPrompt) {
            void autoFlushOutbox(reconnectSyncPrompt.operations);
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
