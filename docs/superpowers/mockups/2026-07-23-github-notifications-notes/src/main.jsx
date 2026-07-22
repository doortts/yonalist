import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Archive,
  Bell,
  ChevronDown,
  CircleDot,
  Clock3,
  Download,
  ExternalLink,
  FileText,
  GitPullRequest,
  Home,
  ListChecks,
  ListTree,
  Maximize2,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Search,
  SlidersHorizontal,
  Star,
  Tag,
  Tags,
  Trash2
} from "lucide-react";
import "./styles.css";

const groups = [
  {
    key: "2026.07.23",
    label: "Today",
    items: [
      {
        id: "102",
        icon: GitPullRequest,
        title: "[#44] 임베딩 게이트웨이 클라이언트 추가 #102",
        subtitle: "pi/arc-agent, 2h ago, seen 18m ago"
      },
      {
        id: "116",
        icon: CircleDot,
        title: "가드레일 위반 및 오류 시스템 메시지 처리 #116",
        subtitle: "pi/arc-agent, 5h ago"
      }
    ]
  },
  {
    key: "2026.07.22",
    label: "Yesterday",
    items: [
      {
        id: "121",
        icon: GitPullRequest,
        title: "[#45] 매뉴얼 검색 및 RAG 응답 구현 #121",
        subtitle: "arc-agent, 9h ago, seen 6h ago"
      },
      {
        id: "88",
        icon: MessageCircle,
        title: "코멘트 동기화 실패 시 재시도 안내 #88",
        subtitle: "yonalist, 21h ago"
      }
    ]
  },
  {
    key: "2026.07.21",
    label: "07.21",
    items: [
      {
        id: "36",
        icon: Tag,
        title: "v0.1.0 개발 빌드 준비",
        subtitle: "yonalist, 2d ago, seen 1d ago"
      }
    ]
  }
];

const initiallyReadNotifications = ["121", "36"];
const initialLocalNotes = [
  {
    id: "local-102-1",
    groupKey: "2026.07.23",
    afterNotificationId: "102",
    parentNotificationId: "102",
    title: "배포 전에 API 응답 형식 확인"
  }
];

