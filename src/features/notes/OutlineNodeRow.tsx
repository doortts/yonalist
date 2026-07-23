import { useSortable } from "@dnd-kit/sortable";
import {
  ChevronDown,
  ChevronRight
} from "lucide-react";
import {
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { IconTooltip } from "../../components/ui/Tooltip";
import {
  createNoteId,
  type NoteId
} from "../../domain/notes";
import { GITHUB_NOTIFICATIONS_ROOT_ID } from "../../services/githubNotificationsProvider";
import { NotesAttachmentList } from "./NotesAttachmentList";
import {
  isValidNotesImageAttachmentMetadata,
  NotesImageNodeContent
} from "./NotesImageAttachment";
import {
  ImageAtomEditor,
  type ImageAtomEditorCutRequest,
  type ImageAtomEditorHandle
} from "./ImageAtomEditor";
import { NotesImageUploadStatus } from "./NotesImageUploadStatus";
import {
  noteNodeNavigationLabel,
  noteNodePresentationLabel
} from "./notesPresentation";
import type { NotesSelectionActionIntent } from "./notesSelectionActions";
import type { NotesSelection } from "./notesWorkspaceReducer";
import {
  buildNotesMoveDestinations,
  buildNotesMoveNodeInput,
  NotesBulletMenu,
  type NotesBulletMenuSelectionBridge
} from "./NotesBulletMenu";
import { useNotesDatePickerIntegration } from "./NotesDatePickerIntegration";
import { useNotesExportController } from "./NotesExportController";
import {
  parseNotesImageAtomPaste,
  readNotesImageAtomPasteCandidate
} from "./notesImageAtomClipboard";
import {
  extractClipboardImages,
  type ClipboardImageExtraction
} from "./notesClipboardImages";
import { parsePastedOutline } from "./notesPasteImport";
import {
  NoteTextField,
  restoreTextareaPrimarySelection
} from "./NoteTextField";
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
  resolveOutlineKey,
  resolveSupportingNoteKey,
  supportingNoteFocusTarget
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
  // Selection intentionally has a narrower visible domain while zoomed: the
  // page header participates in ordinary caret navigation but is not an
  // ordinary selectable body row. Keep this accessor stable for row memo.
  getSelectionVisibleNodeIds(): readonly NoteId[];
  // Stable accessor for the live multi-node selection, read at keydown/click time
  // to extend the head. The row never subscribes to the selection (it rides the
  // drafts slice the row does not read), so this preserves the row's memo.
  getSelection(): NotesSelection | null;
  // Stable pane-owned semantic bridge. Keyboard selection shortcuts never
  // decide targets or mutate the workspace inside a row.
  onSelectionAction(action: NotesSelectionActionIntent): void;
  selectionBridge?: NotesBulletMenuSelectionBridge;
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
  dragDisabledReason?: string;
  onDragDisabledAttempt?: () => void;
  suppressDragPresentation?: boolean;
  disabled?: boolean;
  readOnlyMode?: "archive" | "trash";
  pluginRoot?: boolean;
  selectionDisabled?: boolean;
  locallyExpanded?: boolean;
  imageDropActive?: boolean;
  showDropPlaceholder?: boolean;
}

// Shown on the row when a structural command settles as "skipped" (a paused
// write, or a stale/closed session) so an Enter/Tab/Backspace does not vanish
// without explanation. Worded to match the pane's writeError banner (0.8).
const STRUCTURAL_COMMAND_SKIPPED_NOTICE =
  "Command paused — a recent change could not be saved. Retry the save to continue.";
const OUTLINE_SELECTION_INTERACTIVE_SELECTOR =
  "button, a, [role='button'], [role='separator'], .notes-attachment-list, .notes-attachment-error";
const OUTLINE_NATIVE_SELECTION_CONTROL_SELECTOR =
  "input, select, textarea, [contenteditable='true'], [data-image-atom-interactive]";
const OUTLINE_NATIVE_SELECTION_SURFACE_SELECTOR =
  "[data-notes-native-selection-surface='true']";

export function isOutlineSelectionInteractiveTarget(
  target: EventTarget | null
): boolean {
  if (!(target instanceof Element)) return false;
  const surface = target.closest(OUTLINE_NATIVE_SELECTION_SURFACE_SELECTOR);
  if (surface) {
    const control = target.closest(
      `${OUTLINE_SELECTION_INTERACTIVE_SELECTOR}, ${OUTLINE_NATIVE_SELECTION_CONTROL_SELECTOR}`
    );
    return control !== null && surface.contains(control);
  }
  return target.closest(OUTLINE_SELECTION_INTERACTIVE_SELECTOR) !== null;
}

