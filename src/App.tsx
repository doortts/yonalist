import MarkdownIt from "markdown-it";
import {
  Bookmark,
  CheckCircle2,
  CircleDot,
  Folder,
  GitPullRequest,
  HardDrive,
  Inbox,
  KeyRound,
  MessageSquare,
  Moon,
  Plus,
  Search,
  Send,
  Settings,
  Wifi,
  WifiOff,
  X
} from "lucide-react";
import { FormEvent, PointerEvent, useMemo, useState } from "react";
import { toggleFavorite } from "./domain/favorites";
import { createCommentOutboxOperation, createIssueOutboxOperation } from "./domain/outbox";
import type { ItemDocument, OutboxOperationDocument } from "./domain/types";
import { startNativeWindowDrag } from "./windowDrag";

interface AppProps {
  initialOnline?: boolean;
}

interface DraftIssue {
  title: string;
  body: string;
}

interface AppSettings {
  hostName: string;
  webBaseUrl: string;
  apiBaseUrl: string;
  oauthClientId: string;
  oauthScopes: string;
  vaultFolder: string;
  syncQueuedOnReconnect: boolean;
  cacheLinkedAttachments: boolean;
  downloadCommentsWhileSyncing: boolean;
}

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
});

const now = "2026-07-02T12:00:00Z";

const initialSettings: AppSettings = {
  hostName: "github.com",
  webBaseUrl: "https://github.com",
  apiBaseUrl: "https://api.github.com",
  oauthClientId: "",
  oauthScopes: "repo",
  vaultFolder: "~/Yonalist",
  syncQueuedOnReconnect: true,
  cacheLinkedAttachments: true,
  downloadCommentsWhileSyncing: true
};

const settingsStorageKey = "yonalist.settings.v1";

function loadSettings(): AppSettings {
  try {
    const stored = window.localStorage.getItem(settingsStorageKey);
    if (!stored) {
      return initialSettings;
    }

    return {
      ...initialSettings,
      ...(JSON.parse(stored) as Partial<AppSettings>)
    };
  } catch {
    return initialSettings;
  }
}

function persistSettings(settings: AppSettings) {
  try {
    window.localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
  } catch {
    // Settings remain editable even if the browser storage is unavailable.
  }
}

const initialItems: ItemDocument[] = [
  {
    path: "/vault/github.com/Yona-projects/Home/issues/42/issue.md",
    body:
      "Offline-first reading keeps GitHub work available on a laptop even when the network disappears.\n\n- cache markdown\n- preserve local favorite metadata\n- sync queued replies later",
    frontMatter: {
      kind: "issue",
      host: "github.com",
      owner: "Yona-projects",
      repo: "Home",
      number: 42,
      node_id: "I_42",
      html_url: "https://github.com/Yona-projects/Home/issues/42",
      title: "Design offline issue reading",
      state: "open",
      author: "doortts",
      labels: ["offline", "sync"],
      created_at: "2026-07-01T10:00:00Z",
      updated_at: "2026-07-02T09:00:00Z",
      synced_at: now,
      local: { favorite: true },
      sync: { status: "synced" }
    }
  },
  {
    path: "/vault/github.com/doortts/blog/pulls/17/pull.md",
    body:
      "This pull request is available for offline review as a conversation thread. Line review is reserved for a later release.",
    frontMatter: {
      kind: "pull",
      host: "github.com",
      owner: "doortts",
      repo: "blog",
      number: 17,
      node_id: "PR_17",
      html_url: "https://github.com/doortts/blog/pull/17",
      title: "Refresh publishing notes",
      state: "open",
      author: "mona",
      labels: ["docs"],
      created_at: "2026-06-30T10:00:00Z",
      updated_at: "2026-07-01T12:00:00Z",
      synced_at: now,
      local: { favorite: false },
      sync: { status: "synced" }
    }
  }
];

function itemTypeLabel(item: ItemDocument): string {
  return item.frontMatter.kind === "pull" ? "PR" : "Issue";
}

function renderMarkdown(body: string) {
  return { __html: markdown.render(body) };
}

function createOperationId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}

