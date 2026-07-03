import {
  type CSSProperties,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { loadSettings, persistSettings, type AppSettings } from "./appSettings";
import { GithubConnectionContext } from "./GithubConnectionContext";
import { ItemDetail } from "./components/ItemDetail";
import { ItemListPane } from "./components/ItemListPane";
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
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar, type ListFilter } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { toggleFavorite } from "./domain/favorites";
import {
  createCommentOutboxOperation,
  createIssueOutboxOperation
} from "./domain/outbox";
import { commentFilePath, draftIssuePath } from "./domain/paths";
import type { GitHubNotification } from "./domain/notifications";
import type { ItemDocument, OutboxOperationDocument } from "./domain/types";
import { SAMPLE_VAULT_ROOT } from "./fixtures/sampleItems";
import { useGithubAuth } from "./hooks/useGithubAuth";
import { useGithubServers } from "./hooks/useGithubServers";
import { useItemThread } from "./hooks/useItemThread";
import { useNotificationDetail } from "./hooks/useNotificationDetail";
import { useNotifications } from "./hooks/useNotifications";
import { useProjectVisibility } from "./hooks/useProjectVisibility";
import { useRepositories } from "./hooks/useRepositories";
import { useWorkItems, type WorkScope } from "./hooks/useWorkItems";
import { paneWidthLimits, usePaneResize } from "./hooks/usePaneResize";
import { useOnlineStatus } from "./hooks/useOnlineStatus";
import { useScrollbarHover } from "./hooks/useScrollbarHover";
import { useTheme } from "./hooks/useTheme";
import {
  loadLastAuthenticatedUrl,
  loadSkipLogin,
  persistLastAuthenticatedUrl,
  persistSkipLogin,
  validateConnection
} from "./services/authGate";
import { createGitHubClient } from "./services/github";
import { syncOutboxOperations } from "./services/sync";

interface AppProps {
  initialOnline?: boolean;
}

type AuthGateState = "checking" | "required" | "passed";

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

