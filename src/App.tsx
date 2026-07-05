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
import {
  defaultSettings,
  loadSettings,
  persistSettings,
  type AppSettings
} from "./appSettings";
import { GithubConnectionContext } from "./GithubConnectionContext";
import { MarkdownStyleContext } from "./MarkdownStyleContext";
import { VaultRootContext } from "./VaultRootContext";
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
  type GitHubNotification
} from "./domain/notifications";
import type {
  CommentDocument,
  ItemDocument,
  OutboxOperationDocument
} from "./domain/types";
import { SAMPLE_VAULT_ROOT } from "./fixtures/sampleItems";
import { useGithubAuth } from "./hooks/useGithubAuth";
import { useAuthGate } from "./hooks/useAuthGate";
import { useGithubServers } from "./hooks/useGithubServers";
import { useItemThread } from "./hooks/useItemThread";
import { useNotificationDetail } from "./hooks/useNotificationDetail";
import { useDesktopNotifications } from "./hooks/useDesktopNotifications";
import { useNotifications } from "./hooks/useNotifications";
import { useProjectVisibility } from "./hooks/useProjectVisibility";
import { useRepositoryOpenCounts } from "./hooks/useRepositoryOpenCounts";
import { useRepositories } from "./hooks/useRepositories";
import { useWorkItems, type WorkScope } from "./hooks/useWorkItems";
import { paneWidthLimits, usePaneResize } from "./hooks/usePaneResize";
import { useOnlineStatus } from "./hooks/useOnlineStatus";
import { useScrollbarHover } from "./hooks/useScrollbarHover";
import { useTheme } from "./hooks/useTheme";
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
import { clearItemThreadCache } from "./services/itemThread";
import { clearNotificationDetailCache } from "./services/notificationDetail";
import { clearNotificationCache } from "./services/notifications";
import { tracePerf, tracePerfOnce } from "./services/perfTrace";
import { syncOutboxOperations, type OutboxSyncResult } from "./services/sync";
import {
  commentDocumentContents,
  deleteVaultDocument,
  itemDocumentContents,
  loadVaultState,
  moveVaultDocument,
  persistCommentDocument,
  persistItemDocument,
  persistOutboxOperation
} from "./services/vaultStore";

