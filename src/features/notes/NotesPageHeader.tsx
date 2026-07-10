import {
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import type { NoteId } from "../../domain/notes";
import { NotesBulletMenu } from "./NotesBulletMenu";
import { useNotesExportController } from "./NotesExportController";
import { useNotesWorkspaceContext } from "./NotesWorkspaceContext";
import { resizeTextarea, useAutoGrowTextarea } from "./autoGrowTextarea";
import {
  detectOutlineShortcutPlatform,
  resolveOutlineKey
} from "./outlineKeyboard";

interface NotesPageHeaderProps {
  nodeId: NoteId;
  disabled?: boolean;
}

function pageLabel(title: string): string {
  return title.trim() || "Untitled page";
}

export function NotesPageHeader({
  nodeId,
  disabled = false
}: NotesPageHeaderProps) {
  const {
    actions,
    draftsByNodeId,
    retryFailedDraft,
    state
  } = useNotesWorkspaceContext();
  const exportController = useNotesExportController();
  const node = state.nodesById[nodeId];
  const draft = draftsByNodeId[nodeId];
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const focusNoteOnOpenRef = useRef(false);
  const commandInFlightRef = useRef(false);
  const [revealedNoteNodeId, setRevealedNoteNodeId] =
    useState<NoteId | null>(null);
  const titleValue = draft?.title ?? node?.title ?? "";
  const noteValue = draft?.note ?? node?.note ?? "";
  const label = pageLabel(titleValue || node?.title || "");
  const noteVisible =
    noteValue.length > 0 || revealedNoteNodeId === nodeId;

  useAutoGrowTextarea(titleRef, titleValue);

  useLayoutEffect(() => {
    resizeTextarea(noteRef.current);
    if (noteVisible && focusNoteOnOpenRef.current && noteRef.current) {
      focusNoteOnOpenRef.current = false;
      noteRef.current.focus();
    }
  }, [noteValue, noteVisible]);

  useEffect(() => {
    if (state.pendingFocusId !== nodeId || !titleRef.current) {
      return;
    }
    titleRef.current.focus();
    if (document.activeElement === titleRef.current) {
      void actions.acknowledgeFocus(nodeId);
    }
  }, [actions, nodeId, state.pendingFocusId]);

  if (!node) {
    return null;
  }

  const runCommand = (command: () => Promise<void>) => {
    if (commandInFlightRef.current) {
      return;
    }
    commandInFlightRef.current = true;
    let completion: Promise<void>;
    try {
      completion = command();
    } catch {
      commandInFlightRef.current = false;
      return;
    }
    const settle = () => {
      commandInFlightRef.current = false;
    };
    void completion.then(settle, settle);
  };

  const openAndFocusNote = () => {
    focusNoteOnOpenRef.current = true;
    setRevealedNoteNodeId(nodeId);
    if (noteRef.current) {
      focusNoteOnOpenRef.current = false;
      noteRef.current.focus();
    }
  };

  const handleTitleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const resolution = resolveOutlineKey({
      target: "title",
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      repeat: event.repeat,
      selectionStart: event.currentTarget.selectionStart,
      selectionEnd: event.currentTarget.selectionEnd,
      title: titleValue,
      note: noteValue,
      nodeId,
      platform: detectOutlineShortcutPlatform(),
      workspace: state
    });
    if (!resolution) {
      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault();
      }
      return;
    }
    if (
      ![
        "focusNote",
        "toggleComplete",
        "duplicate",
        "delete"
      ].includes(resolution.type)
    ) {
      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault();
      }
      return;
    }
    event.preventDefault();
    switch (resolution.type) {
      case "focusNote":
        openAndFocusNote();
        return;
      case "toggleComplete":
        runCommand(() => actions.toggleComplete(nodeId));
        return;
      case "duplicate":
        runCommand(() => actions.duplicateNode(nodeId));
        return;
      case "delete":
        runCommand(() => actions.deleteNode(nodeId));
        return;
    }
  };

  return (
    <header
      className="notes-page-header"
      data-completed={node.completedAt !== null ? "true" : undefined}
    >
      <div className="notes-page-title-row">
        <h1 className="notes-page-heading" aria-label={label}>
          <textarea
            ref={titleRef}
            className="notes-page-title"
            value={titleValue}
            aria-label="Edit page title"
            placeholder="Untitled page"
            rows={1}
            wrap="soft"
            disabled={disabled}
            onKeyDown={handleTitleKeyDown}
            onChange={(event) => {
              resizeTextarea(event.currentTarget);
              actions.updateNodeDraft(nodeId, {
                title: event.target.value,
                note: noteValue
              })
            }}
            onBlur={() => void actions.flushNodeDraft(nodeId)}
          />
        </h1>
        <NotesBulletMenu
          label={label}
          completed={node.completedAt !== null}
          starred={node.isStarred}
          hasNote={Boolean(noteValue.trim())}
          saveFailed={draft?.status === "failed"}
          disabled={disabled}
          exportDisabled={exportController.unavailable || exportController.busy}
          onToggleComplete={() => runCommand(() => actions.toggleComplete(nodeId))}
          onToggleStar={() => runCommand(() => actions.toggleStar(nodeId))}
          onOpenNote={openAndFocusNote}
          onDuplicate={() => runCommand(() => actions.duplicateNode(nodeId))}
          onExport={(format) =>
            exportController.startExport(nodeId, titleValue, format)
          }
          onDelete={() => runCommand(() => actions.deleteNode(nodeId))}
          onRetrySave={() => runCommand(() => retryFailedDraft(nodeId))}
        />
      </div>
      {noteVisible && (
        <textarea
          ref={noteRef}
          className="notes-page-note"
          value={noteValue}
          aria-label={`Supporting note: ${label}`}
          placeholder="Add a supporting note"
          rows={1}
          disabled={disabled}
          onFocus={() => setRevealedNoteNodeId(nodeId)}
          onChange={(event) => {
            setRevealedNoteNodeId(nodeId);
            resizeTextarea(event.currentTarget);
            actions.updateNodeDraft(nodeId, {
              title: titleValue,
              note: event.target.value
            });
          }}
          onBlur={() => void actions.flushNodeDraft(nodeId)}
        />
      )}
    </header>
  );
}
