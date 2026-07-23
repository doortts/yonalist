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
  Lock,
  Maximize2,
  MessageCircle,
  MoreHorizontal,
  Plus,
  RotateCcw,
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
const pages = [
  { id: "start", label: "Yonalist Notes 시작하기", icon: FileText },
  { id: "github", label: "Github Notifications", icon: Bell },
  { id: "daily", label: "Daily", icon: FileText },
  { id: "idea", label: "이건 어때?", icon: FileText },
  { id: "today", label: "하루만", icon: FileText }
];
const initialPageOrder = pages.map(({ id }) => id);
const initialLocalNotes = [
  {
    id: "local-102-1",
    groupKey: "2026.07.23",
    afterNotificationId: "102",
    parentNotificationId: "102",
    title: "배포 전에 API 응답 형식 확인",
    note: "",
    readOnly: false
  }
];
const initialNativeNotes = [
  {
    id: "native-readonly-1",
    title: "공유 체크리스트",
    note: "원본 메모",
    readOnly: true
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

function createMockId(prefix) {
  const suffix =
    window.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function focusAdjacentEditor(currentEditor, direction) {
  const editors = [
    ...document.querySelectorAll(".row-title-input, .row-note-input")
  ].filter(
    (element) => !element.disabled
  );
  const currentIndex = editors.indexOf(currentEditor);
  const target = editors[currentIndex + direction];
  target?.focus();
}

function handleTitleNavigation(event) {
  let direction = 0;
  if (event.key === "ArrowUp") direction = -1;
  if (event.key === "ArrowDown") direction = 1;
  if (
    event.key === "ArrowLeft" &&
    event.currentTarget.selectionStart === 0 &&
    event.currentTarget.selectionEnd === 0
  ) {
    direction = -1;
  }
  if (
    event.key === "ArrowRight" &&
    event.currentTarget.selectionStart === event.currentTarget.value.length &&
    event.currentTarget.selectionEnd === event.currentTarget.value.length
  ) {
    direction = 1;
  }
  if (!direction) return false;
  event.preventDefault();
  focusAdjacentEditor(event.currentTarget, direction);
  return true;
}

function noteBoundaryDirection(event) {
  if (
    event.key === "ArrowUp" &&
    event.currentTarget.selectionStart === 0 &&
    event.currentTarget.selectionEnd === 0
  ) {
    return -1;
  }
  if (
    event.key === "ArrowDown" &&
    event.currentTarget.selectionStart === event.currentTarget.value.length &&
    event.currentTarget.selectionEnd === event.currentTarget.value.length
  ) {
    return 1;
  }
  return 0;
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

function Sidebar({ view, onView, pageOrder }) {
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
        {pageOrder.map((pageId) => {
          const { id, label, icon: PageIcon } = pages.find(({ id }) => id === pageId);
          const isGithub = id === "github";
          const active = isGithub && view === "github";
          return (
            <div
              className={active ? "page-row active" : "page-row"}
              data-page-id={id}
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

function Toolbar({ onHome, showCompleted, onToggleCompleted, onReset }) {
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
        <IconButton label="데모 초기화" onClick={onReset}>
          <RotateCcw size={16} />
        </IconButton>
      </div>
    </div>
  );
}

function LockBadge({ label }) {
  return (
    <span className="lock-badge" role="img" aria-label={label} title={label}>
      <Lock size={14} />
    </span>
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
  lockLabel,
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
            {(trailing || lockLabel) && (
              <div className="trailing-actions">
                {lockLabel && <LockBadge label={lockLabel} />}
                {trailing}
              </div>
            )}
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

function ReadOnlyMenu({
  title,
  readOnly = false,
  containsReadOnly = false,
  onToggleReadOnly,
  onDelete,
  triggerRef
}) {
  const [open, setOpen] = useState(false);
  const internalTriggerRef = React.useRef(null);
  const menuRef = React.useRef(null);

  const assignTrigger = (node) => {
    internalTriggerRef.current = node;
    if (typeof triggerRef === "function") triggerRef(node);
    else if (triggerRef) triggerRef.current = node;
  };

  useEffect(() => {
    if (!open) return;
    const firstItem = menuRef.current?.querySelector(
      '[role^="menuitem"]:not(:disabled)'
    );
    firstItem?.focus();
  }, [open]);

  const closeAndRestoreFocus = () => {
    setOpen(false);
    internalTriggerRef.current?.focus();
  };

  return (
    <span className="row-menu">
      <button
        ref={assignTrigger}
        type="button"
        className="row-menu-trigger"
        aria-label={`${title} 메뉴`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <span
          ref={menuRef}
          className="row-menu-popover"
          role="menu"
          onKeyDown={(event) => {
            const items = [
              ...menuRef.current.querySelectorAll(
                '[role^="menuitem"]:not(:disabled)'
              )
            ];
            const currentIndex = items.indexOf(document.activeElement);
            let target;
            if (event.key === "ArrowDown") {
              target = items[(currentIndex + 1 + items.length) % items.length];
            } else if (event.key === "ArrowUp") {
              target = items[(currentIndex - 1 + items.length) % items.length];
            } else if (event.key === "Home") {
              target = items[0];
            } else if (event.key === "End") {
              target = items.at(-1);
            } else if (event.key === "Escape") {
              event.preventDefault();
              closeAndRestoreFocus();
              return;
            } else if (event.key === "Tab") {
              setOpen(false);
              return;
            }
            if (!target) return;
            event.preventDefault();
            target.focus();
          }}
        >
          {onToggleReadOnly && (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={readOnly}
              onClick={() => {
                onToggleReadOnly();
                closeAndRestoreFocus();
              }}
            >
              <span>읽기 전용</span>
              <span aria-hidden="true">{readOnly ? "✓" : ""}</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={readOnly || containsReadOnly}
          >
            Move To
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={readOnly}
            onClick={() => {
              onDelete();
              setOpen(false);
            }}
          >
            Delete
          </button>
        </span>
      )}
    </span>
  );
}

function NotificationTitle({ item, inputRef, onCreateSibling, onMarkRead }) {
  const [draftTitle, setDraftTitle] = useState(item.title);

  useEffect(() => setDraftTitle(item.title), [item.title]);

  const restore = () => setDraftTitle(item.title);
  return (
    <input
      ref={inputRef}
      className="row-title row-title-input"
      aria-label={`알림 제목: ${item.title}`}
      value={draftTitle}
      onChange={(event) => setDraftTitle(event.target.value)}
      onBlur={restore}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (handleTitleNavigation(event)) return;
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

function NotificationNote({ item, titleRef, onCreateSibling }) {
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
        if (event.nativeEvent.isComposing) return;
        const boundaryDirection = noteBoundaryDirection(event);
        if (boundaryDirection) {
          event.preventDefault();
          restore();
          if (boundaryDirection < 0) {
            titleRef.current?.focus();
          } else {
            focusAdjacentEditor(event.currentTarget, 1);
          }
          return;
        }
        if (event.key === "Enter" && event.shiftKey) {
          event.preventDefault();
          restore();
          onCreateSibling(item);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          restore();
          titleRef.current?.focus();
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
  const titleRef = React.useRef(null);

  return (
    <OutlineRow
      depth={depth}
      title={item.title}
      note={item.subtitle}
      typeIcon={item.icon}
      completed={read}
      lockLabel="GitHub에서 관리됨"
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
          inputRef={titleRef}
          onCreateSibling={onCreateSibling}
          onMarkRead={onMarkRead}
        />
      }
      noteControl={
        <NotificationNote
          item={item}
          titleRef={titleRef}
          onCreateSibling={onCreateSibling}
        />
      }
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

function LocalNoteRow({
  note,
  depth,
  pendingFocusId,
  onFocused,
  onChange,
  onDelete,
  onCreateSibling
}) {
  const inputRef = React.useRef(null);
  const noteRef = React.useRef(null);
  const cancelTitleBlurRef = React.useRef(false);
  const cancelNoteBlurRef = React.useRef(false);
  const focusNoteOnOpenRef = React.useRef(false);
  const [draftTitle, setDraftTitle] = useState(note.title);
  const [draftNote, setDraftNote] = useState(note.note ?? "");
  const [noteEditorVisible, setNoteEditorVisible] = useState(Boolean(note.note));

  useEffect(() => {
    if (pendingFocusId !== note.id) return;
    inputRef.current?.focus();
    onFocused();
  }, [note.id, onFocused, pendingFocusId]);

  useEffect(() => setDraftTitle(note.title), [note.title]);
  useEffect(() => {
    setDraftNote(note.note ?? "");
    if (note.note) setNoteEditorVisible(true);
  }, [note.note]);
  useEffect(() => {
    if (!noteEditorVisible || !focusNoteOnOpenRef.current) return;
    focusNoteOnOpenRef.current = false;
    cancelNoteBlurRef.current = false;
    noteRef.current?.focus();
  }, [noteEditorVisible]);

  const finishTitleEdit = () => {
    if (cancelTitleBlurRef.current) {
      cancelTitleBlurRef.current = false;
      return;
    }
    if (note.readOnly) {
      setDraftTitle(note.title);
    } else {
      onChange(note.id, { title: draftTitle });
    }
  };

  const finishNoteEdit = () => {
    if (cancelNoteBlurRef.current) {
      cancelNoteBlurRef.current = false;
      return;
    }
    if (note.readOnly) {
      setDraftNote(note.note ?? "");
    } else {
      onChange(note.id, { note: draftNote });
    }
    if (!(note.readOnly ? note.note : draftNote)) setNoteEditorVisible(false);
  };

  return (
    <OutlineRow
      depth={depth}
      title={note.title || "Untitled"}
      lockLabel={note.readOnly ? "읽기 전용" : undefined}
      rowAttributes={{
        "data-local-note": note.id,
        "data-parent-notification-id": note.parentNotificationId ?? "",
        "data-readonly": String(note.readOnly)
      }}
      menu={
        <ReadOnlyMenu
          title={note.title || "새 블릿"}
          readOnly={note.readOnly}
          onToggleReadOnly={() =>
            onChange(note.id, { readOnly: !note.readOnly })
          }
          onDelete={() => onDelete(note.id)}
        />
      }
      titleControl={
        <input
          ref={inputRef}
          className="row-title row-title-input local-note-input"
          aria-label={note.title ? `블릿 제목: ${note.title}` : "새 블릿"}
          placeholder="Type to write"
          value={draftTitle}
          onChange={(event) => setDraftTitle(event.target.value)}
          onBlur={finishTitleEdit}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (handleTitleNavigation(event)) return;
            if (event.key === "Escape") {
              cancelTitleBlurRef.current = true;
              setDraftTitle(note.title);
              event.currentTarget.blur();
              return;
            }
            if (event.key === "Enter" && event.shiftKey) {
              event.preventDefault();
              finishTitleEdit();
              if (noteEditorVisible) {
                noteRef.current?.focus();
              } else {
                focusNoteOnOpenRef.current = true;
                setNoteEditorVisible(true);
              }
              return;
            }
            if (
              event.key === "Enter" &&
              !event.altKey &&
              !event.metaKey &&
              !event.ctrlKey
            ) {
              event.preventDefault();
              finishTitleEdit();
              onCreateSibling(note);
              return;
            }
            if (event.key !== "Tab") return;
            event.preventDefault();
            finishTitleEdit();
            if (note.readOnly) return;
            onChange(note.id, {
              parentNotificationId: event.shiftKey ? null : note.afterNotificationId
            });
          }}
        />
      }
      noteControl={
        noteEditorVisible ? (
          <input
            ref={noteRef}
            className="row-note row-note-input"
            aria-label={`블릿 메모: ${note.title || "새 블릿"}`}
            placeholder="Add note"
            value={draftNote}
            onChange={(event) => setDraftNote(event.target.value)}
            onBlur={finishNoteEdit}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              const boundaryDirection = noteBoundaryDirection(event);
              if (event.key === "Escape") {
                event.preventDefault();
                cancelNoteBlurRef.current = true;
                setDraftNote(note.note ?? "");
                if (!note.note) setNoteEditorVisible(false);
                inputRef.current?.focus();
                return;
              }
              if (boundaryDirection) {
                event.preventDefault();
                cancelNoteBlurRef.current = true;
                if (note.readOnly) {
                  setDraftNote(note.note ?? "");
                } else {
                  onChange(note.id, { note: draftNote });
                }
                if (!(note.readOnly ? note.note : draftNote)) {
                  setNoteEditorVisible(false);
                }
                if (boundaryDirection < 0) {
                  inputRef.current?.focus();
                } else {
                  focusAdjacentEditor(event.currentTarget, 1);
                }
                return;
              }
              if (event.key === "Enter" && event.shiftKey) {
                event.preventDefault();
                cancelNoteBlurRef.current = true;
                if (note.readOnly) {
                  setDraftNote(note.note ?? "");
                } else {
                  onChange(note.id, { note: draftNote });
                }
                if (!(note.readOnly ? note.note : draftNote)) {
                  setNoteEditorVisible(false);
                }
                onCreateSibling(note);
              }
            }}
          />
        ) : undefined
      }
    />
  );
}

function NativeNoteRow({
  note,
  pendingFocusId,
  onFocused,
  onChange,
  onCreateSibling,
  onDelete
}) {
  const inputRef = React.useRef(null);
  const noteRef = React.useRef(null);
  const cancelTitleBlurRef = React.useRef(false);
  const cancelNoteBlurRef = React.useRef(false);
  const [draftTitle, setDraftTitle] = useState(note.title);
  const [draftNote, setDraftNote] = useState(note.note);

  useEffect(() => {
    if (pendingFocusId !== note.id) return;
    inputRef.current?.focus();
    onFocused();
  }, [note.id, onFocused, pendingFocusId]);

  useEffect(() => setDraftTitle(note.title), [note.title]);
  useEffect(() => setDraftNote(note.note), [note.note]);

  const finishEdit = (patch, restore) => {
    if (note.readOnly) {
      restore();
    } else {
      onChange(note.id, patch);
    }
  };

  return (
    <OutlineRow
      depth={2}
      title={note.title || "Untitled"}
      lockLabel={note.readOnly ? "읽기 전용" : undefined}
      rowAttributes={{
        "data-native-note": note.id,
        "data-readonly": String(note.readOnly)
      }}
      menu={
        <ReadOnlyMenu
          title={note.title || "새 일반 블릿"}
          readOnly={note.readOnly}
          onToggleReadOnly={() =>
            onChange(note.id, { readOnly: !note.readOnly })
          }
          onDelete={() => onDelete(note.id)}
        />
      }
      titleControl={
        <input
          ref={inputRef}
          className="row-title row-title-input"
          aria-label={note.title ? `블릿 제목: ${note.title}` : "새 일반 블릿"}
          placeholder="Type to write"
          value={draftTitle}
          onChange={(event) => setDraftTitle(event.target.value)}
          onBlur={() =>
            cancelTitleBlurRef.current
              ? (cancelTitleBlurRef.current = false)
              : finishEdit(
                  { title: draftTitle },
                  () => setDraftTitle(note.title)
                )
          }
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (handleTitleNavigation(event)) return;
            if (event.key === "Escape") {
              cancelTitleBlurRef.current = true;
              setDraftTitle(note.title);
              event.currentTarget.blur();
              return;
            }
            if (event.key !== "Enter") return;
            if (event.shiftKey) {
              event.preventDefault();
              finishEdit(
                { title: draftTitle },
                () => setDraftTitle(note.title)
              );
              noteRef.current?.focus();
              return;
            }
            if (event.altKey || event.metaKey || event.ctrlKey) return;
            event.preventDefault();
            finishEdit(
              { title: draftTitle },
              () => setDraftTitle(note.title)
            );
            onCreateSibling(note.id);
          }}
        />
      }
      noteControl={
        <input
          ref={noteRef}
          className="row-note row-note-input"
          aria-label={note.note ? `블릿 메모: ${note.note}` : "새 일반 블릿 메모"}
          placeholder="Add note"
          value={draftNote}
          onChange={(event) => setDraftNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            const boundaryDirection = noteBoundaryDirection(event);
            if (event.key === "Escape") {
              event.preventDefault();
              cancelNoteBlurRef.current = true;
              setDraftNote(note.note);
              inputRef.current?.focus();
              return;
            }
            if (boundaryDirection) {
              event.preventDefault();
              cancelNoteBlurRef.current = true;
              finishEdit(
                { note: draftNote },
                () => setDraftNote(note.note)
              );
              if (boundaryDirection < 0) {
                inputRef.current?.focus();
              } else {
                focusAdjacentEditor(event.currentTarget, 1);
              }
              return;
            }
            if (event.key === "Enter" && event.shiftKey) {
              event.preventDefault();
              cancelNoteBlurRef.current = true;
              finishEdit(
                { note: draftNote },
                () => setDraftNote(note.note)
              );
              onCreateSibling(note.id);
            }
          }}
          onBlur={() =>
            cancelNoteBlurRef.current
              ? (cancelNoteBlurRef.current = false)
              : finishEdit(
                  { note: draftNote },
                  () => setDraftNote(note.note)
                )
          }
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
  onDeleteLocalNote,
  onCreateLocalSibling,
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
              lockLabel="GitHub에서 관리됨"
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
                            onDelete={onDeleteLocalNote}
                            onCreateSibling={onCreateLocalSibling}
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
                          onDelete={onDeleteLocalNote}
                          onCreateSibling={onCreateLocalSibling}
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

function GithubRoot({ collapsed, onToggle, onOpen, onReorder, children }) {
  return (
    <section
      className="root-section plugin-section"
      aria-label="Github Notifications"
      data-page-id="github"
    >
      <OutlineRow
        title="Github Notifications"
        hasChildren
        collapsed={collapsed}
        onToggle={onToggle}
        onOpen={onOpen}
        pluginRoot
        lockLabel="GitHub에서 관리됨"
        rowAttributes={{
          onKeyDown(event) {
            if (
              !(event.metaKey || event.ctrlKey) ||
              !event.shiftKey ||
              !["ArrowUp", "ArrowDown"].includes(event.key)
            ) {
              return;
            }
            event.preventDefault();
            onReorder(event.key === "ArrowUp" ? -1 : 1);
          }
        }}
      />
      {!collapsed && children}
    </section>
  );
}

function AllOutline(props) {
  return (
    <div className="outline-list" aria-label="All Notes">
      {props.pageOrder.map((pageId) => {
        if (pageId === "start") {
          return (
            <section className="root-section" data-page-id="start" key="start">
              <OutlineRow
                title="Yonalist Notes 시작하기"
                hasChildren
                onToggle={() => undefined}
              />
              <OutlineRow depth={1} title="Enter로 새 항목 만들기" />
              <OutlineRow depth={1} title="Tab과 Shift+Tab으로 계층 바꾸기" />
            </section>
          );
        }

        if (pageId === "github") {
          return (
            <GithubRoot
              key="github"
              collapsed={props.rootCollapsed}
              onToggle={props.onToggleRoot}
              onOpen={props.onOpenGithub}
              onReorder={props.onReorderGithub}
            >
              <NotificationGroups {...props} />
            </GithubRoot>
          );
        }

        if (pageId === "daily") {
          return (
            <section
              ref={props.nativeDailyRootRef}
              className="root-section"
              data-page-id="daily"
              key="daily"
            >
              <OutlineRow title="Daily" hasChildren onToggle={() => undefined} />
              {props.nativeDateVisible && (
                <>
                  <OutlineRow
                    depth={1}
                    title="2026-07-23"
                    hasChildren
                    onToggle={() => undefined}
                    menu={
                      <ReadOnlyMenu
                        title="2026-07-23"
                        containsReadOnly={props.nativeNotes.some(
                          (note) => note.readOnly
                        )}
                        onDelete={props.onDeleteNativeDate}
                        triggerRef={props.nativeDateMenuRef}
                      />
                    }
                  />
                  <OutlineRow depth={2} title="오늘 구현할 것 정리" />
                  {props.nativeNotes.map((note) => (
                    <NativeNoteRow
                      key={note.id}
                      note={note}
                      pendingFocusId={props.pendingNativeFocusId}
                      onFocused={props.onNativeFocused}
                      onChange={props.onChangeNativeNote}
                      onCreateSibling={props.onCreateNativeSibling}
                      onDelete={props.onDeleteNativeNote}
                    />
                  ))}
                </>
              )}
            </section>
          );
        }

        return (
          <OutlineRow
            key={pageId}
            title={pages.find(({ id }) => id === pageId).label}
            rowAttributes={{ "data-page-id": pageId }}
          />
        );
      })}
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
  const [pageOrder, setPageOrder] = useStoredState(
    "yona-mock-page-order",
    initialPageOrder
  );
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
  const [nativeNotes, setNativeNotes] = useStoredState(
    "yona-mock-native-notes",
    initialNativeNotes
  );
  const [nativeDateVisible, setNativeDateVisible] = useStoredState(
    "yona-mock-native-date-visible",
    true
  );
  const [showCompleted, setShowCompleted] = useState(true);
  const [pendingFocusId, setPendingFocusId] = useState(null);
  const [pendingNativeFocusId, setPendingNativeFocusId] = useState(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [toast, setToast] = useState("");
  const nativeDateMenuRef = React.useRef(null);
  const nativeDailyRootRef = React.useRef(null);
  const deleteDialogWasOpenRef = React.useRef(false);
  const deleteConfirmedRef = React.useRef(false);
  const cancelDeleteRef = React.useRef(null);
  const confirmDeleteRef = React.useRef(null);

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
      const id = createMockId(`local-${item.id}`);
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
          title: "",
          note: "",
          readOnly: false
        }
      ]);
      setPendingFocusId(id);
    },
    onCreateLocalSibling(note) {
      const id = createMockId(`local-${note.afterNotificationId}`);
      setLocalNotes((current) => {
        const index = current.findIndex((candidate) => candidate.id === note.id);
        const next = [...current];
        next.splice(index + 1, 0, {
          id,
          groupKey: note.groupKey,
          afterNotificationId: note.afterNotificationId,
          parentNotificationId: note.parentNotificationId,
          title: "",
          note: "",
          readOnly: false
        });
        return next;
      });
      setPendingFocusId(id);
    },
    onChangeLocalNote(id, patch) {
      setLocalNotes((current) =>
        current.map((note) => (note.id === id ? { ...note, ...patch } : note))
      );
    },
    onDeleteLocalNote(id) {
      setLocalNotes((current) => current.filter((note) => note.id !== id));
    },
    onOpenWeb(item) {
      setToast(`${item.title} 웹페이지 열기`);
    }
  };

  const resetDemo = () => {
    window.localStorage.clear();
    setView("all");
    setPageOrder([...initialPageOrder]);
    setRootCollapsed(false);
    setCollapsedDates([]);
    setCollapsedNotifications([]);
    setReadNotificationIds([...initiallyReadNotifications]);
    setSavedNotificationIds(["102"]);
    setLocalNotes(initialLocalNotes.map((note) => ({ ...note })));
    setNativeNotes(initialNativeNotes.map((note) => ({ ...note })));
    setNativeDateVisible(true);
    setShowCompleted(true);
    setPendingFocusId(null);
    setPendingNativeFocusId(null);
    setDeleteDialogOpen(false);
    deleteConfirmedRef.current = false;
    setToast("");
  };

  const nativeProps = {
    pageOrder,
    nativeNotes,
    nativeDateVisible,
    pendingNativeFocusId,
    nativeDateMenuRef,
    nativeDailyRootRef,
    onNativeFocused: () => setPendingNativeFocusId(null),
    onChangeNativeNote(id, patch) {
      setNativeNotes((current) =>
        current.map((note) => (note.id === id ? { ...note, ...patch } : note))
      );
    },
    onCreateNativeSibling(afterId) {
      const id = createMockId("native");
      setNativeNotes((current) => {
        const index = current.findIndex((note) => note.id === afterId);
        const next = [...current];
        next.splice(index + 1, 0, {
          id,
          title: "",
          note: "",
          readOnly: false
        });
        return next;
      });
      setPendingNativeFocusId(id);
    },
    onDeleteNativeNote(id) {
      setNativeNotes((current) => current.filter((note) => note.id !== id));
    },
    onDeleteNativeDate() {
      if (nativeNotes.some((note) => note.readOnly)) {
        setDeleteDialogOpen(true);
      } else {
        setNativeDateVisible(false);
      }
    },
    onReorderGithub(direction) {
      setPageOrder((current) => {
        const index = current.indexOf("github");
        const target = Math.max(0, Math.min(current.length - 1, index + direction));
        if (target === index) return current;
        const next = [...current];
        [next[index], next[target]] = [next[target], next[index]];
        return next;
      });
    }
  };

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(""), 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (deleteDialogOpen) {
      deleteDialogWasOpenRef.current = true;
      return;
    }
    if (!deleteDialogWasOpenRef.current) return;
    deleteDialogWasOpenRef.current = false;
    if (deleteConfirmedRef.current) {
      deleteConfirmedRef.current = false;
      nativeDailyRootRef.current?.querySelector(".row-title")?.focus();
    } else {
      nativeDateMenuRef.current?.focus();
    }
  }, [deleteDialogOpen]);

  const closeDeleteDialog = () => setDeleteDialogOpen(false);

  return (
    <div className="prototype-shell">
      <div className="prototype-note" role="note">
        <strong>Interactive markup</strong>
        <span>GitHub 루트는 Ctrl/⌘+Shift+↑↓로 이동할 수 있습니다.</span>
      </div>
      <main className="app-window" inert={deleteDialogOpen}>
        <Sidebar view={view} onView={setView} pageOrder={pageOrder} />
        <section className="detail-pane">
          <Toolbar
            onHome={() => setView("all")}
            showCompleted={showCompleted}
            onToggleCompleted={() => setShowCompleted((current) => !current)}
            onReset={resetDemo}
          />
          <div className="outline-scroll">
            <div className="outline-content" data-zoomed={view === "github" || undefined}>
              {view === "github" ? (
                <GithubZoom {...shared} />
              ) : (
                <AllOutline
                  {...shared}
                  {...nativeProps}
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
      {deleteDialogOpen && (
        <div className="dialog-backdrop">
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="readonly-delete-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeDeleteDialog();
                return;
              }
              if (event.key !== "Tab") return;
              if (event.shiftKey && document.activeElement === cancelDeleteRef.current) {
                event.preventDefault();
                confirmDeleteRef.current?.focus();
              } else if (
                !event.shiftKey &&
                document.activeElement === confirmDeleteRef.current
              ) {
                event.preventDefault();
                cancelDeleteRef.current?.focus();
              }
            }}
          >
            <p id="readonly-delete-title">
              읽기 전용 블릿이 포함되어 있습니다. 함께 삭제할까요?
            </p>
            <div className="dialog-actions">
              <button
                ref={cancelDeleteRef}
                type="button"
                autoFocus
                onClick={closeDeleteDialog}
              >
                취소
              </button>
              <button
                ref={confirmDeleteRef}
                type="button"
                className="danger"
                onClick={() => {
                  deleteConfirmedRef.current = true;
                  setNativeNotes([]);
                  setNativeDateVisible(false);
                  closeDeleteDialog();
                }}
              >
                삭제
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
