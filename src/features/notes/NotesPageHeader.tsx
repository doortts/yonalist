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
import {
  buildNotesMoveDestinations,
  buildNotesMoveNodeInput,
  NotesBulletMenu
} from "./NotesBulletMenu";
import { NotesAttachmentList } from "./NotesAttachmentList";
import { NotesImageNodeContent } from "./NotesImageAttachment";
import { NotesImageUploadStatus } from "./NotesImageUploadStatus";
import {
  noteNodeNavigationLabel,
  noteNodePresentationLabel
} from "./notesPresentation";
import { useNotesExportController } from "./NotesExportController";
import {
  useNotesActions,
  useNotesDrafts,
  useNotesState
} from "./NotesWorkspaceContext";
import type { NotesPreparedMove } from "./useNotesWorkspace";
import { resizeTextarea, useAutoGrowTextarea } from "./autoGrowTextarea";
import {
  detectOutlineShortcutPlatform,
  resolveNotesHistoryShortcut,
  resolveOutlineKey,
  resolveSupportingNoteKey,
  supportingNoteFocusTarget
} from "./outlineKeyboard";

interface NotesPageHeaderProps {
  nodeId: NoteId;
  getVisibleNodeIds(): readonly NoteId[];
  disabled?: boolean;
  mode?: "standard" | "archive" | "trash";
  imageDropActive?: boolean;
  showDropPlaceholder?: boolean;
}

