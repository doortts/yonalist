import {
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import type { NoteId } from "../../domain/notes";
import { NoteTextField } from "./NoteTextField";
import { useNotesDatePickerIntegration } from "./NotesDatePickerIntegration";
import { NotesBulletMenu } from "./NotesBulletMenu";
import { useNotesExportController } from "./NotesExportController";
import { useNotesWorkspaceContext } from "./NotesWorkspaceContext";
import { resizeTextarea, useAutoGrowTextarea } from "./autoGrowTextarea";
import {
  detectOutlineShortcutPlatform,
  resolveNotesHistoryShortcut,
  resolveOutlineKey
} from "./outlineKeyboard";

interface NotesPageHeaderProps {
  nodeId: NoteId;
  disabled?: boolean;
  mode?: "standard" | "archive" | "trash";
}

function pageLabel(title: string): string {
  return title.trim() || "Untitled page";
}

export function NotesPageHeader({
  nodeId,
  disabled = false,
  mode = "standard"
}: NotesPageHeaderProps) {
  const {
    actions,
    activeTagFilters,
    draftsByNodeId,
    retryFailedDraft,
    state
  } = useNotesWorkspaceContext();
  const exportController = useNotesExportController();
  const node = state.nodesById[nodeId];
  const draft = draftsByNodeId[nodeId];
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const titleCaretRef = useRef<number | null>(null);
  const focusNoteOnOpenRef = useRef(false);
  const commandInFlightRef = useRef(false);
  const [revealedNoteNodeId, setRevealedNoteNodeId] =
    useState<NoteId | null>(null);
  const [trashConfirmOpen, setTrashConfirmOpen] = useState(false);
  const titleValue = draft?.title ?? node?.title ?? "";
  const noteValue = draft?.note ?? node?.note ?? "";
  const label = pageLabel(titleValue || node?.title || "");
  const noteVisible =
    noteValue.length > 0 || revealedNoteNodeId === nodeId;
  const readOnly = mode !== "standard";
  const datePicker = useNotesDatePickerIntegration({
    values: { title: titleValue, note: noteValue },
    refs: { title: titleRef, note: noteRef },
    onCommit: (field, value) => {
      actions.updateNodeDraft(
        nodeId,
        field === "title"
          ? { title: value, note: noteValue }
          : { title: titleValue, note: value },
        field
      );
      void actions.flushNodeDraft(nodeId);
    }
  });

  useAutoGrowTextarea(titleRef, titleValue);
  useAutoGrowTextarea(noteRef, noteValue, noteVisible);

  useLayoutEffect(() => {
    if (noteVisible && focusNoteOnOpenRef.current && noteRef.current) {
      focusNoteOnOpenRef.current = false;
      noteRef.current.focus();
    }
  }, [noteVisible]);

  useEffect(() => {
    if (state.pendingFocusId !== nodeId) {
      return;
    }
    if (state.pendingFocusField === "note" && !noteVisible) {
      setRevealedNoteNodeId(nodeId);
      return;
    }
    const target =
      state.pendingFocusField === "note" ? noteRef.current : titleRef.current;
    target?.focus();
    if (target && document.activeElement === target) {
      void actions.acknowledgeFocus(nodeId);
    }
  }, [actions, nodeId, noteVisible, state.pendingFocusField, state.pendingFocusId]);

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

  const removeNote = () => {
    setRevealedNoteNodeId(null);
    actions.updateNodeDraft(nodeId, { title: titleValue, note: "" }, "note");
    void actions.flushNodeDraft(nodeId);
  };

  const handleTitleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const historyShortcut = resolveNotesHistoryShortcut({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      platform: detectOutlineShortcutPlatform()
    });
    if (historyShortcut) {
      event.preventDefault();
      void actions[historyShortcut]?.();
      return;
    }
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
    <>
      <header
        className="notes-page-header"
        data-completed={node.completedAt !== null ? "true" : undefined}
        data-selected={state.selectedId === nodeId ? "true" : undefined}
      >
        <div className="notes-page-title-row">
          <div className="notes-page-menu-slot">
            <NotesBulletMenu
              mode={mode}
              label={label}
              completed={node.completedAt !== null}
              starred={node.isStarred}
              hasNote={Boolean(noteValue.trim())}
              saveFailed={draft?.status === "failed"}
              disabled={disabled}
              exportDisabled={
                exportController.unavailable || exportController.busy
              }
              onToggleComplete={() =>
                runCommand(() => actions.toggleComplete(nodeId))
              }
              onToggleStar={() =>
                runCommand(() => actions.toggleStar(nodeId))
              }
              onOpenNote={openAndFocusNote}
              onAddDate={() => {
                datePicker.openTitleDate(titleCaretRef.current ?? undefined);
                titleCaretRef.current = null;
              }}
              onRemoveNote={removeNote}
              onDuplicate={() =>
                runCommand(() => actions.duplicateNode(nodeId))
              }
              onExport={(format) =>
                exportController.startExport(nodeId, titleValue, format)
              }
              onDelete={() => {
                if (mode === "archive") {
                  setTrashConfirmOpen(true);
                  return;
                }
                runCommand(() => actions.deleteNode(nodeId));
              }}
              onRetrySave={() => runCommand(() => retryFailedDraft(nodeId))}
              onRestore={() => runCommand(() => actions.restoreNode(nodeId))}
              onUnarchive={() =>
                runCommand(() => actions.unarchiveNode(nodeId))
              }
            />
          </div>
          <h1 className="notes-page-heading" aria-label={label}>
            <NoteTextField
              ref={titleRef}
              className="notes-page-title"
              containerClassName="notes-page-title-field"
              value={titleValue}
              aria-label="Edit page title"
              placeholder="Untitled page"
              rows={1}
              wrap="soft"
              disabled={disabled}
              readOnly={readOnly}
              today={datePicker.today}
              onDateClick={
                readOnly || disabled
                  ? undefined
                  : (token, anchor) =>
                      datePicker.openExistingDate("title", token, anchor)
              }
              onDateTrigger={
                readOnly || disabled
                  ? undefined
                  : (range, anchor) =>
                      datePicker.openTypedDate("title", range, anchor)
              }
              onTagClick={(token) =>
                void actions.toggleTagFilter({
                  prefix: token.prefix,
                  normalizedTag: token.normalized
                })
              }
              isTagActive={(token) =>
                activeTagFilters.some(
                  (filter) =>
                    filter.prefix === token.prefix &&
                    filter.normalizedTag === token.normalized
                )
              }
              onKeyDown={readOnly ? undefined : handleTitleKeyDown}
              onSelect={(event) => {
                titleCaretRef.current = event.currentTarget.selectionStart;
              }}
              onChange={(event) => {
                resizeTextarea(event.currentTarget);
                actions.updateNodeDraft(nodeId, {
                  title: event.target.value,
                  note: noteValue
                }, "title");
              }}
              onBlur={(event) => {
                titleCaretRef.current = event.currentTarget.selectionStart;
                if (!datePicker.shouldSuppressBlur()) {
                  void actions.flushNodeDraft(nodeId);
                }
              }}
            />
          </h1>
        </div>
        {noteVisible && (
          <NoteTextField
            ref={noteRef}
            className="notes-page-note"
            containerClassName="notes-page-note-field"
            value={noteValue}
            aria-label={`Supporting note: ${label}`}
            placeholder="Add a supporting note"
            rows={1}
            disabled={disabled}
            readOnly={readOnly}
            today={datePicker.today}
            onDateClick={
              readOnly || disabled
                ? undefined
                : (token, anchor) =>
                    datePicker.openExistingDate("note", token, anchor)
            }
            onDateTrigger={
              readOnly || disabled
                ? undefined
                : (range, anchor) =>
                    datePicker.openTypedDate("note", range, anchor)
            }
            onTagClick={(token) =>
              void actions.toggleTagFilter({
                prefix: token.prefix,
                normalizedTag: token.normalized
              })
            }
            isTagActive={(token) =>
              activeTagFilters.some(
                (filter) =>
                  filter.prefix === token.prefix &&
                  filter.normalizedTag === token.normalized
              )
            }
            onKeyDown={
              readOnly
                ? undefined
                : (event) => {
                    const historyShortcut = resolveNotesHistoryShortcut({
                      key: event.key,
                      altKey: event.altKey,
                      ctrlKey: event.ctrlKey,
                      metaKey: event.metaKey,
                      shiftKey: event.shiftKey,
                      isComposing: event.nativeEvent.isComposing,
                      platform: detectOutlineShortcutPlatform()
                    });
                    if (historyShortcut) {
                      event.preventDefault();
                      void actions[historyShortcut]?.();
                    }
                  }
            }
            onFocus={() => setRevealedNoteNodeId(nodeId)}
            onChange={(event) => {
              setRevealedNoteNodeId(nodeId);
              resizeTextarea(event.currentTarget);
              actions.updateNodeDraft(nodeId, {
                title: titleValue,
                note: event.target.value
              }, "note");
            }}
            onBlur={() => {
              if (!datePicker.shouldSuppressBlur()) {
                void actions.flushNodeDraft(nodeId);
              }
            }}
          />
        )}
      </header>
      {datePicker.picker}
      <ConfirmDialog
        open={trashConfirmOpen}
        onOpenChange={setTrashConfirmOpen}
        title="Move page to Trash?"
        description={`Move ${label} and all of its descendants to Trash?`}
        confirmLabel="Move to Trash"
        cancelLabel="Cancel"
        danger
        onConfirm={() => void actions.deleteNode(nodeId)}
      />
    </>
  );
}
