import { useSortable } from "@dnd-kit/sortable";
import {
  ChevronDown,
  ChevronRight
} from "lucide-react";
import {
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { IconTooltip } from "../../components/ui/Tooltip";
import {
  createNoteId,
  type NoteId
} from "../../domain/notes";
import { NotesAttachmentList } from "./NotesAttachmentList";
import {
  selectionRangeIds,
  type NotesSelection
} from "./notesWorkspaceReducer";
import {
  buildNotesMoveDestinations,
  buildNotesMoveNodeInput,
  NotesBulletMenu
} from "./NotesBulletMenu";
import { useNotesDatePickerIntegration } from "./NotesDatePickerIntegration";
import { useNotesExportController } from "./NotesExportController";
import {
  extractClipboardImages,
  type ClipboardImageExtraction
} from "./notesClipboardImages";
import { parsePastedOutline } from "./notesPasteImport";
import { NoteTextField } from "./NoteTextField";
import {
  useNotesActions,
  useNotesState
} from "./NotesWorkspaceContext";
import type { NotesWorkspaceCommandOutcome } from "./notesWorkspaceCoordinator";
import type {
  NotesNodeDraft,
  NotesPreparedMove
} from "./useNotesWorkspace";
import { resizeTextarea, useAutoGrowTextarea } from "./autoGrowTextarea";
import {
  detectOutlineShortcutPlatform,
  resolveNotesHistoryShortcut,
  resolveOutlineKey
} from "./outlineKeyboard";

interface OutlineNodeRowProps {
  nodeId: NoteId;
  depth: number;
  ancestorGuideDepths: readonly number[];
  visibleDescendantEndId: NoteId | null;
  // A stable accessor for the current visible-id list, rather than the array by
  // value — passing the array as a prop would churn its identity every render
  // and defeat this component's memo.
  getVisibleNodeIds(): readonly NoteId[];
  // Stable accessor for the live multi-node selection, read at keydown/click time
  // to extend the head. The row never subscribes to the selection (it rides the
  // drafts slice the row does not read), so this preserves the row's memo.
  getSelection(): NotesSelection | null;
  // Atomic membership flag for the multi-node selection range, derived in the
  // pane from a stable id Set. A plain boolean so a range change re-renders only
  // the rows whose membership actually flipped.
  isSelected?: boolean;
  // Atomic drafts-slice reads, hoisted to props so the row does NOT subscribe to
  // the high-volatility drafts context. A keystroke in another row therefore
  // leaves these props referentially unchanged and the memo bails out.
  draft?: NotesNodeDraft;
  attachmentUploadError?: string;
  attachmentUploadRetryAttemptId?: string;
  dragDisabled: boolean;
  disabled?: boolean;
  readOnlyMode?: "archive" | "trash";
  locallyExpanded?: boolean;
  imageDropActive?: boolean;
  showDropPlaceholder?: boolean;
}

function controlLabel(title: string): string {
  return title.trim() || "Untitled node";
}

// Shown on the row when a structural command settles as "skipped" (a paused
// write, or a stale/closed session) so an Enter/Tab/Backspace does not vanish
// without explanation. Worded to match the pane's writeError banner (0.8).
const STRUCTURAL_COMMAND_SKIPPED_NOTICE =
  "Command paused — a recent change could not be saved. Retry the save to continue.";

function OutlineNodeRowComponent({
  nodeId,
  depth,
  ancestorGuideDepths,
  visibleDescendantEndId,
  getVisibleNodeIds,
  getSelection,
  isSelected = false,
  draft,
  attachmentUploadError,
  attachmentUploadRetryAttemptId,
  dragDisabled,
  disabled = false,
  readOnlyMode,
  locallyExpanded = false,
  imageDropActive = false,
  showDropPlaceholder = false
}: OutlineNodeRowProps) {
  const {
    actions,
    commitPreparedMove,
    loadActiveNodesForMove,
    prepareMoveNode,
    retryFailedDraft
  } = useNotesActions();
  const { activeTagFilters, state } = useNotesState();
  const exportController = useNotesExportController();
  const node = state.nodesById[nodeId];
  const readOnly = readOnlyMode !== undefined;
  const imageDropEnabled =
    !disabled &&
    !readOnly &&
    state.status !== "loading" &&
    actions.importDroppedImagePaths !== undefined;
  const clipboardImportEnabled =
    !disabled &&
    !readOnly &&
    state.status !== "loading" &&
    actions.importClipboardImages !== undefined;
  // Paste import (plan Phase 4.4): a multi-line indented plain-text paste
  // becomes a subtree of new children under the focused row instead of a
  // single blob of text. Gated the same way clipboard image import is.
  const subtreeImportEnabled =
    !disabled && !readOnly && state.status !== "loading";
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition
  } = useSortable({
    id: nodeId,
    disabled: disabled || dragDisabled || readOnly,
    attributes: {
      role: "button",
      roleDescription: "sortable note",
      tabIndex: 0
    }
  });
  const [noteOpen, setNoteOpen] = useState(() =>
    Boolean((draft?.note ?? node?.note ?? "").trim())
  );
  const [structuralCommandBusy, setStructuralCommandBusy] = useState(false);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const titleSelectionRef = useRef<{
    startUtf16: number;
    endUtf16: number;
  } | null>(null);
  const focusedPendingIdRef = useRef<NoteId | null>(null);
  const focusNoteOnOpenRef = useRef(false);
  const preparedMoveRef = useRef<NotesPreparedMove | null>(null);
  const structuralCommandInFlightRef = useRef(false);
  const suppressedBlurPatchRef = useRef<{
    title: string;
    note: string;
  } | null>(null);
  const titleValue = draft?.title ?? node?.title ?? "";
  const noteValue = draft?.note ?? node?.note ?? "";
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
  useAutoGrowTextarea(noteRef, noteValue, noteOpen);

  useEffect(() => {
    if (state.pendingFocusId !== nodeId) {
      focusedPendingIdRef.current = null;
      return;
    }
    // A read-only row (archive/trash) renders no editable textarea; wait until
    // it becomes editable. `readOnly` in the deps re-runs this once editability
    // flips so focus lands after a restore — previously an incidental `actions`
    // identity churn (now removed) provided that retry.
    if (readOnly) {
      return;
    }
    if (focusedPendingIdRef.current === nodeId) {
      return;
    }
    if (state.pendingFocusField === "note" && !noteOpen) {
      setNoteOpen(true);
      return;
    }
    const target =
      state.pendingFocusField === "note" ? noteRef.current : titleRef.current;
    if (!target) {
      return;
    }
    target.focus();
    if (document.activeElement !== target) {
      return;
    }
    focusedPendingIdRef.current = nodeId;
    void actions.acknowledgeFocus(nodeId);
  }, [
    actions,
    nodeId,
    noteOpen,
    readOnly,
    state.pendingFocusField,
    state.pendingFocusId
  ]);

  useLayoutEffect(() => {
    if (!noteOpen || !noteRef.current) {
      return;
    }
    if (focusNoteOnOpenRef.current) {
      focusNoteOnOpenRef.current = false;
      noteRef.current.focus();
    }
  }, [noteOpen]);

  if (!node) {
    return null;
  }

  const label = controlLabel(titleValue || node.title);
  const hasChildren = (state.childIdsByParent[nodeId]?.length ?? 0) > 0;
  const completed = node.completedAt !== null;
  const isCollapsed = node.isCollapsed && !locallyExpanded;
  const dragEnabled = !disabled && !dragDisabled && !readOnly;
  const rowStyle = {
    "--notes-depth": depth,
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX}) scaleY(${transform.scaleY})`
      : undefined,
    transition
  } as CSSProperties;
  const guides = ancestorGuideDepths.length > 0 && (
    <span
      className="notes-node-guides"
      aria-hidden="true"
      style={
        {
          "--notes-guide-count": ancestorGuideDepths.length
        } as CSSProperties
      }
    >
      {ancestorGuideDepths.map((guideDepth) => (
        <span
          className="notes-node-guide"
          aria-hidden="true"
          key={guideDepth}
        />
      ))}
    </span>
  );

  if (readOnly) {
    return (
      <div
        ref={setNodeRef}
        className="notes-node notes-node-readonly"
        data-outline-id={nodeId}
        data-guide-end-id={visibleDescendantEndId ?? undefined}
        data-selected={state.selectedId === nodeId ? "true" : undefined}
        data-range-selected={isSelected ? "true" : undefined}
        style={rowStyle}
      >
        {guides}
        <div className="notes-node-main notes-node-main-readonly">
          <div className="notes-node-menu-slot">
            {readOnlyMode === "trash" && (
              <NotesBulletMenu
                mode="trash"
                label={label}
                disabled={disabled}
                onRestore={() => void actions.restoreNode(nodeId)}
              />
            )}
          </div>
          <span className="notes-node-readonly-title">{label}</span>
        </div>
        {node.note.trim() && (
          <p className="notes-node-readonly-note">{node.note}</p>
        )}
        <NotesAttachmentList
          nodeId={nodeId}
          attachments={attachments}
          className="notes-node-attachments notes-node-attachments-readonly"
          readOnly
        />
      </div>
    );
  }

  const draftPatch = () => ({
    title: titleValue,
    note: noteValue
  });

  const draftToSave = (force = false) => {
    if (!force && !draft) {
      return undefined;
    }
    return draftPatch();
  };

  const saveDrafts = () => {
    if (!draft) {
      return;
    }
    void actions.flushNodeDraft(nodeId);
  };

  const suppressHandledBlur = () => {
    suppressedBlurPatchRef.current = draftPatch();
  };

  const commitDrafts = () => {
    const suppressedPatch = suppressedBlurPatchRef.current;
    suppressedBlurPatchRef.current = null;
    const patch = draftPatch();
    if (
      suppressedPatch?.title === patch.title &&
      suppressedPatch.note === patch.note
    ) {
      return;
    }
    saveDrafts();
  };

  const runStructuralCommand = (
    command: () => Promise<NotesWorkspaceCommandOutcome | void>
  ) => {
    if (structuralCommandInFlightRef.current) {
      return;
    }
    structuralCommandInFlightRef.current = true;
    setStructuralCommandBusy(true);
    setCommandNotice(null);
    // Remember the caret so a dropped command can hand focus back rather than
    // stranding it, e.g. after Enter blurs the title on the way to a split.
    const focusedBeforeCommand =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    let completion: Promise<NotesWorkspaceCommandOutcome | void>;
    try {
      completion = command();
    } catch {
      structuralCommandInFlightRef.current = false;
      setStructuralCommandBusy(false);
      return;
    }
    const settle = (outcome: NotesWorkspaceCommandOutcome | void) => {
      structuralCommandInFlightRef.current = false;
      setStructuralCommandBusy(false);
      if (outcome === "skipped") {
        const restoreTarget =
          focusedBeforeCommand?.isConnected === true
            ? focusedBeforeCommand
            : titleRef.current;
        restoreTarget?.focus();
        setCommandNotice(STRUCTURAL_COMMAND_SKIPPED_NOTICE);
      }
    };
    void completion.then(settle, settle);
  };

  const openAndFocusNote = () => {
    focusNoteOnOpenRef.current = true;
    setNoteOpen(true);
    if (noteOpen && noteRef.current) {
      focusNoteOnOpenRef.current = false;
      noteRef.current.focus();
    }
  };

  const removeNote = () => {
    setNoteOpen(false);
    actions.updateNodeDraft(nodeId, { title: titleValue, note: "" }, "note");
    void actions.flushNodeDraft(nodeId);
  };

  // Returns true when the paste was handled (clipboard images win — plan
  // Phase 0.5) so the caller does not also try a subtree import or fall
  // through to a normal text paste.
  const handleImagePaste = (
    event: ClipboardEvent<HTMLTextAreaElement>
  ): boolean => {
    if (!clipboardImportEnabled) {
      return false;
    }
    const clipboardData = event.clipboardData;
    if (!clipboardData) {
      return false;
    }
    let extraction: ClipboardImageExtraction;
    try {
      extraction = extractClipboardImages(clipboardData.items);
    } catch (cause) {
      console.error("Failed to read pasted clipboard images", cause);
      return false;
    }
    if (extraction.kind !== "images" || extraction.items.length === 0) {
      if (extraction.kind === "error") {
        console.error(extraction.message);
      }
      return false;
    }
    event.preventDefault();
    void actions.importClipboardImages?.(nodeId, extraction.items);
    return true;
  };

  // Plan Phase 4.4b: a multi-line indented plain-text paste becomes a
  // subtree of new children under this row (appended after any existing
  // children), imported as one undo step. A single line, or text that does
  // not parse to more than one node, is left to fall through to the normal
  // text paste. Returns true when handled.
  const handleSubtreeImportPaste = (
    event: ClipboardEvent<HTMLTextAreaElement>
  ): boolean => {
    if (!subtreeImportEnabled) {
      return false;
    }
    const clipboardData = event.clipboardData;
    if (!clipboardData) {
      return false;
    }
    const text = clipboardData.getData("text/plain");
    if (!text) {
      return false;
    }
    const nodes = parsePastedOutline(text);
    if (!nodes || nodes.length === 0) {
      return false;
    }
    event.preventDefault();
    const existingChildIds = state.childIdsByParent[nodeId] ?? [];
    const afterId = existingChildIds.at(-1) ?? null;
    runStructuralCommand(() => actions.importSubtree(nodeId, afterId, nodes));
    return true;
  };

  // Paste dispatch order (plan Phase 4.4b): clipboard image import (0.5)
  // always wins when the clipboard carries an image, then a multi-line
  // structural paste is tried, and only then does the event fall through to
  // the textarea's default text paste.
  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (handleImagePaste(event)) {
      return;
    }
    handleSubtreeImportPaste(event);
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
      visibleNodeIds: getVisibleNodeIds(),
      selection: getSelection()
    });
    if (!resolution) {
      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault();
      }
      return;
    }

    event.preventDefault();
    // Selection edits and caret moves are cheap and safe mid-command; only
    // structural commands must wait for the in-flight one to settle.
    if (
      resolution.type !== "focus" &&
      resolution.type !== "extendSelection" &&
      resolution.type !== "clearSelection" &&
      structuralCommandInFlightRef.current
    ) {
      return;
    }
    switch (resolution.type) {
      case "split": {
        let newNodeId: NoteId;
        try {
          newNodeId = createNoteId();
        } catch {
          return;
        }
        runStructuralCommand(() => {
          const patch = draftToSave();
          suppressHandledBlur();
          return actions.splitNode(
            nodeId,
            newNodeId,
            resolution.prefix,
            resolution.suffix,
            {
              draft: patch
            }
          );
        });
        return;
      }
      case "move": {
        runStructuralCommand(() => {
          const patch = draftToSave();
          suppressHandledBlur();
          return actions.moveNode(resolution.input, resolution.focusNodeId, {
            draft: patch,
            expandNodeId: resolution.expandNodeId
          });
        });
        return;
      }
      case "focus":
        saveDrafts();
        suppressHandledBlur();
        void actions.focusNode(resolution.nodeId);
        return;
      case "extendSelection":
        // Anchor the range at this row (the caret's node) the first time it is
        // extended; subsequent extensions pin that anchor and only move the head.
        if (!getSelection()) {
          actions.setSelectionAnchor(nodeId);
        }
        actions.extendSelectionTo(resolution.headId);
        return;
      case "clearSelection":
        actions.clearSelection();
        return;
      case "batchComplete":
        // Whole-selection batch (plan Phase 4.1c): one applyBatch call, one undo
        // step. The selection clears automatically via the command's loading
        // dispatch. The materialized ids were captured at keydown time.
        runStructuralCommand(() =>
          actions.applyBatch(resolution.nodeIds, {
            type: "complete",
            completed: resolution.completed
          })
        );
        return;
      case "batchDelete":
        runStructuralCommand(() =>
          actions.applyBatch(
            resolution.nodeIds,
            { type: "delete" },
            { focusNodeId: resolution.focusNodeId }
          )
        );
        return;
      case "batchIndent":
        runStructuralCommand(() =>
          actions.applyBatch(resolution.nodeIds, { type: "indent" })
        );
        return;
      case "batchOutdent":
        runStructuralCommand(() =>
          actions.applyBatch(resolution.nodeIds, { type: "outdent" })
        );
        return;
      case "focusNote":
        openAndFocusNote();
        return;
      case "toggleComplete":
        runStructuralCommand(() => actions.toggleComplete(nodeId));
        return;
      case "duplicate":
        runStructuralCommand(() => actions.duplicateNode(nodeId));
        return;
      case "delete":
        runStructuralCommand(() => actions.deleteNode(nodeId));
        return;
      case "toggleCollapsed":
        runStructuralCommand(() => actions.toggleCollapsed(nodeId));
        return;
      case "remove": {
        runStructuralCommand(() => {
          const patch = draftToSave(true)!;
          suppressHandledBlur();
          return actions.removeEmptyNode(nodeId, resolution.focusNodeId, {
            draft: patch
          });
        });
      }
    }
  };

  return (
    <div
      ref={setNodeRef}
      className="notes-node"
      data-outline-id={nodeId}
      data-completed={completed ? "true" : undefined}
      data-dragging={isDragging ? "true" : undefined}
      data-guide-end-id={visibleDescendantEndId ?? undefined}
      data-selected={state.selectedId === nodeId ? "true" : undefined}
      data-range-selected={isSelected ? "true" : undefined}
      data-notes-attachment-target={imageDropEnabled ? nodeId : undefined}
      data-image-drop-active={
        imageDropEnabled && imageDropActive ? "true" : undefined
      }
      style={rowStyle}
    >
      {guides}
      <div className="notes-node-main">
        <div className="notes-node-menu-slot">
          <NotesBulletMenu
            label={label}
            completed={completed}
            starred={node.isStarred}
            hasNote={Boolean(noteValue.trim())}
            saveFailed={draft?.status === "failed"}
            disabled={disabled}
            actionBusy={structuralCommandBusy}
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
                    Object.fromEntries(nodes.map((item) => [item.id, item])),
                    nodeId
                  )
                )
                .catch(() =>
                  buildNotesMoveDestinations(state.nodesById, nodeId)
                );
            }}
            exportDisabled={exportController.unavailable || exportController.busy}
            onToggleComplete={() =>
              runStructuralCommand(() => actions.toggleComplete(nodeId))
            }
            onToggleStar={() =>
              runStructuralCommand(() => actions.toggleStar(nodeId))
            }
            onOpenNote={openAndFocusNote}
            onAddDate={() => {
              datePicker.openTitleDate(titleSelectionRef.current ?? undefined);
              titleSelectionRef.current = null;
            }}
            onUploadImage={
              actions.uploadImage
                ? () => void actions.uploadImage?.(nodeId)
                : undefined
            }
            onMoveTo={(destinationId) => {
              // With a live multi-node selection that includes this row, Move To
              // relocates the WHOLE selection as one block (plan Phase 4.1c):
              // every selected root becomes a child of the destination, appended
              // after its last non-selected child. One applyBatch call, one undo
              // step.
              const selection = getSelection();
              const rangeIds = selection
                ? selectionRangeIds(selection, getVisibleNodeIds())
                : [];
              if (rangeIds.length > 1 && rangeIds.includes(nodeId)) {
                const selected = new Set(rangeIds);
                const destinationChildren =
                  destinationId === null
                    ? state.rootIds
                    : (state.childIdsByParent[destinationId] ?? []);
                let afterId: NoteId | null = null;
                for (let i = destinationChildren.length - 1; i >= 0; i -= 1) {
                  if (!selected.has(destinationChildren[i])) {
                    afterId = destinationChildren[i];
                    break;
                  }
                }
                runStructuralCommand(() =>
                  actions.applyBatch(rangeIds, {
                    type: "move",
                    parentId: destinationId,
                    afterId
                  })
                );
                return { ok: true } as const;
              }
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
                runStructuralCommand(() => actions.moveNode(input, nodeId));
                return { ok: true } as const;
              }
              return {
                ok: false,
                error: "That destination is no longer valid. Refresh Move To."
              } as const;
            }}
            onExpandAll={() =>
              runStructuralCommand(() => actions.expandAll(nodeId))
            }
            onCollapseAll={() =>
              runStructuralCommand(() => actions.collapseAll(nodeId))
            }
            onSortAscending={() =>
              runStructuralCommand(() => actions.sortSubtreeAscending(nodeId))
            }
            onSortDescending={() =>
              runStructuralCommand(() => actions.sortSubtreeDescending(nodeId))
            }
            onRemoveNote={removeNote}
            onDuplicate={() =>
              runStructuralCommand(() => actions.duplicateNode(nodeId))
            }
            onExport={(format) =>
              exportController.startExport(nodeId, titleValue, format)
            }
            onDelete={() =>
              runStructuralCommand(() => actions.deleteNode(nodeId))
            }
            onRetrySave={() =>
              runStructuralCommand(() => retryFailedDraft(nodeId))
            }
          />
        </div>

        <span className="notes-node-arrow-slot">
          {hasChildren && (
            <IconTooltip label={isCollapsed ? "Expand" : "Collapse"}>
              <button
                className="notes-row-icon-button notes-collapse-button"
                type="button"
                aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${label}`}
                aria-expanded={!isCollapsed}
                disabled={disabled}
                onClick={() =>
                  runStructuralCommand(() => actions.toggleCollapsed(nodeId))
                }
              >
                {isCollapsed ? (
                  <ChevronRight size={12} aria-hidden="true" />
                ) : (
                  <ChevronDown size={12} aria-hidden="true" />
                )}
              </button>
            </IconTooltip>
          )}
        </span>

        <button
          ref={setActivatorNodeRef}
          className="notes-node-bullet"
          type="button"
          {...(dragEnabled ? attributes : {})}
          {...(dragEnabled ? listeners : {})}
          aria-label={`Zoom into ${label}`}
          disabled={disabled}
          data-collapsed={hasChildren && isCollapsed ? "true" : undefined}
          data-sortable-activator={dragEnabled ? "true" : undefined}
          onClick={(event) => {
            // Shift+Click extends the multi-node selection to this row (head),
            // anchoring at the current caret node the first time. A plain click
            // still zooms.
            if (event.shiftKey) {
              event.preventDefault();
              if (!getSelection()) {
                actions.setSelectionAnchor(state.selectedId ?? nodeId);
              }
              actions.extendSelectionTo(nodeId);
              return;
            }
            void actions.zoomTo(nodeId);
          }}
        >
          <span className="notes-node-bullet-dot" aria-hidden="true" />
        </button>

        <NoteTextField
          placeCaretFromPointer
          className="notes-node-title"
          containerClassName="notes-node-title-field"
          ref={titleRef}
          value={titleValue}
          aria-label="Edit node title"
          placeholder="Untitled"
          rows={1}
          wrap="soft"
          disabled={disabled}
          today={datePicker.today}
          onDateClick={
            disabled
              ? undefined
              : (token, anchor) =>
                  datePicker.openExistingDate("title", token, anchor)
          }
          onDateTrigger={
            disabled
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
          onChange={(event) => {
            resizeTextarea(event.currentTarget);
            actions.updateNodeDraft(nodeId, {
              title: event.target.value,
              note: noteValue
            }, "title")
          }}
          onKeyDown={handleTitleKeyDown}
          onPaste={handlePaste}
          onSelect={(event) => {
            titleSelectionRef.current = {
              startUtf16: event.currentTarget.selectionStart,
              endUtf16: event.currentTarget.selectionEnd
            };
          }}
          onBlur={(event) => {
            titleSelectionRef.current = {
              startUtf16: event.currentTarget.selectionStart,
              endUtf16: event.currentTarget.selectionEnd
            };
            if (!datePicker.shouldSuppressBlur()) {
              commitDrafts();
            }
          }}
        />
      </div>

      {commandNotice && (
        <p className="notes-node-command-notice" role="alert">
          {commandNotice}
        </p>
      )}

      {noteOpen && (
        <NoteTextField
          ref={noteRef}
          className="notes-node-note"
          containerClassName="notes-node-note-field"
          value={noteValue}
          aria-label={`Supporting note: ${label}`}
          rows={2}
          disabled={disabled}
          today={datePicker.today}
          onDateClick={
            disabled
              ? undefined
              : (token, anchor) =>
                  datePicker.openExistingDate("note", token, anchor)
          }
          onDateTrigger={
            disabled
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
          onKeyDown={(event) => {
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
          }}
          onChange={(event) => {
            resizeTextarea(event.currentTarget);
            actions.updateNodeDraft(nodeId, {
              title: titleValue,
              note: event.target.value
            }, "note");
          }}
          onPaste={handlePaste}
          onBlur={() => {
            if (!datePicker.shouldSuppressBlur()) {
              commitDrafts();
            }
          }}
        />
      )}
      <NotesAttachmentList
        nodeId={nodeId}
        attachments={attachments}
        uploadError={attachmentUploadError}
        uploadRetryAttemptId={attachmentUploadRetryAttemptId}
        className="notes-node-attachments"
        readOnly={disabled}
        showDropPlaceholder={imageDropEnabled && showDropPlaceholder}
      />
      {datePicker.picker}
    </div>
  );
}

// Memoized so a draft keystroke in one row (which re-renders the pane shell and
// re-creates every row element) only re-renders the row whose atomic props
// actually changed. All props are primitives, referentially stable objects, or
// stable callbacks; the drafts context is read at the pane and passed down as
// the `draft`/attachment props so sibling rows keep identical props and bail.
export const OutlineNodeRow = memo(OutlineNodeRowComponent);