export function NotesPageHeader({
  nodeId,
  getVisibleNodeIds,
  disabled = false,
  mode = "standard",
  imageDropActive = false,
  showDropPlaceholder = false
}: NotesPageHeaderProps) {
  const {
    actions,
    commitPreparedMove,
    loadActiveNodesForMove,
    prepareMoveNode,
    retryFailedDraft
  } = useNotesActions();
  const { activeTagFilters, state } = useNotesState();
  const {
    attachmentUploadErrorsByNodeId,
    attachmentUploadRetryAttemptIdsByNodeId,
    draftsByNodeId
  } = useNotesDrafts();
  const exportController = useNotesExportController();
  const node = state.nodesById[nodeId];
  const draft = draftsByNodeId[nodeId];
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const imageRef = useRef<HTMLDivElement>(null);
  const titleSelectionRef = useRef<{
    startUtf16: number;
    endUtf16: number;
  } | null>(null);
  const focusNoteOnOpenRef = useRef(false);
  const dateNoteOnOpenRef = useRef(false);
  const noteComposingRef = useRef(false);
  const noteBlurredDuringCompositionRef = useRef(false);
  const preparedMoveRef = useRef<NotesPreparedMove | null>(null);
  const commandInFlightRef = useRef(false);
  const [revealedNoteNodeId, setRevealedNoteNodeId] =
    useState<NoteId | null>(null);
  const [trashConfirmOpen, setTrashConfirmOpen] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const titleValue = draft?.title ?? node?.title ?? "";
  const noteValue = draft?.note ?? node?.note ?? "";
  const label = node
    ? noteNodePresentationLabel(
        node,
        titleValue || node.title,
        "Untitled page"
      )
    : "Untitled page";
  const headingLabel = node
    ? noteNodeNavigationLabel(
        node,
        titleValue || node.title,
        "Untitled page"
      )
    : "Untitled page";
  const noteVisible =
    noteValue.length > 0 || revealedNoteNodeId === nodeId;
  const readOnly = mode !== "standard";
  const imageIngestEnabled =
    !disabled &&
    !readOnly &&
    state.status !== "loading";
  const imageAttachmentTargetEnabled =
    imageIngestEnabled &&
    (actions.importDroppedImagePaths !== undefined ||
      actions.importClipboardImages !== undefined);
  const imageDropEnabled =
    imageIngestEnabled && actions.importDroppedImagePaths !== undefined;
  const titlePresentationLabel =
    readOnly || disabled ? "Page title" : undefined;
  const attachments = state.attachmentsByNodeId?.[nodeId] ?? [];
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
    if (!noteVisible || !noteRef.current) {
      return;
    }
    if (dateNoteOnOpenRef.current) {
      dateNoteOnOpenRef.current = false;
      const caret = noteRef.current.value.length;
      datePicker.openTypedDate(
        "note",
        { startUtf16: caret, endUtf16: caret },
        noteRef.current
      );
      return;
    }
    if (focusNoteOnOpenRef.current) {
      focusNoteOnOpenRef.current = false;
      noteRef.current.focus();
    }
  }, [datePicker, noteVisible]);

  useEffect(() => {
    if (state.pendingFocusId !== nodeId) {
      return;
    }
    // A read-only page (archive/trash) is not focusable; wait until it becomes
    // editable. `readOnly` in the deps re-runs this once editability flips so
    // focus lands after a restore — previously an incidental `actions` identity
    // churn (now removed) provided that retry.
    if (readOnly) {
      return;
    }
    if (state.pendingFocusField === "note" && !noteVisible) {
      setRevealedNoteNodeId(nodeId);
      return;
    }
    const target =
      state.pendingFocusField === "note"
        ? noteRef.current
        : node?.nodeKind === "image"
          ? imageRef.current
          : titleRef.current;
    target?.focus();
    if (target && document.activeElement === target) {
      void actions.acknowledgeFocus(nodeId);
    }
  }, [
    actions,
    nodeId,
    node?.nodeKind,
    noteVisible,
    readOnly,
    state.pendingFocusField,
    state.pendingFocusId
  ]);

  if (!node) {
    return null;
  }

  const runCommand = (command: () => Promise<unknown>) => {
    if (commandInFlightRef.current) {
      return;
    }
    commandInFlightRef.current = true;
    setCommandBusy(true);
    let completion: Promise<unknown>;
    try {
      completion = command();
    } catch {
      commandInFlightRef.current = false;
      return;
    }
    const settle = () => {
      commandInFlightRef.current = false;
      setCommandBusy(false);
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

  const settleNoteBlur = (value: string, includeLiveValue = false) => {
    if (includeLiveValue) {
      actions.updateNodeDraft(nodeId, { title: titleValue, note: value }, "note");
    }
    if (value.trim().length === 0) {
      setRevealedNoteNodeId(null);
      if (value.length > 0) {
        actions.updateNodeDraft(nodeId, { title: titleValue, note: "" }, "note");
      }
    }
    void actions.flushNodeDraft(nodeId);
  };

  const openNoteDate = () => {
    if (!noteRef.current) {
      dateNoteOnOpenRef.current = true;
      setRevealedNoteNodeId(nodeId);
      return;
    }
    const caret = noteRef.current.value.length;
    datePicker.openTypedDate(
      "note",
      { startUtf16: caret, endUtf16: caret },
      noteRef.current
    );
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
      workspace: state,
      visibleNodeIds: getVisibleNodeIds()
    });
    if (!resolution) {
      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault();
      }
      return;
    }
    if (
      ![
        "focus",
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
      case "focus":
        void actions.flushNodeDraft(nodeId);
        void actions.focusNode(resolution.nodeId);
        return;
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

  const handleImageKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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
      target: "image",
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      repeat: event.repeat,
      selectionStart: null,
      selectionEnd: null,
      title: titleValue,
      note: noteValue,
      nodeId,
      platform: detectOutlineShortcutPlatform(),
      workspace: state
    });
    if (!resolution) return;

    event.preventDefault();
    switch (resolution.type) {
      case "createNextTextSibling":
        runCommand(() => actions.createNextTextSibling(nodeId));
        return;
      case "focusNote":
        openAndFocusNote();
        return;
      case "move":
        runCommand(() =>
          actions.moveNode(resolution.input, resolution.focusNodeId, {
            expandNodeId: resolution.expandNodeId
          })
        );
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
      case "toggleCollapsed":
        runCommand(() => actions.toggleCollapsed(nodeId));
        return;
      case "focus":
        void actions.focusNode(resolution.nodeId);
        return;
      case "split":
      case "remove":
      case "extendSelection":
      case "clearSelection":
      case "batchComplete":
      case "batchDelete":
      case "batchIndent":
      case "batchOutdent":
        return;
    }
  };

  return (
    <>
      <header
        className="notes-page-header"
        data-completed={node.completedAt !== null ? "true" : undefined}
        data-selected={state.selectedId === nodeId ? "true" : undefined}
        data-notes-attachment-target={
          imageAttachmentTargetEnabled ? nodeId : undefined
        }
        data-image-drop-active={
          imageDropEnabled && imageDropActive ? "true" : undefined
        }
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
              actionBusy={commandBusy}
              createdAt={node.createdAt}
              updatedAt={node.updatedAt}
              getMoveDestinations={() => {
                preparedMoveRef.current = null;
                if (prepareMoveNode) {
                  return prepareMoveNode(nodeId).then((prepared) => {
                    preparedMoveRef.current = prepared;
                    return buildNotesMoveDestinations(
                      Object.fromEntries(
                        prepared.nodes.map((item) => [item.id, item])
                      ),
                      nodeId
                    );
                  });
                }
                if (!loadActiveNodesForMove) {
                  return buildNotesMoveDestinations(state.nodesById, nodeId);
                }
                return loadActiveNodesForMove()
                  .then((nodes) =>
                    buildNotesMoveDestinations(
                      Object.fromEntries(
                        nodes.map((item) => [item.id, item])
                      ),
                      nodeId
                    )
                  )
                  .catch(() =>
                    buildNotesMoveDestinations(state.nodesById, nodeId)
                  );
              }}
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
                if (node.nodeKind === "image") {
                  openNoteDate();
                  return;
                }
                datePicker.openTitleDate(titleSelectionRef.current ?? undefined);
                titleSelectionRef.current = null;
              }}
              onUploadImage={
                actions.uploadImage
                  ? () => void actions.uploadImage?.(nodeId)
                  : undefined
              }
              onMoveTo={(destinationId) => {
                if (preparedMoveRef.current && commitPreparedMove) {
                  return commitPreparedMove(
                    preparedMoveRef.current,
                    destinationId
                  );
                }
                const input = buildNotesMoveNodeInput(
                  state.nodesById,
                  nodeId,
                  destinationId
                );
                if (input) {
                  runCommand(() => actions.moveNode(input, nodeId));
                  return { ok: true } as const;
                }
                return {
                  ok: false,
                  error: "That destination is no longer valid. Refresh Move To."
                } as const;
              }}
              onExpandAll={() => runCommand(() => actions.expandAll(nodeId))}
              onCollapseAll={() =>
                runCommand(() => actions.collapseAll(nodeId))
              }
              onSortAscending={() =>
                runCommand(() => actions.sortSubtreeAscending(nodeId))
              }
              onSortDescending={() =>
                runCommand(() => actions.sortSubtreeDescending(nodeId))
              }
              onRemoveNote={removeNote}
              onDuplicate={() =>
                runCommand(() => actions.duplicateNode(nodeId))
              }
              onExport={(format) =>
                exportController.startExport(
                  nodeId,
                  node.nodeKind === "image" ? label : titleValue,
                  format
                )
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
          {node.nodeKind === "image" ? (
            <div className="notes-page-primary">
              <h1
                className="notes-page-heading"
                aria-label={headingLabel}
              />
              <NotesImageNodeContent
                nodeId={nodeId}
                attachment={attachments[0]}
                originalName={titleValue || node.title}
                className="notes-page-primary-image"
                style={{ minWidth: 0 }}
                contentRef={imageRef}
                onKeyDown={readOnly ? undefined : handleImageKeyDown}
                readOnly={readOnly}
                disabled={disabled}
              />
            </div>
          ) : (
            <h1 className="notes-page-heading" aria-label={label}>
              <NoteTextField
                ref={titleRef}
                className="notes-page-title"
                containerClassName="notes-page-title-field"
                value={titleValue}
                aria-label="Edit page title"
                presentationAriaLabel={titlePresentationLabel}
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
                  titleSelectionRef.current = {
                    startUtf16: event.currentTarget.selectionStart,
                    endUtf16: event.currentTarget.selectionEnd
                  };
                }}
                onChange={(event) => {
                  resizeTextarea(event.currentTarget);
                  actions.updateNodeDraft(
                    nodeId,
                    {
                      title: event.target.value,
                      note: noteValue
                    },
                    "title"
                  );
                }}
                onBlur={(event) => {
                  titleSelectionRef.current = {
                    startUtf16: event.currentTarget.selectionStart,
                    endUtf16: event.currentTarget.selectionEnd
                  };
                  if (!datePicker.shouldSuppressBlur()) {
                    void actions.flushNodeDraft(nodeId);
                  }
                }}
              />
            </h1>
          )}
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
                      return;
                    }
                    const resolution = resolveSupportingNoteKey({
                      key: event.key,
                      altKey: event.altKey,
                      ctrlKey: event.ctrlKey,
                      metaKey: event.metaKey,
                      shiftKey: event.shiftKey,
                      selectionStart: event.currentTarget.selectionStart,
                      selectionEnd: event.currentTarget.selectionEnd,
                      value: event.currentTarget.value
                    });
                    if (!resolution) {
                      return;
                    }
                    event.preventDefault();
                    actions.updateNodeDraft(
                      nodeId,
                      { title: titleValue, note: event.currentTarget.value },
                      "note"
                    );
                    void actions.flushNodeDraft(nodeId);
                    void actions.focusNode(
                      supportingNoteFocusTarget(
                        resolution,
                        nodeId,
                        getVisibleNodeIds()
                      )
                    );
                  }
            }
            onFocus={() => {
              noteBlurredDuringCompositionRef.current = false;
              setRevealedNoteNodeId(nodeId);
            }}
            onChange={(event) => {
              setRevealedNoteNodeId(nodeId);
              resizeTextarea(event.currentTarget);
              actions.updateNodeDraft(nodeId, {
                title: titleValue,
                note: event.target.value
              }, "note");
            }}
            onBlur={(event) => {
              if (datePicker.shouldSuppressBlur()) {
                return;
              }
              if (noteComposingRef.current) {
                noteBlurredDuringCompositionRef.current = true;
                return;
              }
              settleNoteBlur(event.currentTarget.value);
            }}
            onCompositionStart={() => {
              noteComposingRef.current = true;
            }}
            onCompositionEnd={(event) => {
              noteComposingRef.current = false;
              if (
                !noteBlurredDuringCompositionRef.current ||
                document.activeElement === event.currentTarget
              ) {
                return;
              }
              noteBlurredDuringCompositionRef.current = false;
              settleNoteBlur(event.currentTarget.value, true);
            }}
          />
        )}
        {node.nodeKind === "text" ? (
          <NotesAttachmentList
            nodeId={nodeId}
            attachments={attachments}
            uploadError={attachmentUploadErrorsByNodeId?.[nodeId]}
            uploadRetryAttemptId={
              attachmentUploadRetryAttemptIdsByNodeId?.[nodeId]
            }
            className="notes-page-attachments"
            readOnly={readOnly || disabled}
          />
        ) : (
          <NotesImageUploadStatus
            nodeId={nodeId}
            uploadError={attachmentUploadErrorsByNodeId?.[nodeId]}
            uploadRetryAttemptId={
              attachmentUploadRetryAttemptIdsByNodeId?.[nodeId]
            }
            readOnly={readOnly || disabled}
          />
        )}
        {imageDropEnabled && showDropPlaceholder && (
          <span
            className="notes-image-drop-position"
            data-testid="notes-image-drop-position"
            aria-hidden="true"
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