export default function App({ initialOnline }: AppProps) {
  useScrollbarHover();
  const { online, toggleOnline } = useOnlineStatus(initialOnline);
  const [drafts, setDrafts] = useState<ItemDocument[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ListFilter>("all");
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
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [settingsStatus, setSettingsStatus] = useState("");
  const { paneWidths, startResize, resizeWithKeyboard } = usePaneResize();
  const servers = useGithubServers();
  const auth = useGithubAuth(servers);

  // Startup gate: assume the last authenticated host, verify its stored
  // credentials, and fall back to the login page when that fails (or on the
  // very first run). Skipping is remembered so demo mode stays reachable.
  const [authGate, setAuthGate] = useState<AuthGateState>(() =>
    loadSkipLogin() ? "passed" : "checking"
  );
  const gateStarted = useRef(false);
  useEffect(() => {
    if (authGate !== "checking" || gateStarted.current) {
      return;
    }
    gateStarted.current = true;

    const lastAuthenticated = loadLastAuthenticatedUrl();
    if (
      lastAuthenticated &&
      lastAuthenticated !== servers.selectedUrl &&
      servers.urls.includes(lastAuthenticated)
    ) {
      servers.select(lastAuthenticated);
    }

    const url = lastAuthenticated ?? servers.selectedUrl;
    const token = servers.tokenOf(url);
    if (!token) {
      setAuthGate("required");
      return;
    }
    if (!online) {
      // Offline-first: trust the stored token until the network returns.
      setAuthGate("passed");
      return;
    }
    void validateConnection({
      apiBaseUrl: url,
      webBaseUrl: auth.connection.webBaseUrl,
      token
    }).then((ok) => {
      if (ok) {
        persistLastAuthenticatedUrl(url);
      }
      setAuthGate(ok ? "passed" : "required");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authGate]);

  // On the login page, credentials open the app only after they verify
  // against the server, so a stale token cannot slip through.
  const gateValidating = useRef(false);
  const [gateError, setGateError] = useState<string | null>(null);
  useEffect(() => {
    if (authGate !== "required" || !auth.signedIn || gateValidating.current) {
      return;
    }
    if (!online) {
      persistLastAuthenticatedUrl(servers.selectedUrl);
      setAuthGate("passed");
      return;
    }
    gateValidating.current = true;
    void validateConnection(auth.connection).then((ok) => {
      gateValidating.current = false;
      if (ok) {
        persistLastAuthenticatedUrl(servers.selectedUrl);
        setGateError(null);
        setAuthGate("passed");
      } else {
        setGateError(
          "인증에 실패했습니다. 토큰을 확인하거나 다른 서버로 로그인하세요."
        );
      }
    });
  }, [authGate, auth.signedIn, auth.connection, online, servers.selectedUrl]);

  function skipLogin() {
    persistSkipLogin(true);
    setAuthGate("passed");
  }
  const workScope = useMemo<WorkScope>(() => {
    if (repositoryFilter) {
      const [owner, ...rest] = repositoryFilter.split("/");
      return { type: "repo", owner, name: rest.join("/") };
    }
    return { type: "inbox" };
  }, [repositoryFilter]);
  const workItems = useWorkItems(auth.connection, online, workScope);
  const items = useMemo(
    () => [...drafts, ...workItems.items],
    [drafts, workItems.items]
  );
  const repositoryGroups = useRepositories(auth.connection, online, workItems.items);
  // Repos where the user's involves:@me inbox has activity count as
  // "participating" for default project visibility.
  const [involvedRepoNames, setInvolvedRepoNames] = useState<Set<string>>(
    () => new Set()
  );
  const [involvementReady, setInvolvementReady] = useState(false);
  useEffect(() => {
    if (workScope.type === "inbox" && !workItems.demoMode && workItems.items.length > 0) {
      setInvolvedRepoNames(
        new Set(
          workItems.items.map(
            (item) => `${item.frontMatter.owner}/${item.frontMatter.repo}`
          )
        )
      );
      setInvolvementReady(true);
    }
  }, [workScope, workItems.demoMode, workItems.items]);
  const projectVisibility = useProjectVisibility(
    repositoryGroups.groups,
    involvedRepoNames,
    involvementReady && !repositoryGroups.loading
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
  const notifications = useNotifications(
    auth.connection,
    online,
    authGate === "passed",
    notificationRepoFilter
  );
  const [selectedNotification, setSelectedNotification] =
    useState<GitHubNotification | null>(null);
  const notificationDetail = useNotificationDetail(
    selectedNotification,
    auth.connection,
    online
  );
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
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
      all: items.length,
      favorites: items.filter((item) => item.frontMatter.local.favorite).length,
      issues: items.filter((item) => item.frontMatter.kind === "issue").length,
      pulls: items.filter((item) => item.frontMatter.kind === "pull").length,
      discussions: items.filter((item) => item.frontMatter.kind === "discussion")
        .length
    }),
    [items]
  );

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return items.filter((item) => {
      if (!matchesFilter(item, filter)) {
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
  }, [items, filter, repositoryFilter, query]);

  const selectedItem =
    filteredItems.find((item) => item.path === selectedPath) ?? filteredItems[0];

  const detailVisible =
    authGate === "passed" && !showSettings && !showNewIssue && !showNotifications;
  const itemThread = useItemThread(
    detailVisible ? selectedItem ?? null : null,
    auth.connection,
    online
  );

  const layoutStyle = {
    "--sidebar-width": `${paneWidths.sidebar}px`,
    "--list-width": `${paneWidths.list}px`
  } as CSSProperties;

  // Reopening the outbox review when connectivity returns (browser event or
  // manual toggle) so queued work is never silently forgotten.
  const previousOnline = useRef(online);
  useEffect(() => {
    if (
      online &&
      !previousOnline.current &&
      settings.syncQueuedOnReconnect &&
      outbox.length > 0
    ) {
      setSelectedOutboxIds(new Set(outbox.map((operation) => operation.frontMatter.id)));
      setShowOutbox(true);
    }
    previousOnline.current = online;
  }, [online, outbox, settings.syncQueuedOnReconnect]);

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

  function openSettings() {
    setShowNewIssue(false);
    setShowNotifications(false);
    setShowSettings(true);
    setSettingsStatus("");
  }

  function openNotifications() {
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

  async function syncSelectedOutbox() {
    const selected = outbox.filter((operation) =>
      selectedOutboxIds.has(operation.frontMatter.id)
    );
    if (selected.length === 0) {
      return;
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
      return;
    }

    setSyncing(true);
    try {
      const client = createGitHubClient({
        token,
        apiBaseUrl: auth.connection.apiBaseUrl,
        webBaseUrl: auth.connection.webBaseUrl
      });
      const results = await syncOutboxOperations(client, selected, items);
      const syncedIds = new Set(
        results.filter((result) => result.ok).map((result) => result.operation.frontMatter.id)
      );
      const failures = new Map(
        results
          .filter((result) => !result.ok)
          .map((result) => [result.operation.frontMatter.id, result.error ?? "Sync failed."])
      );

      setOutbox((current) =>
        current
          .filter((operation) => !syncedIds.has(operation.frontMatter.id))
          .map((operation) =>
            failures.has(operation.frontMatter.id)
              ? {
                  ...operation,
                  frontMatter: {
                    ...operation.frontMatter,
                    status: "failed" as const,
                    last_error: failures.get(operation.frontMatter.id)
                  }
                }
              : operation
          )
      );
      setSelectedOutboxIds(new Set());
      if (failures.size === 0) {
        setShowOutbox(false);
      }
    } finally {
      setSyncing(false);
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
      localFilePath: commentFilePath(SAMPLE_VAULT_ROOT, {
        kind: selectedItem.frontMatter.kind,
        host: selectedItem.frontMatter.host,
        owner: selectedItem.frontMatter.owner,
        repo: selectedItem.frontMatter.repo,
        number: selectedItem.frontMatter.number,
        created_at: new Date().toISOString(),
        local_id: id
      }),
      createdAt: new Date().toISOString(),
      vaultRoot: SAMPLE_VAULT_ROOT
    });

    setOutbox((current) => [...current, { ...operation, body }]);
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
    const draftPath = draftIssuePath(SAMPLE_VAULT_ROOT, {
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
      vaultRoot: SAMPLE_VAULT_ROOT
    });

    setDrafts((current) => [newItem, ...current]);
    setSelectedPath(draftPath);
    setOutbox((current) => [...current, operation]);
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

  if (authGate !== "passed") {
    return (
      <LoginPage
        servers={servers}
        auth={auth}
        checking={authGate === "checking"}
        error={gateError}
        onSkip={skipLogin}
      />
    );
  }

  return (
    <GithubConnectionContext.Provider value={auth.connection}>
    <main className="app-shell" aria-label="Yonalist layout" style={layoutStyle}>
      <TitleBar />
      <Sidebar
        online={online}
        onToggleOnline={toggleOnline}
        filter={filter}
        onFilterChange={(next) => {
          setFilter(next);
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
        repositoryGroups={projectVisibility.visibleGroups}
        repositoriesLoading={repositoryGroups.loading}
        counts={filterCounts}
        settingsOpen={showSettings}
        onOpenSettings={openSettings}
        notificationsOpen={showNotifications}
        onOpenNotifications={openNotifications}
        unreadNotificationCount={
          // Until the repository filter basis has loaded, the raw unread
          // count would flash (e.g. 300 → 15); hold the badge back instead.
          repositoryGroups.loaded ? notifications.unreadCount : 0
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
          query={query}
          loading={workItems.loading}
          error={workItems.error}
          demoMode={workItems.demoMode}
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
          <SettingsPage
            section={settingsSection}
            settings={settings}
            status={settingsStatus}
            themeMode={themeMode}
            onThemeModeChange={setThemeMode}
            servers={servers}
            auth={auth}
            repositoryGroups={repositoryGroups.groups}
            projectVisibility={projectVisibility}
            onUpdate={updateSetting}
            onSave={saveSettings}
            onClose={() => setShowSettings(false)}
          />
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
            outboxCount={outbox.length}
            commentDraft={commentDraft}
            onCommentDraftChange={setCommentDraft}
            onQueueComment={queueComment}
            onToggleFavorite={onToggleFavorite}
            onOpenOutbox={openOutbox}
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
          onToggleSelection={toggleOutboxSelection}
          onSync={() => void syncSelectedOutbox()}
          onClose={() => setShowOutbox(false)}
        />
      )}
    </main>
    </GithubConnectionContext.Provider>
  );
}
