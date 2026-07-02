import {
  type CSSProperties,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { loadSettings, persistSettings, type AppSettings } from "./appSettings";
import { ItemDetail } from "./components/ItemDetail";
import { ItemListPane } from "./components/ItemListPane";
import { NewIssuePage, type DraftIssue } from "./components/NewIssuePage";
import { NotificationDetail } from "./components/NotificationDetail";
import { NotificationsPane } from "./components/NotificationsPane";
import { OutboxModal } from "./components/OutboxModal";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar, type ListFilter, type RepositoryEntry } from "./components/Sidebar";
import { toggleFavorite } from "./domain/favorites";
import {
  createCommentOutboxOperation,
  createIssueOutboxOperation
} from "./domain/outbox";
import { commentFilePath, draftIssuePath } from "./domain/paths";
import type { GitHubNotification } from "./domain/notifications";
import type { ItemDocument, OutboxOperationDocument } from "./domain/types";
import { sampleItems, SAMPLE_VAULT_ROOT } from "./fixtures/sampleItems";
import { useGithubAuth } from "./hooks/useGithubAuth";
import { useGithubServers } from "./hooks/useGithubServers";
import { useNotificationDetail } from "./hooks/useNotificationDetail";
import { useNotifications } from "./hooks/useNotifications";
import { paneWidthLimits, usePaneResize } from "./hooks/usePaneResize";
import { useOnlineStatus } from "./hooks/useOnlineStatus";
import { useTheme } from "./hooks/useTheme";
import { createGitHubClient } from "./services/github";
import { syncOutboxOperations } from "./services/sync";

interface AppProps {
  initialOnline?: boolean;
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
    default:
      return true;
  }
}

export default function App({ initialOnline }: AppProps) {
  const { online, toggleOnline } = useOnlineStatus(initialOnline);
  const [items, setItems] = useState(sampleItems);
  const [selectedPath, setSelectedPath] = useState<string | null>(
    sampleItems[0]?.path ?? null
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ListFilter>("all");
  const [repositoryFilter, setRepositoryFilter] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [outbox, setOutbox] = useState<OutboxOperationDocument[]>([]);
  const [selectedOutboxIds, setSelectedOutboxIds] = useState<Set<string>>(new Set());
  const [showOutbox, setShowOutbox] = useState(false);
  const [showNewIssue, setShowNewIssue] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [settingsStatus, setSettingsStatus] = useState("");
  const { paneWidths, startResize, resizeWithKeyboard } = usePaneResize();
  const servers = useGithubServers();
  const auth = useGithubAuth(servers);
  const notifications = useNotifications(auth.connection, online, showNotifications);
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

  const selectedItem =
    items.find((item) => item.path === selectedPath) ?? items[0];

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
      pulls: items.filter((item) => item.frontMatter.kind === "pull").length
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
    setItems((current) =>
      current.map((item) =>
        item.path === selectedItem.path ? toggleFavorite(item) : item
      )
    );
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

    setItems((current) => [newItem, ...current]);
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

  return (
    <main className="app-shell" aria-label="Yonalist layout" style={layoutStyle}>
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
        onRepositoryFilterChange={setRepositoryFilter}
        repositories={repositories}
        counts={filterCounts}
        settingsOpen={showSettings}
        onOpenSettings={openSettings}
        notificationsOpen={showNotifications}
        onOpenNotifications={openNotifications}
        unreadNotificationCount={notifications.unreadCount}
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

      {showNotifications ? (
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
          onQueryChange={setQuery}
          onSelect={(path) => {
            setSelectedPath(path);
            setShowNewIssue(false);
            setShowSettings(false);
          }}
          onNewIssue={openNewIssue}
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
        {showSettings ? (
          <SettingsPage
            settings={settings}
            status={settingsStatus}
            themeMode={themeMode}
            onThemeModeChange={setThemeMode}
            servers={servers}
            auth={auth}
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
            online={online}
            outboxCount={outbox.length}
            commentDraft={commentDraft}
            onCommentDraftChange={setCommentDraft}
            onQueueComment={queueComment}
            onToggleFavorite={onToggleFavorite}
            onOpenOutbox={openOutbox}
          />
        )}
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
  );
}
