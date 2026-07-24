import {
  Bell,
  ChevronRight,
  CircleDot,
  ExternalLink,
  GitPullRequest,
  Lock,
  MessagesSquare,
  Tag
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent
} from "react";
import { useDroppable } from "@dnd-kit/core";
import { IconTooltip } from "../../components/ui/Tooltip";
import { useExternalSources } from "../../ExternalSourcesContext";
import {
  serializeExternalBulletKey,
  type ExternalBullet
} from "../../domain/externalSources";
import type { NoteImportNode } from "../../domain/notes";
import { NoteTextField } from "./NoteTextField";
import { NotesBulletMenu } from "./NotesBulletMenu";
import { parseExternalTitlePaste } from "./notesPasteImport";
import { resolveExternalEditorKey } from "./outlineKeyboard";

export type ExternalEditorField = "title" | "note";
export type ExternalEditorFocusDirection = "previous" | "next";

interface NotesExternalBulletRowProps {
  bullet: ExternalBullet;
  completing: boolean;
  completionError: string | null;
  storedNodeId?: string;
  dropTarget?: boolean;
  onCreateSibling?(bullet: ExternalBullet): void | Promise<void>;
  onStructuralPaste?(
    bullet: ExternalBullet,
    nodes: readonly NoteImportNode[]
  ): void | Promise<void>;
  onCompleted?(bullet: ExternalBullet): void | Promise<void>;
  onFocusMove?(
    bullet: ExternalBullet,
    field: ExternalEditorField,
    direction: ExternalEditorFocusDirection,
    edge: "start" | "end" | null
  ): void;
}

const completionFailure = "Unable to complete external item.";

function ExternalBulletLead({ icon }: Pick<ExternalBullet, "icon">) {
  if (!icon) {
    return <span className="notes-external-bullet" aria-hidden="true" />;
  }

  let lead;
  switch (icon) {
    case "issue":
      lead = <CircleDot size={15} role="img" aria-label="Issue" />;
      break;
    case "pull-request":
      lead = <GitPullRequest size={15} role="img" aria-label="Pull Request" />;
      break;
    case "discussion":
      lead = <MessagesSquare size={15} role="img" aria-label="Discussion" />;
      break;
    case "release":
      lead = <Tag size={15} role="img" aria-label="Release" />;
      break;
    case "notification":
      lead = <Bell size={15} role="img" aria-label="Notification" />;
      break;
  }
  return <span className="notes-external-icon">{lead}</span>;
}

function clampSelection(
  textarea: HTMLTextAreaElement,
  start: number,
  end: number
) {
  const length = textarea.value.length;
  textarea.setSelectionRange(
    Math.min(start, length),
    Math.min(end, length)
  );
}