interface AppProps {
  initialOnline?: boolean;
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
  const [showNewIssue, setShowNewIssue] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("appearance");
  // Notifications are the landing view once authentication passes.
  const [showNotifications, setShowNotifications] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);
  const [appSnackbar, setAppSnackbar] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [settingsStatus, setSettingsStatus] = useState("");
  const [resetProgress, setResetProgress] =
    useState<ResetProgressState>(idleResetProgress);
  const { paneWidths, startResize, resizeWithKeyboard } = usePaneResize();
  const servers = useGithubServers();
  const auth = useGithubAuth(servers);
  const vaultRoot = settings.vaultFolder.trim() || SAMPLE_VAULT_ROOT;
  const authGate = useAuthGate({ auth, servers, online });

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
      void Promise.all(
        workItems.items.map((item) =>
          persistItemDocument(vaultRoot, withVaultItemPath(vaultRoot, item))
        )
      );
    });
  }, [authGate.state, online, workItems.demoMode, workItems.items, vaultRoot]);
  // Repos where the user's involves:@me inbox has activity count as
  // "participating" for default project visibility.
  const [involvedRepoNames, setInvolvedRepoNames] = useState<Set<string>>(
    () => new Set()
  );
  const [involvementReady, setInvolvementReady] = useState(false);
  useEffect(() => {
    if (
      !inboxWorkItems.demoMode &&
      inboxWorkItems.items.length > 0
    ) {
      setInvolvedRepoNames(
        new Set(
          inboxWorkItems.items.map(
            (item) => `${item.frontMatter.owner}/${item.frontMatter.repo}`
          )
        )
      );
      setInvolvementReady(true);
    }
  }, [inboxWorkItems.demoMode, inboxWorkItems.items]);
  const projectVisibility = useProjectVisibility(
    repositoryGroups.groups,
    involvedRepoNames,
    involvementReady && !repositoryGroups.loading
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
  useDesktopNotifications({
    notifications: notifications.notifications,
    viewedAt: notifications.viewedAt,
    webBaseUrl: auth.connection.webBaseUrl,
    enabled: settings.desktopNotifications && authGate.state === "passed",
    demoMode: notifications.demoMode
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
    online
  );
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

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return items.filter((item) => {
      if (!repositoryFilter && !matchesFilter(item, filter)) {
        return false;
      }
      if (!matchesStateFilter(item, itemStateFilter)) {
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
        item.body
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [items, filter, itemStateFilter, repositoryFilter, query]);

  const selectedItem =
    filteredItems.find((item) => item.path === selectedPath) ?? filteredItems[0];

  const detailVisible =
    authGate.state === "passed" &&
    !showSettings &&
    !showNewIssue &&
    !showNotifications;
  const itemThread = useItemThread(
    detailVisible ? selectedItem ?? null : null,
    auth.connection,
    online
  );

  const layoutStyle = {
    "--sidebar-width": `${paneWidths.sidebar}px`,
    "--list-width": `${paneWidths.list}px`
  } as CSSProperties;

  // When connectivity returns (browser event or manual toggle), queued work
  // is flushed automatically for signed-in sessions — with a result toast —
  // and surfaced for review otherwise, so it is never silently forgotten.
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
        void autoFlushOutbox(retryable);
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

  // Sync feedback toast auto-dismisses.
  useEffect(() => {
    if (!syncFeedback) {
      return;
    }
    setAppSnackbar(syncFeedback);
  }, [syncFeedback]);

  useEffect(() => {
    const message = repositoryGroups.error ?? visibleRepositoryCounts.error;
    if (message) {
      setAppSnackbar(message);
    }
  }, [repositoryGroups.error, visibleRepositoryCounts.error]);

  useEffect(() => {
    if (!appSnackbar) {
      return;
    }
    const timer = window.setTimeout(() => {
      setAppSnackbar(null);
      setSyncFeedback(null);
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [appSnackbar]);

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

      const failedOperations = outbox
        .filter((operation) => failures.has(operation.frontMatter.id))
        .map((operation) => {
          const failure = failures.get(operation.frontMatter.id);
          return {
            ...operation,
            frontMatter: {
              ...operation.frontMatter,
              status: failure?.permanent ? ("blocked" as const) : ("failed" as const),
              last_error: failure?.error ?? "Sync failed."
            }
          };
        });
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

  async function syncSelectedOutbox() {
    const selected = outbox.filter((operation) =>
      selectedOutboxIds.has(operation.frontMatter.id)
    );
    const outcome = await performSync(selected);
    if (!outcome) {
      return;
    }
    setSyncFeedback(describeSyncOutcome(outcome));
    if (outcome.failed === 0 && outcome.blocked === 0) {
      setShowOutbox(false);
    }
  }

  /** Reconnect flush: sync everything retryable without asking, then report. */
  async function autoFlushOutbox(operations: OutboxOperationDocument[]) {
    const outcome = await performSync(operations);
    if (!outcome) {
      return;
    }
    setSyncFeedback(describeSyncOutcome(outcome));
    if (outcome.failed > 0 || outcome.blocked > 0) {
      // Leave nothing preselected: blocked entries should not be one-click
      // retried, and the user should review what went wrong.
      setSelectedOutboxIds(new Set());
      setShowOutbox(true);
    }
  }

  function queueComment(event: FormEvent) {
    event.preventDefault();
    const body = commentDraft.trim();
    if (!body || !selectedItem) {
      return;
    }

    const id = createOperationId("comment");
    const operation = createCommentOutboxOperation({
      id,
      host: selectedItem.frontMatter.host,
      owner: selectedItem.frontMatter.owner,
      repo: selectedItem.frontMatter.repo,
      itemKind: selectedItem.frontMatter.kind,
      number: selectedItem.frontMatter.number,
      localFilePath: commentFilePath(vaultRoot, {
        kind: selectedItem.frontMatter.kind,
        host: selectedItem.frontMatter.host,
        owner: selectedItem.frontMatter.owner,
        repo: selectedItem.frontMatter.repo,
        number: selectedItem.frontMatter.number,
        created_at: new Date().toISOString(),
        local_id: id
      }),
      createdAt: new Date().toISOString(),
      vaultRoot
    });
    const comment: CommentDocument = {
      path: operation.frontMatter.local_file_path,
      body,
      frontMatter: {
        kind: "issue_comment",
        author: "local",
        created_at: operation.frontMatter.created_at,
        updated_at: operation.frontMatter.created_at,
        sync: { status: "pending" }
      }
    };
    const queuedOperation = { ...operation, body };

    void persistCommentDocument(vaultRoot, comment);
    void persistOutboxOperation(vaultRoot, queuedOperation);
    setOutbox((current) => [...current, queuedOperation]);
    setCommentDraft("");
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
      setAppSnackbar(`Reset failed: ${message}`);
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
    <main className="app-shell" aria-label="Yonalist layout" style={layoutStyle}>
      <TitleBar />
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
        outboxCount={outbox.length}
        settingsOpen={showSettings}
        onOpenSettings={openSettings}
        onOpenProjectSettings={() => openSettings("projects")}
        onOpenOutbox={openOutbox}
        notificationsOpen={showNotifications}
        onOpenNotifications={openNotifications}
        unreadNotificationCount={
          // Until the repository filter basis has loaded, the raw unread
          // count would flash (e.g. 300 → 15); hold the badge back instead.
          repositoryGroups.loaded ? notifications.unreadCount : 0
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
          query={query}
          loading={workItems.loading}
          error={workItems.error}
          demoMode={workItems.demoMode}
          onStateFilterChange={setItemStateFilter}
          onQueryChange={setQuery}
          onSelect={(path) => {
            setSelectedPath(path);
            setShowNewIssue(false);
            setShowSettings(false);
          }}
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
        <div className="detail-scroll">
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
            onOpenInBrowser={notifications.openNotification}
          />
        ) : (
          <ItemDetail
            item={selectedItem}
            thread={itemThread}
            online={online}
            commentDraft={commentDraft}
            onCommentDraftChange={setCommentDraft}
            onQueueComment={queueComment}
            onToggleFavorite={onToggleFavorite}
          />
        )}
        </div>
      </section>

      {showOutbox && (
        <OutboxModal
          outbox={outbox}
          selectedIds={selectedOutboxIds}
          online={online}
          syncing={syncing}
          remoteChangedIds={remoteChangedOutboxIds}
          onToggleSelection={toggleOutboxSelection}
          onSync={() => void syncSelectedOutbox()}
          onClose={() => setShowOutbox(false)}
        />
      )}
      {appSnackbar && (
        <div className="app-snackbar" role="status">
          {appSnackbar}
        </div>
      )}
    </main>
    </VaultRootContext.Provider>
    </MarkdownStyleContext.Provider>
    </GithubConnectionContext.Provider>
  );
}