export default function App({ initialOnline = true }: AppProps) {
  const [online, setOnline] = useState(initialOnline);
  const [items, setItems] = useState(initialItems);
  const [selectedPath, setSelectedPath] = useState(initialItems[0].path);
  const [query, setQuery] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const [outbox, setOutbox] = useState<OutboxOperationDocument[]>([]);
  const [selectedOutboxIds, setSelectedOutboxIds] = useState<Set<string>>(
    new Set()
  );
  const [showOutbox, setShowOutbox] = useState(false);
  const [showNewIssue, setShowNewIssue] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [settingsStatus, setSettingsStatus] = useState("");
  const [draftIssue, setDraftIssue] = useState<DraftIssue>({
    title: "",
    body: ""
  });

  const selectedItem = items.find((item) => item.path === selectedPath) ?? items[0];

  const repositories = useMemo(() => {
    const counts = new Map<string, { owner: string; repo: string; count: number }>();
    for (const item of items) {
      const key = `${item.frontMatter.owner}/${item.frontMatter.repo}`;
      const current = counts.get(key) ?? {
        owner: item.frontMatter.owner,
        repo: item.frontMatter.repo,
        count: 0
      };
      current.count += 1;
      counts.set(key, current);
    }
    return [...counts.entries()].map(([key, value]) => ({ key, ...value }));
  }, [items]);

  const filteredItems = items.filter((item) => {
    const haystack = `${item.frontMatter.title} ${item.frontMatter.owner} ${item.frontMatter.repo} ${item.frontMatter.labels.join(" ")}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  });

  function onToggleFavorite() {
    setItems((current) =>
      current.map((item) =>
        item.path === selectedItem.path ? toggleFavorite(item) : item
      )
    );
  }

  function outboxIds(operations = outbox): Set<string> {
    return new Set(operations.map((operation) => operation.frontMatter.id));
  }

  function openOutbox() {
    setSelectedOutboxIds(outboxIds());
    setShowOutbox(true);
  }

  function openSettings() {
    setShowNewIssue(false);
    setShowSettings(true);
    setSettingsStatus("");
  }

  function toggleOnline() {
    setOnline((current) => {
      const next = !current;
      if (next && outbox.length > 0) {
        setSelectedOutboxIds(outboxIds());
        setShowOutbox(true);
      }
      return next;
    });
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

  function syncSelectedOutbox() {
    setOutbox((current) =>
      current.filter((operation) => !selectedOutboxIds.has(operation.frontMatter.id))
    );
    setSelectedOutboxIds(new Set());
    setShowOutbox(false);
  }

  function handleWindowDragStart(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    void startNativeWindowDrag();
  }

  function queueComment(event: FormEvent) {
    event.preventDefault();
    const body = commentDraft.trim();
    if (!body) {
      return;
    }

    const operation = createCommentOutboxOperation({
      id: createOperationId("comment"),
      host: selectedItem.frontMatter.host,
      owner: selectedItem.frontMatter.owner,
      repo: selectedItem.frontMatter.repo,
      itemKind: selectedItem.frontMatter.kind,
      number: selectedItem.frontMatter.number,
      localFilePath: `${selectedItem.path.replace(/\/[^/]+$/, "")}/comments/_drafts/${Date.now()}.md`,
      createdAt: new Date().toISOString()
    });

    setOutbox((current) => [
      ...current,
      {
        ...operation,
        body
      }
    ]);
    setCommentDraft("");
  }

  function queueIssue(event: FormEvent) {
    event.preventDefault();
    if (!draftIssue.title.trim()) {
      return;
    }

    const localId = createOperationId("issue");
    const draftPath = `/vault/github.com/Yona-projects/Home/issues/_drafts/${localId}/issue.md`;
    const newItem: ItemDocument = {
      path: draftPath,
      body: draftIssue.body,
      frontMatter: {
        kind: "issue",
        host: "github.com",
        owner: "Yona-projects",
        repo: "Home",
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
      host: newItem.frontMatter.host,
      owner: newItem.frontMatter.owner,
      repo: newItem.frontMatter.repo,
      localFilePath: draftPath,
      createdAt: new Date().toISOString()
    });

    setItems((current) => [newItem, ...current]);
    setSelectedPath(draftPath);
    setOutbox((current) => [...current, operation]);
    setDraftIssue({ title: "", body: "" });
    setShowNewIssue(false);
    setShowSettings(false);
  }

  function updateSetting<K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K]
  ) {
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

  function connectGitHub() {
    if (!settings.oauthClientId.trim()) {
      setSettingsStatus("OAuth client ID is required");
      return;
    }

    setSettingsStatus(`OAuth Device Flow ready for ${settings.hostName}`);
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Navigation">
        <div
          className="window-drag-region"
          data-tauri-drag-region
          aria-label="Window drag region"
          onPointerDown={handleWindowDragStart}
        />
        <div className="brand-row">
          <div>
            <p className="eyebrow">Yonalist</p>
            <h1>GitHub Inbox</h1>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label={online ? "Go offline" : "Go online"}
            onClick={toggleOnline}
          >
            {online ? <Wifi size={18} /> : <WifiOff size={18} />}
          </button>
        </div>

        {!online && <span className="offline-badge">Offline</span>}

        <section className="nav-section">
          <h2>Issues</h2>
          <button className="nav-item active" type="button">
            <CircleDot size={16} />
            Assigned
          </button>
          <button className="nav-item" type="button">
            <MessageSquare size={16} />
            Created
          </button>
          <button className="nav-item" type="button">
            <Inbox size={16} />
            Mentioned
          </button>
        </section>

        <section className="nav-section">
          <h2>Notes</h2>
          <button className="nav-item" type="button">
            <Moon size={16} />
            Personal
          </button>
        </section>

        <section className="nav-section">
          <h2>Projects</h2>
          {repositories.map((repository) => (
            <button className="nav-item" type="button" key={repository.key}>
              <Folder size={16} />
              <span>{repository.owner}</span>
              <strong>{repository.repo}</strong>
            </button>
          ))}
        </section>

        <section className="nav-section">
          <h2>App</h2>
          <button
            className={showSettings ? "nav-item active" : "nav-item"}
            type="button"
            onClick={openSettings}
          >
            <Settings size={16} />
            Settings
          </button>
        </section>
      </aside>

      <section className="list-pane" aria-label="Items">
        <div className="search-row">
          <Search size={18} />
          <input
            aria-label="Search"
            placeholder="Search..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setShowSettings(false);
              setShowNewIssue(true);
            }}
          >
            <Plus size={17} />
            New issue
          </button>
        </div>

        <div className="item-list">
          {filteredItems.map((item) => (
            <button
              type="button"
              className={item.path === selectedPath ? "item-card selected" : "item-card"}
              key={item.path}
              onClick={() => {
                setSelectedPath(item.path);
                setShowNewIssue(false);
                setShowSettings(false);
              }}
            >
              <span className="item-meta">
                {item.frontMatter.kind === "pull" ? (
                  <GitPullRequest size={15} />
                ) : (
                  <CircleDot size={15} />
                )}
                {itemTypeLabel(item)} #{item.frontMatter.number || "draft"}
              </span>
              <span className="item-title">{item.frontMatter.title}</span>
              <span className="item-footer">
                {item.frontMatter.owner}/{item.frontMatter.repo}
                {item.frontMatter.local.favorite && (
                  <Bookmark className="small-bookmark" size={14} fill="currentColor" />
                )}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="detail-pane" aria-label="Detail">
        {showSettings ? (
          <form
            className="settings-page"
            aria-label="Settings page"
            onSubmit={saveSettings}
          >
            <header className="settings-header">
              <div>
                <p className="eyebrow">Preferences</p>
                <h2>Settings</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close settings"
                onClick={() => setShowSettings(false)}
              >
                <X size={18} />
              </button>
            </header>

            <div className="settings-body">
              <section className="settings-section">
                <div className="settings-section-title">
                  <KeyRound size={18} />
                  <h3>GitHub connection</h3>
                </div>
                <div className="settings-grid">
                  <label>
                    Host name
                    <input
                      aria-label="Host name"
                      value={settings.hostName}
                      onChange={(event) =>
                        updateSetting("hostName", event.target.value)
                      }
                    />
                  </label>
                  <label>
                    Web base URL
                    <input
                      aria-label="Web base URL"
                      value={settings.webBaseUrl}
                      onChange={(event) =>
                        updateSetting("webBaseUrl", event.target.value)
                      }
                    />
                  </label>
                  <label>
                    API base URL
                    <input
                      aria-label="API base URL"
                      value={settings.apiBaseUrl}
                      onChange={(event) =>
                        updateSetting("apiBaseUrl", event.target.value)
                      }
                    />
                  </label>
                  <label>
                    OAuth client ID
                    <input
                      aria-label="OAuth client ID"
                      value={settings.oauthClientId}
                      onChange={(event) =>
                        updateSetting("oauthClientId", event.target.value)
                      }
                    />
                  </label>
                  <label className="settings-grid-wide">
                    OAuth scopes
                    <input
                      aria-label="OAuth scopes"
                      value={settings.oauthScopes}
                      onChange={(event) =>
                        updateSetting("oauthScopes", event.target.value)
                      }
                    />
                  </label>
                </div>
                <button
                  className="secondary-button settings-inline-action"
                  type="button"
                  onClick={connectGitHub}
                >
                  <KeyRound size={16} />
                  Connect GitHub
                </button>
              </section>

              <section className="settings-section">
                <div className="settings-section-title">
                  <HardDrive size={18} />
                  <h3>Vault and sync</h3>
                </div>
                <label>
                  Vault folder
                  <input
                    aria-label="Vault folder"
                    value={settings.vaultFolder}
                    onChange={(event) =>
                      updateSetting("vaultFolder", event.target.value)
                    }
                  />
                </label>
                <div className="settings-checks">
                  <label className="settings-check">
                    <input
                      aria-label="Sync queued changes when online"
                      type="checkbox"
                      checked={settings.syncQueuedOnReconnect}
                      onChange={(event) =>
                        updateSetting(
                          "syncQueuedOnReconnect",
                          event.target.checked
                        )
                      }
                    />
                    <span>Sync queued changes when online</span>
                  </label>
                  <label className="settings-check">
                    <input
                      aria-label="Cache linked attachments"
                      type="checkbox"
                      checked={settings.cacheLinkedAttachments}
                      onChange={(event) =>
                        updateSetting(
                          "cacheLinkedAttachments",
                          event.target.checked
                        )
                      }
                    />
                    <span>Cache linked attachments</span>
                  </label>
                  <label className="settings-check">
                    <input
                      aria-label="Download comments while syncing"
                      type="checkbox"
                      checked={settings.downloadCommentsWhileSyncing}
                      onChange={(event) =>
                        updateSetting(
                          "downloadCommentsWhileSyncing",
                          event.target.checked
                        )
                      }
                    />
                    <span>Download comments while syncing</span>
                  </label>
                </div>
              </section>
            </div>

            <footer className="settings-actions">
              <span>{settingsStatus}</span>
              <button className="primary-button" type="submit">
                <CheckCircle2 size={16} />
                Save settings
              </button>
            </footer>
          </form>
        ) : showNewIssue ? (
          <form
            className="issue-create-page"
            aria-label="New issue composer"
            onSubmit={queueIssue}
          >
            <header className="issue-create-header">
              <div>
                <p className="eyebrow">Yona-projects/Home</p>
                <h2>New issue</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close new issue"
                onClick={() => setShowNewIssue(false)}
              >
                <X size={18} />
              </button>
            </header>

            <div className="issue-create-body">
              <label className="issue-title-field">
                <span>Issue title</span>
                <input
                  aria-label="Issue title"
                  placeholder="Title"
                  value={draftIssue.title}
                  onChange={(event) =>
                    setDraftIssue((current) => ({
                      ...current,
                      title: event.target.value
                    }))
                  }
                />
              </label>
              <label className="issue-body-field">
                <span>Issue body</span>
                <textarea
                  aria-label="Issue body"
                  placeholder="Write the issue in Markdown..."
                  value={draftIssue.body}
                  onChange={(event) =>
                    setDraftIssue((current) => ({
                      ...current,
                      body: event.target.value
                    }))
                  }
                />
              </label>
            </div>

            <footer className="issue-create-actions">
              <span>
                {online
                  ? "This issue will be queued locally before syncing."
                  : "Offline issue will wait in the outbox."}
              </span>
              <button className="primary-button" type="submit">
                <Send size={16} />
                Queue issue
              </button>
            </footer>
          </form>
        ) : (
          <>
            <header className="detail-header">
              <div className="bookmark-strip">
                <button
                  type="button"
                  className={
                    selectedItem.frontMatter.local.favorite
                      ? "favorite-button active"
                      : "favorite-button"
                  }
                  aria-label="Toggle favorite"
                  aria-pressed={selectedItem.frontMatter.local.favorite}
                  onClick={onToggleFavorite}
                >
                  <Bookmark size={25} fill="currentColor" />
                </button>
                <span className="number-ribbon">#</span>
              </div>
              <div className="detail-title-row">
                <div>
                  <p className="eyebrow">
                    {selectedItem.frontMatter.owner}/{selectedItem.frontMatter.repo}
                  </p>
                  <h2>{selectedItem.frontMatter.title}</h2>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={openOutbox}
                >
                  <Inbox size={16} />
                  Outbox {outbox.length}
                </button>
              </div>
              <div className="detail-actions">
                <span>{selectedItem.frontMatter.labels.join(", ") || "No labels"}</span>
                <span>{selectedItem.frontMatter.sync.status}</span>
                <span>{online ? "Online" : "Offline queue enabled"}</span>
              </div>
            </header>

            <article className="content-panel">
              <div className="author-row">
                <span className="avatar">{selectedItem.frontMatter.author.slice(0, 1).toUpperCase()}</span>
                <div>
                  <strong>{selectedItem.frontMatter.author}</strong>
                  <p>{itemTypeLabel(selectedItem)} conversation</p>
                </div>
              </div>
              <div
                className="markdown-body"
                dangerouslySetInnerHTML={renderMarkdown(selectedItem.body || "No body.")}
              />
            </article>

            <form className="comment-composer" onSubmit={queueComment}>
              <label htmlFor="comment-draft">Write a comment</label>
              <textarea
                id="comment-draft"
                aria-label="Write a comment"
                placeholder="Write a comment..."
                value={commentDraft}
                onChange={(event) => setCommentDraft(event.target.value)}
              />
              <div className="composer-actions">
                <span>
                  {online
                    ? "Comments are queued first, then synced."
                    : "Offline comment will wait in the outbox."}
                </span>
                <button className="primary-button" type="submit">
                  <Send size={16} />
                  Queue comment
                </button>
              </div>
            </form>
          </>
        )}
      </section>

      {showOutbox && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-label="Outbox">
            <div className="modal-header">
              <div>
                <p className="eyebrow">Pending sync</p>
                <h2>Outbox</h2>
                {outbox.length > 0 && (
                  <p className="modal-copy">Choose queued changes to sync.</p>
                )}
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close outbox"
                onClick={() => setShowOutbox(false)}
              >
                <X size={18} />
              </button>
            </div>
            {outbox.length === 0 ? (
              <p className="empty-copy">No queued changes.</p>
            ) : (
              <>
                <div className="outbox-list">
                  {outbox.map((operation) => (
                    <article className="outbox-card" key={operation.frontMatter.id}>
                      <input
                        aria-label={`Select ${operation.frontMatter.operation}`}
                        type="checkbox"
                        checked={selectedOutboxIds.has(operation.frontMatter.id)}
                        onChange={() => toggleOutboxSelection(operation.frontMatter.id)}
                      />
                      <div>
                        <strong>{operation.frontMatter.operation.replace("_", " ")}</strong>
                        <p>{operation.body || operation.frontMatter.local_file_path}</p>
                      </div>
                    </article>
                  ))}
                </div>
                <div className="modal-actions">
                  <span>
                    {online
                      ? "Selected changes will be sent to GitHub."
                      : "Go online before syncing selected changes."}
                  </span>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={!online || selectedOutboxIds.size === 0}
                    onClick={syncSelectedOutbox}
                  >
                    <CheckCircle2 size={16} />
                    Sync selected
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