export function isOutlineSelectionTextSurface(
  target: EventTarget | null
): boolean {
  return (
    target instanceof Element &&
    !isOutlineSelectionInteractiveTarget(target) &&
    Boolean(
      target.closest(
        `${OUTLINE_NATIVE_SELECTION_SURFACE_SELECTOR}, .notes-node-title-field, .notes-node-note-field`
      )
    )
  );
}

export function isOutlineSelectionToggleModifier(event: {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}): boolean {
  return detectOutlineShortcutPlatform() === "mac"
    ? event.metaKey
    : event.ctrlKey;
}

function OutlineNodeRowComponent({
  nodeId,
  depth,
  ancestorGuideDepths,
  visibleDescendantEndId,
  getVisibleNodeIds,
  getSelectionVisibleNodeIds,
  getSelection,
  onSelectionAction,
  selectionBridge,
  isSelected = false,
  draft,
  attachmentUploadError,
  attachmentUploadRetryAttemptId,
  dragDisabled,
  dragDisabledReason,
  onDragDisabledAttempt,
  suppressDragPresentation = false,
  disabled = false,
  readOnlyMode,
  pluginRoot = false,
  selectionDisabled = false,
  locallyExpanded = false,
  imageDropActive = false,
  showDropPlaceholder = false
}: OutlineNodeRowProps) {
  const {
    actions,
    commitPreparedMove,
    loadActiveNodesForMove,
    prepareMoveNode,
    retryFailedDraft,
    registerActiveImageAtomEditor,
    captureActiveImageAtomEditorAuthority,
    captureImageAtomCutAuthority,
    applyImageAtomCutWithAuthority,
    captureImageAtomPasteAuthority,
    isImageAtomPasteAuthorityCurrent,
    applyImageAtomPasteWithAuthority
  } = useNotesActions();
  const {
    activeTagFilters,
    libraryView,
    pendingPrimarySelection,
    state
  } = useNotesState();
  const exportController = useNotesExportController();
  const node = state.nodesById[nodeId];
  const readOnly = readOnlyMode !== undefined;
  const imageIngestEnabled =
    !selectionDisabled &&
    !disabled &&
    !readOnly &&
    state.status !== "loading";
  const imageIngestEnabledRef = useRef(imageIngestEnabled);
  imageIngestEnabledRef.current = imageIngestEnabled;
  // Line B widened the attachment target so a node is a valid drop AND
  // clipboard-paste target; keep that here while OURS' per-action gates below
  // still drive the individual import handlers.
  const imageAttachmentTargetEnabled =
    imageIngestEnabled &&
    (actions.importDroppedImagePaths !== undefined ||
      actions.importClipboardImages !== undefined);
  const imageDropEnabled =
    imageIngestEnabled && actions.importDroppedImagePaths !== undefined;
  const clipboardImportEnabled =
    imageIngestEnabled && actions.importClipboardImages !== undefined;
  // Paste import (plan Phase 4.4): a multi-line indented plain-text paste
  // becomes a subtree of new children under the focused row instead of a
  // single blob of text. Gated the same way clipboard image import is.
  const subtreeImportEnabled = imageIngestEnabled;
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
  const [trashConfirmOpen, setTrashConfirmOpen] = useState(false);
  const [structuralCommandBusy, setStructuralCommandBusy] = useState(false);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const imageRef = useRef<HTMLDivElement>(null);
  const imageEditorRef = useRef<ImageAtomEditorHandle>(null);
  const titleSelectionRef = useRef<{
    startUtf16: number;
    endUtf16: number;
  } | null>(null);
  const focusedPendingIdRef = useRef<number | null>(null);
  const pendingFocusInProgressRef = useRef(false);
  const focusNoteOnOpenRef = useRef(false);
  const dateNoteOnOpenRef = useRef(false);
  const noteComposingRef = useRef(false);
  const noteBlurredDuringCompositionRef = useRef(false);
  const disabledDragAttemptCleanupRef = useRef<(() => void) | null>(null);
  const suppressNextPointerClickRef = useRef(false);
  const preparedMoveRef = useRef<NotesPreparedMove | null>(null);
  const structuralCommandInFlightRef = useRef(false);
  const shiftClickAnchorRef = useRef<NoteId | null | undefined>(undefined);
  const suppressedBlurPatchRef = useRef<{
    title: string;
    note: string;
  } | null>(null);
  const titleValue = draft?.title ?? node?.title ?? "";
  const noteValue = draft?.note ?? node?.note ?? "";
  const imageOffsetUtf16 = draft?.imageOffsetUtf16 ?? node?.imageOffsetUtf16 ?? 0;
  const attachments = state.attachmentsByNodeId?.[nodeId] ?? [];
  const primaryImageAttachment =
    node?.nodeKind === "image" &&
    attachments.length === 1 &&
    isValidNotesImageAttachmentMetadata(attachments[0]!)
      ? attachments[0]!
      : null;
  const datePicker = useNotesDatePickerIntegration({
    values: { title: titleValue, note: noteValue },
    refs: { title: titleRef, note: noteRef },
    onCommit: (field, value, replacement) => {
      const nextImageOffsetUtf16 =
        node?.nodeKind === "image" &&
        field === "title" &&
        replacement.endUtf16 <= imageOffsetUtf16
          ? imageOffsetUtf16 +
            replacement.text.length -
            (replacement.endUtf16 - replacement.startUtf16)
          : imageOffsetUtf16;
      actions.updateNodeDraft(
        nodeId,
        field === "title"
          ? { title: value, note: noteValue, imageOffsetUtf16: nextImageOffsetUtf16 }
          : { title: titleValue, note: value, imageOffsetUtf16: nextImageOffsetUtf16 },
        field
      );
      void actions.flushNodeDraft(nodeId);
    }
  });

  useEffect(
    () => () => disabledDragAttemptCleanupRef.current?.(),
    []
  );

  const activeSelectionRowId = (): NoteId | null => {
    const activeRow =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.closest<HTMLElement>("[data-outline-id]")
        : null;
    const activeRowId = activeRow?.dataset.outlineId;
    return activeRowId && getSelectionVisibleNodeIds().includes(activeRowId)
      ? activeRowId
      : null;
  };

  const extendSelectionToThisRow = (anchorId: NoteId | null): void => {
    if (!getSelection()) {
      const selectionVisibleIds = getSelectionVisibleNodeIds();
      const fallbackRowId =
        state.selectedId !== null &&
        selectionVisibleIds.includes(state.selectedId)
          ? state.selectedId
          : nodeId;
      actions.setSelectionAnchor(anchorId ?? fallbackRowId);
    }
    actions.extendSelectionTo(nodeId);
  };

  const handleSelectionPointerDownCapture = (
    event: PointerEvent<HTMLDivElement>
  ): void => {
    if (event.button !== 0 || !isOutlineSelectionTextSurface(event.target)) {
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      extendSelectionToThisRow(activeSelectionRowId());
      return;
    }
    if (isOutlineSelectionToggleModifier(event)) {
      event.preventDefault();
      actions.toggleSelectionNode(nodeId, getSelectionVisibleNodeIds());
      return;
    }
    if (getSelection()) {
      actions.clearSelection();
    }
  };

  const trackDisabledDragAttempt = (
    event: PointerEvent<HTMLButtonElement>
  ): void => {
    if (event.button === 0) {
      suppressNextPointerClickRef.current = false;
    }
    if (
      dragEnabled ||
      !onDragDisabledAttempt ||
      event.button !== 0 ||
      event.shiftKey
    ) {
      return;
    }
    disabledDragAttemptCleanupRef.current?.();
    const { clientX, clientY, pointerId } = event;
    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", cleanup, true);
      window.removeEventListener("pointercancel", cleanup, true);
      if (disabledDragAttemptCleanupRef.current === cleanup) {
        disabledDragAttemptCleanupRef.current = null;
      }
    };
    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      if (
        moveEvent.pointerId === pointerId &&
        Math.hypot(
          moveEvent.clientX - clientX,
          moveEvent.clientY - clientY
        ) >= 4
      ) {
        suppressNextPointerClickRef.current = true;
        cleanup();
        onDragDisabledAttempt();
      }
    };
    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", cleanup, true);
    window.addEventListener("pointercancel", cleanup, true);
    disabledDragAttemptCleanupRef.current = cleanup;
  };

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
    const replaySelection =
      pendingPrimarySelection?.nodeId === nodeId &&
      pendingPrimarySelection.field === "title"
        ? pendingPrimarySelection
        : null;
    const focusRequestId = replaySelection?.requestId ?? 0;
    if (focusedPendingIdRef.current === focusRequestId) {
      return;
    }
    if (state.pendingFocusField === "note" && !noteOpen) {
      setNoteOpen(true);
      return;
    }
    const target =
      state.pendingFocusField === "note"
        ? noteRef.current
        : node?.nodeKind === "image"
          ? imageRef.current
          : titleRef.current;
    if (!target) {
      return;
    }
    // This focus is the command's own pending-focus postcondition. Do not
    // report it as a newer user navigation and invalidate its ownership.
    let focused = false;
    pendingFocusInProgressRef.current = true;
    try {
      if (replaySelection && node?.nodeKind === "image") {
        focused = imageEditorRef.current?.focus(replaySelection.selection) ?? false;
      } else {
        target.focus();
        focused = document.activeElement === target;
        if (focused && replaySelection && target instanceof HTMLTextAreaElement) {
          focused = restoreTextareaPrimarySelection(target, replaySelection.selection);
        }
      }
    } finally {
      pendingFocusInProgressRef.current = false;
    }
    if (!focused) {
      return;
    }
    focusedPendingIdRef.current = focusRequestId;
    void (replaySelection
      ? actions.acknowledgeFocus(nodeId, replaySelection.requestId)
      : actions.acknowledgeFocus(nodeId));
  }, [
    actions,
    nodeId,
    node?.nodeKind,
    noteOpen,
    pendingPrimarySelection,
    readOnly,
    state.pendingFocusField,
    state.pendingFocusId
  ]);

  useLayoutEffect(() => {
    if (!noteOpen || !noteRef.current) {
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
  }, [datePicker, noteOpen]);

  if (!node) {
    return null;
  }

  const label = noteNodePresentationLabel(
    node,
    titleValue || node.title,
    "Untitled node"
  );
  const navigationLabel = noteNodeNavigationLabel(
    node,
    titleValue || node.title,
    "Untitled node"
  );
  const hasChildren =
    pluginRoot || (state.childIdsByParent[nodeId]?.length ?? 0) > 0;
  const completed = node.completedAt !== null;
  const isCollapsed = node.isCollapsed && !locallyExpanded;
  const dragEnabled = !disabled && !dragDisabled && !readOnly;
  const dragPresentationActive = isDragging && !suppressDragPresentation;
  const rowStyle = {
    "--notes-depth": depth,
    transform: !suppressDragPresentation && transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX}) scaleY(${transform.scaleY})`
      : undefined,
    transition: suppressDragPresentation ? undefined : transition
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
                label={navigationLabel}
                disabled={disabled}
                onRestore={() => void actions.restoreNode(nodeId)}
              />
            )}
          </div>
          {node.nodeKind === "image" ? (
            primaryImageAttachment ? (
              <div style={{ gridColumn: 2, minWidth: 0 }}>
                <ImageAtomEditor
                  ref={imageEditorRef}
                  nodeId={nodeId}
                  draft={{ title: titleValue, note: noteValue, imageOffsetUtf16 }}
                  attachment={primaryImageAttachment}
                  onDraftChange={() => undefined}
                  registerFlushAdapter={actions.registerImageAtomFlushAdapter}
                  registerActiveEditor={registerActiveImageAtomEditor}
                  className="notes-node-primary-image"
                  contentRef={imageRef}
                  readOnly
                  disabled={disabled}
                />
              </div>
            ) : (
              <NotesImageNodeContent
                nodeId={nodeId}
                attachment={attachments[0]}
                originalName={titleValue || node.title}
                className="notes-node-primary-image"
                style={{ gridColumn: 2, minWidth: 0 }}
                readOnly
                disabled={disabled}
              />
            )
          ) : (
            <span className="notes-node-readonly-title">{label}</span>
          )}
        </div>
        {node.note.trim() && (
          <p className="notes-node-readonly-note">{node.note}</p>
        )}
        {node.nodeKind === "text" && (
          <NotesAttachmentList
            nodeId={nodeId}
            attachments={attachments}
            className="notes-node-attachments notes-node-attachments-readonly"
            readOnly
          />
        )}
        {node.nodeKind === "image" && (
          <NotesImageUploadStatus
            nodeId={nodeId}
            uploadError={attachmentUploadError}
            uploadRetryAttemptId={attachmentUploadRetryAttemptId}
            readOnly
          />
        )}
      </div>
    );
  }

  const draftPatch = () => ({
    title: titleValue,
    note: noteValue,
    imageOffsetUtf16
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

  const settleNoteBlur = (value: string, includeLiveValue = false) => {
    if (includeLiveValue) {
      const note = value.trim().length === 0 ? "" : value;
      if (note.length === 0) {
        setNoteOpen(false);
      }
      actions.updateNodeDraft(nodeId, { title: titleValue, note, imageOffsetUtf16 }, "note");
      void actions.flushNodeDraft(nodeId);
      return;
    }
    if (value.trim().length === 0) {
      setNoteOpen(false);
      if (value.length > 0) {
        actions.updateNodeDraft(nodeId, { title: titleValue, note: "", imageOffsetUtf16 }, "note");
      }
    }
    commitDrafts();
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
            : node.nodeKind === "image"
              ? imageRef.current
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

  const openNoteDate = () => {
    if (!noteRef.current) {
      dateNoteOnOpenRef.current = true;
      setNoteOpen(true);
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
    setNoteOpen(false);
    actions.updateNodeDraft(nodeId, { title: titleValue, note: "", imageOffsetUtf16 }, "note");
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
  // always wins when the clipboard carries an image, then — title only — a
  // multi-line structural paste is tried, and only then does the event fall
  // through to the textarea's default text paste. The note body is free
  // multi-line text (Workflowy semantics): a pasted indented outline there
  // must never spawn a child subtree, so `field` gates the subtree-import
  // branch to "title" while both fields still get the image-paste behavior.
  const handlePaste = (
    event: ClipboardEvent<HTMLTextAreaElement>,
    field: "title" | "note"
  ) => {
    if (handleImagePaste(event)) {
      return;
    }
    if (field === "title") {
      handleSubtreeImportPaste(event);
    }
  };

  const handleBulletKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
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
    if (dragEnabled) {
      listeners?.onKeyDown?.(event);
    } else if (
      onDragDisabledAttempt &&
      event.key === " " &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.repeat &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      onDragDisabledAttempt();
    }
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
      authoritativeWorkspace: libraryView === "all" ? state : undefined,
      visibleNodeIds: getVisibleNodeIds(),
      outdentBoundaryRootId: GITHUB_NOTIFICATIONS_ROOT_ID,
      selectionVisibleNodeIds: getSelectionVisibleNodeIds(),
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
        void (resolution.selection
          ? actions.focusNode(resolution.nodeId, resolution.selection)
          : actions.focusNode(resolution.nodeId));
        return;
      case "extendSelection":
        if (selectionDisabled) {
          return;
        }
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
      case "selectionAction":
        if (selectionDisabled) {
          return;
        }
        onSelectionAction(resolution.action);
        return;
      case "consumeSelectionShortcut":
        // Recognized selection chords are owned by the selection layer even
        // when they are a deliberate no-op (repeat or range boundary).
        return;
      case "consumeTabShortcut":
        // Tab/Shift+Tab remains owned by the outline at a structural boundary,
        // so the browser must not advance focus to another control.
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
      case "confirmDelete":
        setTrashConfirmOpen(true);
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
      workspace: state,
      visibleNodeIds: getVisibleNodeIds(),
      outdentBoundaryRootId: GITHUB_NOTIFICATIONS_ROOT_ID,
      selection: getSelection()
    });
    if (!resolution) return;

    event.preventDefault();
    if (
      resolution.type !== "focus" &&
      resolution.type !== "extendSelection" &&
      resolution.type !== "clearSelection" &&
      structuralCommandInFlightRef.current
    ) {
      return;
    }
    switch (resolution.type) {
      case "createNextTextSibling":
        runStructuralCommand(() => actions.createNextTextSibling(nodeId));
        return;
      case "move":
        runStructuralCommand(() =>
          actions.moveNode(resolution.input, resolution.focusNodeId, {
            expandNodeId: resolution.expandNodeId
          })
        );
        return;
      case "focus":
        saveDrafts();
        void (resolution.selection
          ? actions.focusNode(resolution.nodeId, resolution.selection)
          : actions.focusNode(resolution.nodeId));
        return;
      case "extendSelection":
        if (selectionDisabled) {
          return;
        }
        if (!getSelection()) actions.setSelectionAnchor(nodeId);
        actions.extendSelectionTo(resolution.headId);
        return;
      case "clearSelection":
        actions.clearSelection();
        return;
      case "consumeTabShortcut":
        return;
      case "batchComplete":
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
      case "split":
      case "remove":
        return;
    }
  };

  const updateImageDraft = (nextDraft: {
    readonly title: string;
    readonly note: string;
    readonly imageOffsetUtf16: number;
  }) => {
    actions.updateNodeDraft(nodeId, nextDraft, "title");
  };

  const runImageAtomEnter = () => {
    runStructuralCommand(async () => {
      const selection = await imageEditorRef.current?.flushAndGetSelection();
      if (!selection) return "skipped";
      let siblingId: NoteId;
      try {
        siblingId = createNoteId();
      } catch {
        return "skipped";
      }
      return actions.applyImageAtomEdit(nodeId, selection, {
        kind: "enter",
        siblingId
      });
    });
  };

  const runImageAtomKeyboardRemove = () => {
    runStructuralCommand(async () => {
      const selection = await imageEditorRef.current?.flushAndGetSelection();
      return selection
        ? actions.applyImageAtomEdit(nodeId, selection, {
            kind: "remove",
            replacementText: ""
          })
        : "skipped";
    });
  };

  const runImageAtomCut = async ({
    selection,
    selectionAuthority
  }: ImageAtomEditorCutRequest) => {
    const editor = imageEditorRef.current;
    if (
      !editor ||
      !captureActiveImageAtomEditorAuthority ||
      !captureImageAtomCutAuthority ||
      !applyImageAtomCutWithAuthority
    ) {
      return false;
    }
    const editorAuthority = captureActiveImageAtomEditorAuthority(
      nodeId,
      selectionAuthority
    );
    if (!editorAuthority || (await editor.flush()) !== "flushed") return false;
    if (imageEditorRef.current !== editor) return false;
    let persisted = false;
    try {
      persisted = await actions.flushNodeDraft(nodeId);
    } catch {
      return false;
    }
    if (!persisted || imageEditorRef.current !== editor) return false;
    const cutAuthority = captureImageAtomCutAuthority(nodeId, editorAuthority);
    if (!cutAuthority) return false;
    return await applyImageAtomCutWithAuthority(
      cutAuthority,
      nodeId,
      { ...selection }
    ) === "committed";
  };

  const runImageAtomMenuRemove = () => {
    runStructuralCommand(async () => {
      const result = await imageEditorRef.current?.flush();
      if (result !== "flushed" && result !== "deferred") return "skipped";
      return actions.applyImageAtomEdit(
        nodeId,
        {
          anchorUtf16: imageOffsetUtf16,
          focusUtf16: imageOffsetUtf16 + 1
        },
        { kind: "remove", replacementText: "" }
      );
    });
  };

  const handleImageAtomPaste = (event: globalThis.ClipboardEvent): boolean => {
    if (!imageIngestEnabled || !event.clipboardData) return false;
    const clipboardData = event.clipboardData;
    const candidate = readNotesImageAtomPasteCandidate(clipboardData);
    if (!candidate.claimed) return false;

    event.preventDefault();
    const parse = parseNotesImageAtomPaste(candidate).catch(
      () => ({ kind: "none" as const })
    );
    const editor = imageEditorRef.current;
    void (async () => {
      const initial = await editor?.flushAndGetSelectionSnapshot();
      if (!editor || !initial || imageEditorRef.current !== editor) return;
      const editorAuthority = captureActiveImageAtomEditorAuthority?.(
        nodeId,
        initial.authority
      );
      if (!editorAuthority) return;
      let persisted = false;
      try {
        persisted = await actions.flushNodeDraft(nodeId);
      } catch {
        return;
      }
      if (
        !persisted ||
        imageEditorRef.current !== editor ||
        !imageRef.current?.contains(document.activeElement) ||
        !imageIngestEnabledRef.current
      ) {
        return;
      }
      const admitted = await editor.flushAndGetSelectionSnapshot();
      if (
        !admitted ||
        admitted.selection.anchorUtf16 !== initial.selection.anchorUtf16 ||
        admitted.selection.focusUtf16 !== initial.selection.focusUtf16 ||
        admitted.authority !== initial.authority
      ) {
        return;
      }
      const authority = captureImageAtomPasteAuthority?.(
        nodeId,
        editorAuthority
      );
      if (!authority || !applyImageAtomPasteWithAuthority) return;
      const exactSelection = { ...admitted.selection };
      const parsed = await parse;
      if (parsed.kind !== "imageAtom" && parsed.kind !== "external") return;
      if (
        !isImageAtomPasteAuthorityCurrent?.(authority) ||
        imageEditorRef.current !== editor ||
        !imageRef.current?.contains(document.activeElement) ||
        !imageIngestEnabledRef.current
      ) {
        return;
      }
      const live = await editor.flushAndGetSelectionSnapshot();
      if (
        !live ||
        live.selection.anchorUtf16 !== exactSelection.anchorUtf16 ||
        live.selection.focusUtf16 !== exactSelection.focusUtf16 ||
        live.authority !== admitted.authority ||
        !isImageAtomPasteAuthorityCurrent(authority) ||
        imageEditorRef.current !== editor ||
        !imageRef.current?.contains(document.activeElement) ||
        !imageIngestEnabledRef.current
      ) {
        return;
      }
      runStructuralCommand(() =>
        applyImageAtomPasteWithAuthority(
          authority,
          nodeId,
          exactSelection,
          parsed.value
        )
      );
    })().catch(() => undefined);
    return true;
  };

  return (
    <div
      ref={setNodeRef}
      className="notes-node"
      data-outline-id={nodeId}
      data-completed={completed ? "true" : undefined}
      data-dragging={dragPresentationActive ? "true" : undefined}
      data-guide-end-id={visibleDescendantEndId ?? undefined}
      data-selected={state.selectedId === nodeId ? "true" : undefined}
      data-range-selected={isSelected ? "true" : undefined}
      data-notes-attachment-target={
        imageAttachmentTargetEnabled ? nodeId : undefined
      }
      data-image-drop-active={
        imageDropEnabled && imageDropActive ? "true" : undefined
      }
      onPointerDownCapture={
        selectionDisabled ? undefined : handleSelectionPointerDownCapture
      }
      style={rowStyle}
    >
      {guides}
      <div className="notes-node-main">
        <div className="notes-node-menu-slot">
          {!pluginRoot && <NotesBulletMenu
            label={navigationLabel}
            completed={completed}
            starred={node.isStarred}
            hasNote={Boolean(noteValue.trim())}
            saveFailed={draft?.status === "failed"}
            disabled={disabled}
            actionBusy={structuralCommandBusy}
            createdAt={node.createdAt}
            updatedAt={node.updatedAt}
            selectionBridge={selectionBridge}
            onOpenChange={(open) => {
              if (open && !selectionBridge && getSelection()) {
                actions.clearSelection();
              }
            }}
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
              exportController.startExport(
                nodeId,
                node.nodeKind === "image" ? label : titleValue,
                format
              )
            }
            onDelete={() =>
              runStructuralCommand(() => actions.deleteNode(nodeId))
            }
            onRetrySave={() =>
              runStructuralCommand(() => retryFailedDraft(nodeId))
            }
          />}
        </div>

        <span className="notes-node-arrow-slot">
          {hasChildren && (
            <IconTooltip label={isCollapsed ? "Expand" : "Collapse"}>
              <button
                className="notes-row-icon-button notes-collapse-button"
                type="button"
                aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${navigationLabel}`}
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
          onKeyDown={handleBulletKeyDown}
          aria-label={`Zoom into ${navigationLabel}`}
          aria-description={dragDisabledReason}
          disabled={disabled}
          data-collapsed={hasChildren && isCollapsed ? "true" : undefined}
          data-sortable-activator={dragEnabled ? "true" : undefined}
          onPointerDownCapture={(event) => {
            trackDisabledDragAttempt(event);
            shiftClickAnchorRef.current = event.shiftKey && !selectionDisabled
              ? activeSelectionRowId()
              : undefined;
          }}
          onClick={(event) => {
            if (
              suppressNextPointerClickRef.current &&
              event.detail > 0
            ) {
              suppressNextPointerClickRef.current = false;
              event.preventDefault();
              return;
            }
            // Shift+Click extends the multi-node selection to this row (head),
            // anchoring at the current caret node the first time. A plain click
            // still zooms.
            if (event.shiftKey && !selectionDisabled) {
              event.preventDefault();
              const capturedAnchorId = shiftClickAnchorRef.current;
              shiftClickAnchorRef.current = undefined;
              extendSelectionToThisRow(
                capturedAnchorId === undefined
                  ? activeSelectionRowId()
                  : capturedAnchorId
              );
              return;
            }
            void actions.zoomTo(nodeId);
          }}
        >
          <span className="notes-node-bullet-dot" aria-hidden="true" />
        </button>

        {pluginRoot ? (
          <span className="notes-node-title-field">
            <span
              className="notes-token-text notes-node-title"
              role="button"
              tabIndex={disabled ? -1 : 0}
              aria-label={navigationLabel}
              aria-disabled={disabled}
              onClick={
                disabled ? undefined : () => void actions.zoomTo(nodeId)
              }
              onKeyDown={(event) => {
                if (
                  !disabled &&
                  (event.key === "Enter" || event.key === " ") &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void actions.zoomTo(nodeId);
                }
              }}
            >
              {titleValue}
            </span>
          </span>
        ) : node.nodeKind === "image" ? primaryImageAttachment ? (
          <div style={{ gridColumn: 4, gridRow: 1, minWidth: 0 }}>
            <ImageAtomEditor
              ref={imageEditorRef}
              nodeId={nodeId}
              draft={{ title: titleValue, note: noteValue, imageOffsetUtf16 }}
              attachment={primaryImageAttachment}
              onDraftChange={updateImageDraft}
              registerFlushAdapter={actions.registerImageAtomFlushAdapter}
              registerActiveEditor={registerActiveImageAtomEditor}
              onEnter={runImageAtomEnter}
              onAtomDelete={runImageAtomKeyboardRemove}
              onUnhandledKeyDown={handleImageKeyDown}
              onSupportingNote={openAndFocusNote}
              onUndo={() => void actions.undo?.()}
              onRedo={() => void actions.redo?.()}
              onImageAtomPaste={handleImageAtomPaste}
              loadAttachmentBytes={disabled ? undefined : actions.loadAttachmentBytes}
              onAtomCut={disabled ? undefined : runImageAtomCut}
              onTagClick={(token) =>
                void actions.toggleTagFilter({
                  prefix: token.prefix,
                  normalizedTag: token.normalized
                })
              }
              onDateClick={disabled ? undefined : (token, anchor) =>
                datePicker.openExistingDate(
                  "title",
                  token,
                  anchor,
                  imageRef.current ?? undefined
                )
              }
              onDateTrigger={disabled ? undefined : (range, anchor, source) =>
                datePicker.openTypedDate("title", range, anchor, source)
              }
              isTagActive={(token) =>
                activeTagFilters.some(
                  (filter) =>
                    filter.prefix === token.prefix &&
                    filter.normalizedTag === token.normalized
                )
              }
              today={datePicker.today}
              className="notes-node-primary-image"
              contentRef={imageRef}
              disabled={disabled}
              onRemoveImage={runImageAtomMenuRemove}
            />
          </div>
        ) : (
          <NotesImageNodeContent
            nodeId={nodeId}
            attachment={attachments[0]}
            originalName={titleValue || node.title}
            className="notes-node-primary-image"
            style={{ gridColumn: 4, gridRow: 1, minWidth: 0 }}
            contentRef={imageRef}
            onKeyDown={handleImageKeyDown}
            disabled={disabled}
          />
        ) : (
          <NoteTextField
            slashCommands
            stablePresentation
            placeCaretFromPointer
            className="notes-node-title"
            containerClassName="notes-node-title-field"
            ref={titleRef}
            value={titleValue}
            aria-label="Edit node title"
            data-github-editor-node-id={nodeId}
            data-github-editor-field="title"
            rows={1}
            wrap="soft"
            disabled={disabled}
            today={datePicker.today}
            getToday={datePicker.getToday}
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
              actions.updateNodeDraft(
                nodeId,
                {
                  title: event.target.value,
                  note: noteValue,
                  imageOffsetUtf16
                },
                "title"
              );
            }}
            onFocus={() => {
              if (!pendingFocusInProgressRef.current) {
                actions.markEditingFocus?.(nodeId, "title");
              }
            }}
            onKeyDown={handleTitleKeyDown}
            onPaste={(event) => handlePaste(event, "title")}
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
        )}
      </div>

      {commandNotice && (
        <p className="notes-node-command-notice" role="alert">
          {commandNotice}
        </p>
      )}

      {noteOpen && (
        <NoteTextField
          ref={noteRef}
          stablePresentation
          placeCaretFromPointer
          className="notes-node-note"
          containerClassName="notes-node-note-field"
          value={noteValue}
          aria-label={`Supporting note: ${navigationLabel}`}
          data-github-editor-node-id={nodeId}
          data-github-editor-field="note"
          rows={1}
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
              return;
            }
            const resolution = resolveSupportingNoteKey({
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
            if (!resolution) {
              return;
            }
            event.preventDefault();
            const focusTarget = supportingNoteFocusTarget(
              resolution,
              nodeId,
              getVisibleNodeIds()
            );
            actions.updateNodeDraft(
              nodeId,
              { title: titleValue, note: event.currentTarget.value, imageOffsetUtf16 },
              "note"
            );
            if (
              resolution === "nextTitleOrCreate" &&
              focusTarget === nodeId
            ) {
              runStructuralCommand(() => actions.createNextTextSibling(nodeId));
              return;
            }
            void actions.flushNodeDraft(nodeId);
            void actions.focusNode(focusTarget);
          }}
          onChange={(event) => {
            resizeTextarea(event.currentTarget);
            actions.updateNodeDraft(nodeId, {
              title: titleValue,
              note: event.target.value,
              imageOffsetUtf16
            }, "note");
          }}
          onFocus={() => {
            noteBlurredDuringCompositionRef.current = false;
            if (!pendingFocusInProgressRef.current) {
              actions.markEditingFocus?.(nodeId, "note");
            }
          }}
          onPaste={(event) => handlePaste(event, "note")}
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
          uploadError={attachmentUploadError}
          uploadRetryAttemptId={attachmentUploadRetryAttemptId}
          className="notes-node-attachments"
          readOnly={disabled}
        />
      ) : (
        <NotesImageUploadStatus
          nodeId={nodeId}
          uploadError={attachmentUploadError}
          uploadRetryAttemptId={attachmentUploadRetryAttemptId}
          readOnly={disabled}
        />
      )}
      {imageDropEnabled && showDropPlaceholder && (
        <span
          className="notes-image-drop-position"
          data-testid="notes-image-drop-position"
          aria-hidden="true"
        />
      )}
      {datePicker.picker}
      <ConfirmDialog
        open={trashConfirmOpen}
        onOpenChange={setTrashConfirmOpen}
        title="Move bullet to Trash?"
        description="Move this bullet, its note, and all descendants to Trash?"
        confirmLabel="Move to Trash"
        cancelLabel="Cancel"
        danger
        finalFocus={titleRef}
        onConfirm={() =>
          runStructuralCommand(() => actions.deleteNode(nodeId))
        }
      />
    </div>
  );
}

// Memoized so a draft keystroke in one row (which re-renders the pane shell and
// re-creates every row element) only re-renders the row whose atomic props
// actually changed. All props are primitives, referentially stable objects, or
// stable callbacks; the drafts context is read at the pane and passed down as
// the `draft`/attachment props so sibling rows keep identical props and bail.
export const OutlineNodeRow = memo(OutlineNodeRowComponent);