export function NotesExternalBulletRow({
  bullet,
  completing,
  completionError,
  storedNodeId,
  dropTarget = false,
  onCreateSibling,
  onStructuralPaste,
  onCompleted,
  onFocusMove
}: NotesExternalBulletRowProps) {
  const externalSources = useExternalSources();
  const [expanded, setExpanded] = useState(false);
  const [noteOpen, setNoteOpen] = useState(() => Boolean(bullet.note));
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [temporaryTitle, setTemporaryTitle] = useState(bullet.title);
  const [temporaryNote, setTemporaryNote] = useState(bullet.note);
  const [restoreAnnouncementVersion, setRestoreAnnouncementVersion] =
    useState(0);
  const completionGuardRef = useRef(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const previousSnapshotRef = useRef({
    title: bullet.title,
    note: bullet.note,
    updatedAt: bullet.updatedAt,
    completed: bullet.completed
  });
  const serializedKey = serializeExternalBulletKey(bullet.key);
  const projectionDropId = `github-notification-drop:${serializedKey}`;
  const { setNodeRef: setDropTargetRef, isOver: projectionDropOver } =
    useDroppable({
      id: projectionDropId,
      disabled: !dropTarget,
      data: {
        kind: "github-notification-projection",
        serializedKey
      }
    });
  const visibleError = completionError ?? localError;

  const restoreProviderSnapshot = useCallback(() => {
    setTemporaryTitle(bullet.title);
    setTemporaryNote(bullet.note);
    setRestoreAnnouncementVersion((version) => version + 1);
  }, [bullet.note, bullet.title]);

  useLayoutEffect(() => {
    const previous = previousSnapshotRef.current;
    if (
      previous.title === bullet.title &&
      previous.note === bullet.note &&
      previous.updatedAt === bullet.updatedAt &&
      previous.completed === bullet.completed
    ) {
      return;
    }
    previousSnapshotRef.current = {
      title: bullet.title,
      note: bullet.note,
      updatedAt: bullet.updatedAt,
      completed: bullet.completed
    };
    const focused =
      document.activeElement === titleRef.current
        ? titleRef.current
        : document.activeElement === noteRef.current
          ? noteRef.current
          : null;
    const selection = focused
      ? [focused.selectionStart, focused.selectionEnd] as const
      : null;
    restoreProviderSnapshot();
    if (focused && selection) {
      queueMicrotask(() => {
        focused.focus();
        clampSelection(focused, selection[0], selection[1]);
      });
    }
  }, [
    bullet.completed,
    bullet.note,
    bullet.title,
    bullet.updatedAt,
    restoreProviderSnapshot
  ]);

  useEffect(() => {
    if (bullet.completed) {
      setLocalError(null);
    }
  }, [bullet.completed]);

  const requestComplete = async () => {
    if (
      bullet.completed ||
      !bullet.capabilities.complete ||
      completing ||
      completionGuardRef.current
    ) {
      return;
    }
    completionGuardRef.current = true;
    setPending(true);
    setLocalError(null);
    try {
      await externalSources.complete(bullet.key);
      await onCompleted?.(bullet);
    } catch {
      setLocalError(completionFailure);
    } finally {
      completionGuardRef.current = false;
      setPending(false);
    }
  };

  const createSibling = () => {
    restoreProviderSnapshot();
    void onCreateSibling?.(bullet);
  };

  const handleEditorKeyDown = (
    field: ExternalEditorField,
    event: KeyboardEvent<HTMLTextAreaElement>
  ) => {
    const resolution = resolveExternalEditorKey({
      field,
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      repeat: event.repeat,
      selectionStart: event.currentTarget.selectionStart,
      selectionEnd: event.currentTarget.selectionEnd,
      value: event.currentTarget.value
    });
    if (resolution === null) {
      return;
    }
    event.preventDefault();
    switch (resolution.type) {
      case "complete":
        void requestComplete();
        return;
      case "createSibling":
        createSibling();
        return;
      case "focusNote":
        setNoteOpen(true);
        queueMicrotask(() => noteRef.current?.focus());
        return;
      case "restore":
        restoreProviderSnapshot();
        return;
      case "focusTitle":
        if (resolution.restore) {
          restoreProviderSnapshot();
        }
        titleRef.current?.focus();
        return;
      case "focus":
        onFocusMove?.(
          bullet,
          field,
          resolution.direction,
          resolution.edge
        );
        return;
      case "consume":
        return;
    }
  };

  const handleTitlePaste = (
    event: ClipboardEvent<HTMLTextAreaElement>
  ) => {
    const text = event.clipboardData.getData("text/plain");
    const nodes = parseExternalTitlePaste(text);
    if (nodes === null || onStructuralPaste === undefined) {
      return;
    }
    event.preventDefault();
    restoreProviderSnapshot();
    void onStructuralPaste(bullet, nodes);
  };

  return (
    <li
      ref={dropTarget ? setDropTargetRef : undefined}
      className="notes-node notes-external-row"
      data-external-bullet-key={serializedKey}
      data-github-editor-key={serializedKey}
      data-github-editor-node-id={storedNodeId}
      data-github-notification-drop-target={
        dropTarget ? serializedKey : undefined
      }
      data-drop-over={projectionDropOver ? "true" : undefined}
      data-expanded={
        bullet.capabilities.expand && expanded ? "true" : "false"
      }
      data-completed={bullet.completed ? "true" : "false"}
      aria-busy={completing || pending}
    >
      <div className="notes-node-main notes-external-row-main">
        <span className="notes-node-menu-slot">
          {bullet.capabilities.complete && !bullet.completed && (
            <NotesBulletMenu
              mode="provider"
              label={bullet.title}
              completed={bullet.completed}
              actionBusy={completing || pending}
              onToggleComplete={() => void requestComplete()}
            />
          )}
        </span>
        <span className="notes-node-arrow-slot">
          {bullet.capabilities.expand && (
            <button
              className="notes-external-expand"
              type="button"
              aria-label={`${expanded ? "접기" : "펼치기"}: ${bullet.title}`}
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          )}
        </span>
        <span className="notes-node-bullet notes-external-provider-bullet">
          <ExternalBulletLead icon={bullet.icon} />
        </span>
        <span className="notes-external-title-line">
          <NoteTextField
            ref={titleRef}
            stablePresentation
            placeCaretFromPointer
            className="notes-node-title notes-external-title"
            containerClassName="notes-node-title-field notes-external-title-field"
            value={temporaryTitle}
            aria-label="Edit node title"
            data-github-editor-key={serializedKey}
            data-github-editor-node-id={storedNodeId}
            data-github-editor-field="title"
            style={{
              overflowWrap: "normal",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap"
            }}
            rows={1}
            onTagClick={() => undefined}
            onChange={(event) => setTemporaryTitle(event.currentTarget.value)}
            onBlur={restoreProviderSnapshot}
            onKeyDown={(event) => handleEditorKeyDown("title", event)}
            onPaste={handleTitlePaste}
          />
          <span className="notes-node-inline-actions">
            <span
              className="notes-node-lock"
              role="img"
              aria-label="GitHub에서 관리됨"
            >
              <Lock size={13} aria-hidden="true" />
              <span className="notes-selection-visually-hidden">
                GitHub에서 관리됨
              </span>
            </span>
            {bullet.capabilities.openDetails && (
              <IconTooltip label="웹에서 열기">
                <button
                  className="notes-external-details"
                  type="button"
                  aria-label={`웹에서 열기: ${bullet.title}`}
                  onClick={() =>
                    externalSources.openDetails(
                      bullet.key,
                      bullet.externalUrl
                    )
                  }
                >
                  <ExternalLink size={15} aria-hidden="true" />
                </button>
              </IconTooltip>
            )}
          </span>
        </span>
      </div>
      {restoreAnnouncementVersion > 0 && (
        <span
          key={restoreAnnouncementVersion}
          className="notes-selection-visually-hidden"
          role="status"
          aria-live="polite"
        >
          GitHub content restored.
        </span>
      )}
      {noteOpen && (!bullet.capabilities.expand || expanded) && (
        <NoteTextField
          ref={noteRef}
          stablePresentation
          placeCaretFromPointer
          className="notes-node-note notes-external-note"
          containerClassName="notes-node-note-field notes-external-note-field"
          value={temporaryNote}
          aria-label={`Supporting note: ${bullet.title}`}
          data-github-editor-key={serializedKey}
          data-github-editor-node-id={storedNodeId}
          data-github-editor-field="note"
          rows={1}
          onTagClick={() => undefined}
          onChange={(event) => setTemporaryNote(event.currentTarget.value)}
          onBlur={restoreProviderSnapshot}
          onKeyDown={(event) => handleEditorKeyDown("note", event)}
        />
      )}
      {visibleError && (
        <div className="notes-external-completion-error" role="alert">
          <span>{visibleError}</span>
          <button type="button" onClick={() => void requestComplete()}>
            다시 시도
          </button>
        </div>
      )}
    </li>
  );
}