function useStoredState(key, initialValue) {
  const [value, setValue] = useState(() => {
    try {
      const saved = window.localStorage.getItem(key);
      return saved === null ? initialValue : JSON.parse(saved);
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue];
}

function IconButton({ label, children, className = "", ...props }) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

function Sidebar({ view, onView }) {
  const pages = [
    { id: "start", label: "Yonalist Notes 시작하기", icon: FileText },
    { id: "github", label: "Github Notifications", icon: Bell },
    { id: "daily", label: "Daily", icon: FileText },
    { id: "idea", label: "이건 어때?", icon: FileText },
    { id: "today", label: "하루만", icon: FileText }
  ];

  return (
    <aside className="sidebar" aria-label="Notes navigation">
      <header className="sidebar-header">
        <h1>Notes</h1>
        <IconButton label="Notes 보기 설정" className="header-icon">
          <SlidersHorizontal size={16} />
        </IconButton>
      </header>

      <div className="discovery">
        <button type="button" className="new-page">
          <Plus size={17} />
          New page
        </button>

        <label className="search-field">
          <Search size={16} />
          <input aria-label="Search notes" placeholder="Search notes" />
        </label>

        <nav className="scope-list" aria-label="Notes scopes">
          <button
            type="button"
            className={view === "all" ? "scope active" : "scope"}
            aria-pressed={view === "all"}
            onClick={() => onView("all")}
          >
            <ListTree size={16} />
            <span>All</span>
          </button>
          <button type="button" className="scope">
            <Star size={16} />
            <span>Starred</span>
          </button>
          <button type="button" className="scope">
            <Clock3 size={16} />
            <span>Recent</span>
          </button>
          <button type="button" className="scope">
            <Tags size={16} />
            <span>Tags</span>
          </button>
          <button type="button" className="scope">
            <Archive size={16} />
            <span>Archive</span>
          </button>
          <button type="button" className="scope">
            <Trash2 size={16} />
            <span>Trash</span>
          </button>
        </nav>
      </div>

      <div className="page-list" role="list" aria-label="Top level Notes pages">
        {pages.map(({ id, label, icon: PageIcon }) => {
          const isGithub = id === "github";
          const active = isGithub && view === "github";
          return (
            <div
              className={active ? "page-row active" : "page-row"}
              data-plugin={isGithub || undefined}
              role="listitem"
              key={id}
            >
              <button
                type="button"
                className="page-button"
                onClick={() => isGithub && onView("github")}
              >
                <PageIcon size={16} />
                <span>{label}</span>
              </button>
              {!isGithub && (
                <button type="button" className="page-menu" aria-label={`${label} 메뉴`}>
                  <span aria-hidden="true">•••</span>
                </button>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function Toolbar({ onHome, showCompleted, onToggleCompleted }) {
  return (
    <div className="toolbar">
      <IconButton label="All로 이동" onClick={onHome}>
        <Home size={16} />
      </IconButton>
      <div className="toolbar-actions">
        <IconButton
          label="완료 항목 표시"
          aria-pressed={showCompleted}
          className={showCompleted ? "completed-filter active" : "completed-filter"}
          onClick={onToggleCompleted}
        >
          <ListChecks size={17} />
        </IconButton>
        <IconButton label="내보내기" disabled>
          <Download size={17} />
        </IconButton>
        <IconButton label="화면 확대">
          <Maximize2 size={17} />
        </IconButton>
      </div>
    </div>
  );
}

function OutlineRow({
  depth = 0,
  title,
  note,
  hasChildren = false,
  collapsed = false,
  onToggle,
  onOpen,
  typeIcon: TypeIcon,
  trailing,
  menu,
  titleControl,
  noteControl,
  emphasis = false,
  completed = false,
  pluginRoot = false,
  rowAttributes = {}
}) {
  return (
    <div
      className={`row-wrap${completed ? " completed" : ""}`}
      style={{ "--depth": depth }}
      data-plugin-root={pluginRoot || undefined}
      {...rowAttributes}
    >
      <div className="outline-row">
        <span className="menu-space">{menu}</span>
        <span className="arrow-space">
          {hasChildren && (
            <button
              type="button"
              className="collapse-button"
              aria-label={`${title} ${collapsed ? "펼치기" : "접기"}`}
              aria-expanded={!collapsed}
              onClick={onToggle}
            >
              <ChevronDown size={15} />
            </button>
          )}
        </span>
        {TypeIcon ? (
          <span className="type-icon" aria-label="GitHub notification type">
            <TypeIcon size={16} strokeWidth={1.8} />
          </span>
        ) : (
          <button
            type="button"
            className={`bullet-button${collapsed ? " collapsed" : ""}`}
            aria-label={`${title} 열기`}
            onClick={onOpen}
          >
            <span className="bullet-dot" />
          </button>
        )}
        <div className="title-column">
          <div className="title-line">
            {titleControl ?? (
              <button
                type="button"
                className={`row-title${emphasis ? " emphasis" : ""}`}
                onClick={onOpen}
              >
                {title}
              </button>
            )}
            {trailing && <div className="trailing-actions">{trailing}</div>}
          </div>
        </div>
      </div>
      {noteControl ?? (note && <p className="row-note">{note}</p>)}
    </div>
  );
}

function NotificationMenu({ item, read, onMarkRead }) {
  const [open, setOpen] = useState(false);

  return (
    <span className="row-menu">
      <button
        type="button"
        className="row-menu-trigger"
        aria-label={`${item.title} 메뉴`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <span className="row-menu-popover" role="menu">
          <button
            type="button"
            role="menuitem"
            disabled={read}
            onClick={() => {
              onMarkRead(item.id);
              setOpen(false);
            }}
          >
            <span>{read ? "Completed" : "Complete"}</span>
            <kbd>⌘↵</kbd>
          </button>
        </span>
      )}
    </span>
  );
}

function NotificationTitle({ item, onCreateSibling, onMarkRead }) {
  const [draftTitle, setDraftTitle] = useState(item.title);

  useEffect(() => setDraftTitle(item.title), [item.title]);

  const restore = () => setDraftTitle(item.title);
  return (
    <input
      className="row-title row-title-input"
      aria-label={`알림 제목: ${item.title}`}
      value={draftTitle}
      onChange={(event) => setDraftTitle(event.target.value)}
      onBlur={restore}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          restore();
          onMarkRead(item.id);
          return;
        }
        if (event.key === "Enter" && !event.altKey && !event.shiftKey) {
          event.preventDefault();
          restore();
          onCreateSibling(item);
          return;
        }
        if (event.key === "Escape") {
          restore();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function NotificationNote({ item, onMarkRead }) {
  const [draftNote, setDraftNote] = useState(item.subtitle);

  useEffect(() => setDraftNote(item.subtitle), [item.subtitle]);

  const restore = () => setDraftNote(item.subtitle);
  return (
    <input
      className="row-note row-note-input"
      aria-label={`알림 설명: ${item.subtitle}`}
      value={draftNote}
      onChange={(event) => setDraftNote(event.target.value)}
      onBlur={restore}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          restore();
          onMarkRead(item.id);
          return;
        }
        if (event.key === "Escape") {
          restore();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function NotificationRow({
  item,
  depth,
  read,
  hasChildren,
  collapsed,
  onToggle,
  onCreateSibling,
  onMarkRead,
  onOpenWeb,
  saved
}) {
  return (
    <OutlineRow
      depth={depth}
      title={item.title}
      note={item.subtitle}
      typeIcon={item.icon}
      completed={read}
      hasChildren={hasChildren}
      collapsed={collapsed}
      onToggle={onToggle}
      rowAttributes={{
        "data-notification-id": item.id,
        "data-saved-notification": saved ? "true" : undefined
      }}
      menu={<NotificationMenu item={item} read={read} onMarkRead={onMarkRead} />}
      titleControl={
        <NotificationTitle
          item={item}
          onCreateSibling={onCreateSibling}
          onMarkRead={onMarkRead}
        />
      }
      noteControl={<NotificationNote item={item} onMarkRead={onMarkRead} />}
      trailing={
        <IconButton
          label={`웹에서 열기: ${item.title}`}
          className="row-action web-action"
          onClick={() => onOpenWeb(item)}
        >
          <ExternalLink size={16} />
        </IconButton>
      }
    />
  );
}

function LocalNoteRow({ note, depth, pendingFocusId, onFocused, onChange }) {
  const inputRef = React.useRef(null);

  useEffect(() => {
    if (pendingFocusId !== note.id) return;
    inputRef.current?.focus();
    onFocused();
  }, [note.id, onFocused, pendingFocusId]);

  return (
    <OutlineRow
      depth={depth}
      title={note.title || "Untitled"}
      rowAttributes={{
        "data-local-note": note.id,
        "data-parent-notification-id": note.parentNotificationId ?? ""
      }}
      titleControl={
        <input
          ref={inputRef}
          className="row-title row-title-input local-note-input"
          aria-label={note.title ? `블릿 제목: ${note.title}` : "새 블릿"}
          placeholder="Type to write"
          value={note.title}
          onChange={(event) => onChange(note.id, { title: event.target.value })}
          onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            event.preventDefault();
            onChange(note.id, {
              parentNotificationId: event.shiftKey ? null : note.afterNotificationId
            });
          }}
        />
      }
    />
  );
}

function NotificationGroups({
  baseDepth = 1,
  collapsedDates,
  onToggleDate,
  collapsedNotifications,
  onToggleNotification,
  showCompleted,
  readNotificationIds,
  localNotes,
  savedNotificationIds,
  pendingFocusId,
  onFocused,
  onChangeLocalNote,
  onCreateSibling,
  onMarkRead,
  onOpenWeb
}) {
  return (
    <div className="notification-groups">
      {groups.map((group) => {
        const collapsed = collapsedDates.includes(group.key);
        const groupNotes = localNotes.filter((note) => note.groupKey === group.key);
        const hasVisibleNotification = group.items.some(
          (item) => showCompleted || !readNotificationIds.includes(item.id)
        );
        const hasVisibleSibling = groupNotes.some(
          (note) => note.parentNotificationId === null
        );
        if (!hasVisibleNotification && !hasVisibleSibling) return null;
        return (
          <section className="date-group" key={group.key} aria-label={group.label}>
            <OutlineRow
              depth={baseDepth}
              title={group.label}
              emphasis
              hasChildren
              collapsed={collapsed}
              onToggle={() => onToggleDate(group.key)}
            />
            {!collapsed && (
              <div className="date-children">
                {group.items.map((item) => {
                  const read = readNotificationIds.includes(item.id);
                  const visible = showCompleted || !read;
                  const relatedNotes = groupNotes.filter(
                    (note) => note.afterNotificationId === item.id
                  );
                  const children = relatedNotes.filter(
                    (note) => note.parentNotificationId === item.id
                  );
                  const siblings = relatedNotes.filter(
                    (note) => note.parentNotificationId === null
                  );
                  const notificationCollapsed = collapsedNotifications.includes(item.id);
                  return (
                    <React.Fragment key={item.id}>
                      {visible && (
                        <NotificationRow
                          item={item}
                          depth={baseDepth + 1}
                          read={read}
                          hasChildren={children.length > 0}
                          collapsed={notificationCollapsed}
                          onToggle={() => onToggleNotification(item.id)}
                          onCreateSibling={(target) => onCreateSibling(group.key, target)}
                          onMarkRead={onMarkRead}
                          onOpenWeb={onOpenWeb}
                          saved={savedNotificationIds.includes(item.id)}
                        />
                      )}
                      {visible && !notificationCollapsed &&
                        children.map((note) => (
                          <LocalNoteRow
                            key={note.id}
                            note={note}
                            depth={baseDepth + 2}
                            pendingFocusId={pendingFocusId}
                            onFocused={onFocused}
                            onChange={onChangeLocalNote}
                          />
                        ))}
                      {siblings.map((note) => (
                        <LocalNoteRow
                          key={note.id}
                          note={note}
                          depth={baseDepth + 1}
                          pendingFocusId={pendingFocusId}
                          onFocused={onFocused}
                          onChange={onChangeLocalNote}
                        />
                      ))}
                    </React.Fragment>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function GithubRoot({ collapsed, onToggle, onOpen, children }) {
  return (
    <section className="root-section plugin-section" aria-label="Github Notifications">
      <OutlineRow
        title="Github Notifications"
        hasChildren
        collapsed={collapsed}
        onToggle={onToggle}
        onOpen={onOpen}
        pluginRoot
      />
      {!collapsed && children}
    </section>
  );
}

function AllOutline(props) {
  return (
    <div className="outline-list" aria-label="All Notes">
      <section className="root-section">
        <OutlineRow
          title="Yonalist Notes 시작하기"
          hasChildren
          onToggle={() => undefined}
        />
        <OutlineRow depth={1} title="Enter로 새 항목 만들기" />
        <OutlineRow depth={1} title="Tab과 Shift+Tab으로 계층 바꾸기" />
      </section>

      <GithubRoot
        collapsed={props.rootCollapsed}
        onToggle={props.onToggleRoot}
        onOpen={props.onOpenGithub}
      >
        <NotificationGroups {...props} />
      </GithubRoot>

      <section className="root-section">
        <OutlineRow title="Daily" hasChildren onToggle={() => undefined} />
        <OutlineRow depth={1} title="2026-07-23" hasChildren onToggle={() => undefined} />
        <OutlineRow depth={2} title="오늘 구현할 것 정리" />
      </section>
      <OutlineRow title="이건 어때?" />
      <OutlineRow title="하루만" />
    </div>
  );
}

function GithubZoom(props) {
  return (
    <div className="zoom-page">
      <header className="zoom-heading">
        <span aria-hidden="true" />
        <h2>Github Notifications</h2>
      </header>
      <div className="zoom-children">
        <NotificationGroups {...props} baseDepth={0} />
      </div>
    </div>
  );
}

function App() {
  const [view, setView] = useState("all");
  const [rootCollapsed, setRootCollapsed] = useStoredState("yona-mock-root-collapsed", false);
  const [collapsedDates, setCollapsedDates] = useStoredState("yona-mock-collapsed-dates", []);
  const [collapsedNotifications, setCollapsedNotifications] = useStoredState(
    "yona-mock-collapsed-notifications",
    []
  );
  const [readNotificationIds, setReadNotificationIds] = useStoredState(
    "yona-mock-read-notifications",
    initiallyReadNotifications
  );
  const [savedNotificationIds, setSavedNotificationIds] = useStoredState(
    "yona-mock-saved-notifications",
    ["102"]
  );
  const [localNotes, setLocalNotes] = useStoredState("yona-mock-local-notes", initialLocalNotes);
  const [showCompleted, setShowCompleted] = useState(true);
  const [pendingFocusId, setPendingFocusId] = useState(null);
  const [toast, setToast] = useState("");
  const localNoteSequence = React.useRef(2);

  const shared = {
    collapsedDates,
    collapsedNotifications,
    showCompleted,
    readNotificationIds,
    savedNotificationIds,
    localNotes,
    pendingFocusId,
    onFocused: () => setPendingFocusId(null),
    onToggleDate(key) {
      setCollapsedDates((current) =>
        current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
      );
    },
    onToggleNotification(id) {
      setCollapsedNotifications((current) =>
        current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
      );
    },
    onMarkRead(id) {
      setReadNotificationIds((current) =>
        current.includes(id) ? current : [...current, id]
      );
    },
    onCreateSibling(groupKey, item) {
      const id = `local-${item.id}-${localNoteSequence.current}`;
      localNoteSequence.current += 1;
      setSavedNotificationIds((current) =>
        current.includes(item.id) ? current : [...current, item.id]
      );
      setLocalNotes((current) => [
        ...current,
        {
          id,
          groupKey,
          afterNotificationId: item.id,
          parentNotificationId: null,
          title: ""
        }
      ]);
      setPendingFocusId(id);
    },
    onChangeLocalNote(id, patch) {
      setLocalNotes((current) =>
        current.map((note) => (note.id === id ? { ...note, ...patch } : note))
      );
    },
    onOpenWeb(item) {
      setToast(`${item.title} 웹페이지 열기`);
    }
  };

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(""), 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <div className="prototype-shell">
      <div className="prototype-note" role="note">
        <strong>Interactive markup</strong>
        <span>알림 제목에서 Enter로 sibling을 만들고 Tab으로 들여써 보세요.</span>
      </div>
      <main className="app-window">
        <Sidebar view={view} onView={setView} />
        <section className="detail-pane">
          <Toolbar
            onHome={() => setView("all")}
            showCompleted={showCompleted}
            onToggleCompleted={() => setShowCompleted((current) => !current)}
          />
          <div className="outline-scroll">
            <div className="outline-content" data-zoomed={view === "github" || undefined}>
              {view === "github" ? (
                <GithubZoom {...shared} />
              ) : (
                <AllOutline
                  {...shared}
                  rootCollapsed={rootCollapsed}
                  onToggleRoot={() => setRootCollapsed((value) => !value)}
                  onOpenGithub={() => setView("github")}
                />
              )}
            </div>
          </div>
        </section>
      </main>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
