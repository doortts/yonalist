import { ChevronDown, ChevronRight, Lock } from "lucide-react";
import {
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { IconTooltip } from "../../components/ui/Tooltip";
import {
  createNoteId,
  type NoteAttachment,
  type NoteId,
  type NoteNode,
} from "../../domain/notes";
import { GITHUB_NOTIFICATIONS_ROOT_ID } from "../../services/githubNotificationsProvider";
import { NotesAttachmentList } from "./NotesAttachmentList";
import {
  isValidNotesImageAttachmentMetadata,
  NotesImageNodeContent,
} from "./NotesImageAttachment";
import {
  ImageAtomEditor,
  type ImageAtomEditorCutRequest,
  type ImageAtomEditorHandle,
} from "./ImageAtomEditor";
import { NotesImageUploadStatus } from "./NotesImageUploadStatus";
import { NotesRemoteMarkdownImage } from "./NotesRemoteMarkdownImage";
import { NotesTodoCheckbox } from "./NotesTodoCheckbox";
import { NotesTodoProgress } from "./TodoProgressIndicator";
import {
  noteNodeNavigationLabel,
  noteNodePresentationLabel,
} from "./notesPresentation";
import type { NotesSelectionActionIntent } from "./notesSelectionActions";
import { focusOutlineEditorDom } from "./outlineDomFocus";
import { markCaretPhase, markSplitPhase } from "./notesSplitLatencyProbe";
import type { NotesSelection } from "./notesWorkspaceReducer";
import {
  buildNotesMoveDestinations,
  buildNotesMoveNodeInput,
  NotesBulletMenu,
  type NotesBulletMenuSelectionBridge,
} from "./NotesBulletMenu";
import { useNotesDatePickerIntegration } from "./NotesDatePickerIntegration";
import type { NotesExportControllerValue } from "./NotesExportController";
import {
  parseNotesImageAtomPaste,
  readNotesImageAtomPasteCandidate,
} from "./notesImageAtomClipboard";
import { parseNoteMarkdown } from "./noteMarkdown";
import {
  extractClipboardImages,
  type ClipboardImageExtraction,
} from "./notesClipboardImages";
import { parsePastedOutline } from "./notesPasteImport";
import {
  NOTES_AUTHORITATIVE_FOCUS_TARGET_ATTRIBUTE,
  NoteTextField,
  releaseAuthoritativeFocusTarget,
  restoreTextareaPrimarySelection,
} from "./NoteTextField";
import { OutlineSortableHandle } from "./OutlineSortableShell";
import type { NotesWorkspaceCommandOutcome } from "./notesWorkspaceCoordinator";
import type {
  NotesActionsSlice,
  NotesNodeDraft,
  NotesStateSlice,
  NotesPreparedMove,
} from "./useNotesWorkspace";
import type {
  NotesHistoryFocusField,
  NotesHistoryPrimarySelection,
} from "./notesHistory";
import { resizeTextarea, useAutoGrowTextarea } from "./autoGrowTextarea";
import {
  detectOutlineShortcutPlatform,
  resolveNotesHistoryShortcut,
  resolveOutlineKey,
  resolveSupportingNoteKey,
  supportingNoteFocusTarget,
} from "./outlineKeyboard";
import type { OutlineInteractionEpoch } from "./outlineInteractionEpoch";

export interface OutlineEditorFocusRequest {
  readonly requestId: number;
  readonly field: NotesHistoryFocusField;
  readonly selection?: NotesHistoryPrimarySelection;
}

export interface OutlineNodeEditorProps {
  paneId: string;
  interactionEpoch: OutlineInteractionEpoch;
  nextKeyboardInsertionToken(): number;
  onKeyboardInsertionPrepared?(
    intentToken: number,
    layoutGeneration: number,
  ): void;
  onKeyboardInsertionTerminated?(
    intentToken: number,
    layoutGeneration: number,
  ): void;
  onCommandFocusActivity?(): void;
  node: NoteNode;
  attachments: readonly NoteAttachment[];
  childCount: number;
  todoCompleted: number | null;
  todoTotal: number | null;
  selected: boolean;
  rangeSelected: boolean;
  focusRequest: OutlineEditorFocusRequest | null;
  getStateSnapshot(): NotesStateSlice;
  getActionsSnapshot(): NotesActionsSlice;
  getExportController(): Pick<NotesExportControllerValue, "startExport">;
  subscribeExportState(listener: () => void): () => void;
  getExportSnapshot(): {
    readonly busy: boolean;
    readonly unavailable: boolean;
  };
  ancestorGuideDepths: readonly number[];
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
  // Atomic drafts-slice reads, hoisted to props so the row does NOT subscribe to
  // the high-volatility drafts context. A keystroke in another row therefore
  // leaves these props referentially unchanged and the memo bails out.
  draft?: NotesNodeDraft;
  attachmentUploadError?: string;
  attachmentUploadRetryAttemptId?: string;
  movementProtected?: boolean;
  dragDisabledReason?: string;
  onDragDisabledAttempt?: () => void;
  disabled?: boolean;
  readOnlyMode?: "archive" | "trash";
  pluginRoot?: boolean;
  selectionDisabled?: boolean;
  locallyExpanded?: boolean;
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
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) return false;
  const surface = target.closest(OUTLINE_NATIVE_SELECTION_SURFACE_SELECTOR);
  if (surface) {
    const control = target.closest(
      `${OUTLINE_SELECTION_INTERACTIVE_SELECTOR}, ${OUTLINE_NATIVE_SELECTION_CONTROL_SELECTOR}`,
    );
    return control !== null && surface.contains(control);
  }
  return target.closest(OUTLINE_SELECTION_INTERACTIVE_SELECTOR) !== null;
}

export function isOutlineSelectionTextSurface(
  target: EventTarget | null,
): boolean {
  return (
    target instanceof Element &&
    !isOutlineSelectionInteractiveTarget(target) &&
    Boolean(
      target.closest(
        `${OUTLINE_NATIVE_SELECTION_SURFACE_SELECTOR}, .notes-node-title-field, .notes-node-note-field`,
      ),
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

interface OutlineSelectionPointerDownEvent {
  readonly button: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly target: EventTarget | null;
  preventDefault(): void;
}

function OutlineNodeEditorComponent({
  paneId,
  interactionEpoch,
  nextKeyboardInsertionToken,
  onKeyboardInsertionPrepared,
  onKeyboardInsertionTerminated,
  onCommandFocusActivity,
  node,
  attachments,
  childCount,
  todoCompleted,
  todoTotal,
  focusRequest,
  getStateSnapshot,
  getActionsSnapshot,
  getExportController,
  subscribeExportState,
  getExportSnapshot,
  ancestorGuideDepths,
  getVisibleNodeIds,
  getSelectionVisibleNodeIds,
  getSelection,
  onSelectionAction,
  selectionBridge,
  draft,
  attachmentUploadError,
  attachmentUploadRetryAttemptId,
  movementProtected = false,
  dragDisabledReason,
  onDragDisabledAttempt,
  disabled = false,
  readOnlyMode,
  pluginRoot = false,
  selectionDisabled = false,
  locallyExpanded = false,
  showDropPlaceholder = false,
}: OutlineNodeEditorProps) {
  type ActionFunction = (...args: never[]) => unknown;
  const liveActionWrappersRef = useRef(new Map<PropertyKey, ActionFunction>());
  const getLiveFunction = <Scope extends object, Key extends keyof Scope>(
    getScope: () => Scope,
    key: Key,
    cacheKey: PropertyKey,
  ): Scope[Key] => {
    const current = getScope()[key];
    if (typeof current !== "function") {
      return current;
    }
    const cached = liveActionWrappersRef.current.get(cacheKey);
    if (cached) {
      return cached as Scope[Key];
    }
    const wrapper = ((...args: never[]) => {
      const live = getScope()[key];
      return typeof live === "function"
        ? Reflect.apply(live, undefined, args)
        : undefined;
    }) as ActionFunction;
    liveActionWrappersRef.current.set(cacheKey, wrapper);
    return wrapper as Scope[Key];
  };
  const getLiveWorkspaceAction = <
    Key extends keyof NotesActionsSlice["actions"],
  >(
    key: Key,
  ): NotesActionsSlice["actions"][Key] =>
    getLiveFunction(
      () => getActionsSnapshot().actions,
      key,
      `actions:${String(key)}`,
    );
  const actionsProxyRef = useRef<NotesActionsSlice["actions"] | null>(null);
  if (actionsProxyRef.current === null) {
    actionsProxyRef.current = new Proxy({} as NotesActionsSlice["actions"], {
      get: (_target, property: string | symbol) => {
        const key = property as keyof NotesActionsSlice["actions"];
        return getLiveWorkspaceAction(key);
      },
    });
  }
  const actions = actionsProxyRef.current!;
  const getLiveAction = <Key extends keyof NotesActionsSlice>(key: Key) =>
    getLiveFunction(() => getActionsSnapshot(), key, `slice:${String(key)}`);
  const nodeId = node.id;
  const readOnly = readOnlyMode !== undefined;
  const contentProtected = node.isReadonly === true;
  const isImageIngestEnabled = () =>
    !selectionDisabled &&
    !disabled &&
    !readOnly &&
    !contentProtected &&
    getStateSnapshot().state.status !== "loading";
  const imageIngestEnabled = isImageIngestEnabled();
  const imageDropEnabled =
    imageIngestEnabled && actions.importDroppedImagePaths !== undefined;
  // Paste import (plan Phase 4.4): a multi-line indented plain-text paste
  // becomes a subtree of new children under the focused row instead of a
  // single blob of text. Gated the same way clipboard image import is.
  const [noteOpen, setNoteOpen] = useState(() =>
    Boolean((draft?.note ?? node?.note ?? "").trim()),
  );
  const [trashConfirmOpen, setTrashConfirmOpen] = useState(false);
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
  const [protectedDraft, setProtectedDraft] = useState(() => ({
    title: node?.title ?? "",
    note: node?.note ?? "",
    imageOffsetUtf16: node?.imageOffsetUtf16 ?? 0,
  }));
  const protectedSelectionRef = useRef<{
    field: "title" | "note";
    startUtf16: number;
    endUtf16: number;
  } | null>(null);
  const protectedFocusRef = useRef<{
    field: "title" | "note";
    startUtf16: number;
    endUtf16: number;
  } | null>(null);
  const titleValue = contentProtected
    ? protectedDraft.title
    : (draft?.title ?? node?.title ?? "");
  const noteValue = contentProtected
    ? protectedDraft.note
    : (draft?.note ?? node?.note ?? "");
  const imageOffsetUtf16 = contentProtected
    ? protectedDraft.imageOffsetUtf16
    : (draft?.imageOffsetUtf16 ?? node?.imageOffsetUtf16 ?? 0);
  const markdownImageWidth =
    draft?.markdownImageWidth ?? node.markdownImageWidth ?? null;
  const parsedTitleMarkdown = parseNoteMarkdown(titleValue);
  const remoteMarkdownImage =
    parsedTitleMarkdown.kind === "remoteImage" ? parsedTitleMarkdown : null;
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
      if (contentProtected) {
        setProtectedDraft((current) => ({
          title: field === "title" ? value : current.title,
          note: field === "note" ? value : current.note,
          imageOffsetUtf16: nextImageOffsetUtf16,
        }));
        return;
      }
      actions.updateNodeDraft(
        nodeId,
        field === "title"
          ? {
              title: value,
              note: noteValue,
              imageOffsetUtf16: nextImageOffsetUtf16,
            }
          : {
              title: titleValue,
              note: value,
              imageOffsetUtf16: nextImageOffsetUtf16,
            },
        field,
      );
      void actions.flushNodeDraft(nodeId);
    },
  });

  useEffect(() => () => disabledDragAttemptCleanupRef.current?.(), []);

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
      const selectedId = getStateSnapshot().state.selectedId;
      const fallbackRowId =
        selectedId !== null && selectionVisibleIds.includes(selectedId)
          ? selectedId
          : nodeId;
      actions.setSelectionAnchor(anchorId ?? fallbackRowId);
    }
    actions.extendSelectionTo(nodeId);
  };

  const handleSelectionPointerDownCapture = (
    event: OutlineSelectionPointerDownEvent,
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

  const selectionPointerDownRef = useRef(handleSelectionPointerDownCapture);
  selectionPointerDownRef.current = handleSelectionPointerDownCapture;
  useEffect(() => {
    if (readOnly || selectionDisabled) return;
    const root =
      titleRef.current?.closest<HTMLElement>("[data-outline-id]") ??
      noteRef.current?.closest<HTMLElement>("[data-outline-id]") ??
      imageRef.current?.closest<HTMLElement>("[data-outline-id]");
    if (!root) return;
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      selectionPointerDownRef.current(event);
    };
    root.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      root.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [nodeId, readOnly, selectionDisabled]);

  const trackDisabledDragAttempt = (
    event: PointerEvent<HTMLButtonElement>,
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
        Math.hypot(moveEvent.clientX - clientX, moveEvent.clientY - clientY) >=
          4
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

  useLayoutEffect(() => {
    if (!contentProtected) {
      return;
    }
    const next = {
      title: node?.title ?? "",
      note: node?.note ?? "",
      imageOffsetUtf16: node?.imageOffsetUtf16 ?? 0,
    };
    const active = document.activeElement;
    if (active === titleRef.current || active === noteRef.current) {
      const target = active as HTMLTextAreaElement;
      protectedSelectionRef.current = {
        field: active === titleRef.current ? "title" : "note",
        startUtf16: target.selectionStart,
        endUtf16: target.selectionEnd,
      };
    }
    setProtectedDraft(next);
  }, [contentProtected, node?.imageOffsetUtf16, node?.note, node?.title]);

  useLayoutEffect(() => {
    const selection = protectedSelectionRef.current;
    if (!contentProtected || !selection) {
      return;
    }
    protectedSelectionRef.current = null;
    const target =
      selection.field === "title" ? titleRef.current : noteRef.current;
    if (!target) {
      return;
    }
    target.focus();
    const end = target.value.length;
    target.setSelectionRange(
      Math.min(selection.startUtf16, end),
      Math.min(selection.endUtf16, end),
    );
  }, [contentProtected, protectedDraft]);

  useLayoutEffect(() => {
    const focus = protectedFocusRef.current;
    if (!contentProtected || !focus) {
      return;
    }
    const target = focus.field === "title" ? titleRef.current : noteRef.current;
    if (!target || document.activeElement === target) {
      return;
    }
    target.focus();
    const end = target.value.length;
    target.setSelectionRange(
      Math.min(focus.startUtf16, end),
      Math.min(focus.endUtf16, end),
    );
  });

  useEffect(() => {
    if (!focusRequest) {
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
      focusRequest.field === "title" && focusRequest.selection
        ? focusRequest.selection
        : null;
    const focusRequestId = focusRequest.requestId;
    if (focusedPendingIdRef.current === focusRequestId) {
      return;
    }
    if (focusRequest.field === "note" && !noteOpen) {
      setNoteOpen(true);
      return;
    }
    const target =
      focusRequest.field === "note"
        ? noteRef.current
        : node.nodeKind === "image"
          ? imageRef.current
          : titleRef.current;
    if (!target) {
      return;
    }
    // This focus is the command's own pending-focus postcondition. Do not
    // report it as a newer user navigation and invalidate its ownership.
    let focused = false;
    const focusEpoch =
      actions.pendingKeyboardInsertionInteractionEpoch?.(nodeId) ??
      interactionEpoch.current();
    if (!interactionEpoch.isCurrent(focusEpoch)) return;
    pendingFocusInProgressRef.current = true;
    const focusTargetMarker = target instanceof HTMLElement ? target : null;
    focusTargetMarker?.setAttribute(
      NOTES_AUTHORITATIVE_FOCUS_TARGET_ATTRIBUTE,
      "true",
    );
    try {
      onCommandFocusActivity?.();
      if (replaySelection && node.nodeKind === "image") {
        focused = interactionEpoch.runCommandFocus(() => {
          if (!interactionEpoch.isCurrent(focusEpoch)) return false;
          return imageEditorRef.current?.focus(replaySelection) ?? false;
        });
      } else {
        interactionEpoch.runCommandFocus(() => {
          if (!interactionEpoch.isCurrent(focusEpoch)) return;
          target.focus();
        });
        focused = document.activeElement === target;
        if (
          focused &&
          replaySelection &&
          target instanceof HTMLTextAreaElement
        ) {
          focused = restoreTextareaPrimarySelection(target, replaySelection);
        }
      }
    } finally {
      pendingFocusInProgressRef.current = false;
    }
    if (!focused || !interactionEpoch.isCurrent(focusEpoch)) {
      focusTargetMarker && releaseAuthoritativeFocusTarget(focusTargetMarker);
      return;
    }
    // Terminal phase of the split latency chain (plan Phase L0). No-op unless
    // this node's id opened a record at a split keydown, so ordinary focus
    // moves never log.
    markSplitPhase(nodeId, "caret");
    markCaretPhase(nodeId, "dom-focus");
    focusedPendingIdRef.current = focusRequestId;
    if (!interactionEpoch.isCurrent(focusEpoch)) return;
    try {
      const acknowledgement = replaySelection
        ? actions.acknowledgeFocus(nodeId, focusRequestId)
        : actions.acknowledgeFocus(nodeId);
      void Promise.resolve(acknowledgement).finally(() => {
        markCaretPhase(nodeId, "sync");
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => markCaretPhase(nodeId, "paint"));
        } else {
          markCaretPhase(nodeId, "paint");
        }
        if (focusTargetMarker) {
          releaseAuthoritativeFocusTarget(focusTargetMarker);
        }
      });
    } catch {
      if (focusTargetMarker) {
        releaseAuthoritativeFocusTarget(focusTargetMarker);
      }
    }
  }, [
    actions,
    interactionEpoch,
    onCommandFocusActivity,
    nodeId,
    focusRequest,
    getStateSnapshot,
    node.nodeKind,
    noteOpen,
    readOnly,
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
        noteRef.current,
      );
      return;
    }
    if (focusNoteOnOpenRef.current) {
      focusNoteOnOpenRef.current = false;
      noteRef.current.focus();
    }
  }, [datePicker, noteOpen]);

  const label = noteNodePresentationLabel(
    node,
    titleValue || node.title,
    "Untitled node",
  );
  const navigationLabel = noteNodeNavigationLabel(
    node,
    titleValue || node.title,
    "Untitled node",
  );
  const hasChildren = pluginRoot || childCount > 0;
  const completed = node.completedAt !== null;
  const markerKind = draft?.markerKind ?? node.markerKind;
  const isTodo = markerKind === "todo";
  const todoProgress =
    todoCompleted === null || todoTotal === null
      ? null
      : { completed: todoCompleted, total: todoTotal };
  const isCollapsed = node.isCollapsed && !locallyExpanded;
  const dragEnabled =
    !disabled &&
    !readOnly &&
    !contentProtected &&
    !movementProtected &&
    dragDisabledReason === undefined;
  const guides = ancestorGuideDepths.length > 0 && (
    <span
      className="notes-node-guides"
      aria-hidden="true"
      style={
        {
          "--notes-guide-count": ancestorGuideDepths.length,
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
      <>
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
                  draft={{
                    title: titleValue,
                    note: noteValue,
                    imageOffsetUtf16,
                  }}
                  attachment={primaryImageAttachment}
                  onDraftChange={() => undefined}
                  registerFlushAdapter={actions.registerImageAtomFlushAdapter}
                  registerActiveEditor={getLiveAction(
                    "registerActiveImageAtomEditor",
                  )}
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
          ) : remoteMarkdownImage ? (
            <NotesRemoteMarkdownImage
              nodeId={nodeId}
              alt={remoteMarkdownImage.alt}
              url={remoteMarkdownImage.url}
              persistedWidth={markdownImageWidth}
              disabled
              onDisplayWidthCommit={() => undefined}
              onEditRequest={() => undefined}
            />
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
      </>
    );
  }

  const draftPatch = () => ({
    title: titleValue,
    note: noteValue,
    imageOffsetUtf16,
  });

  const draftToSave = (force = false) => {
    if (contentProtected) {
      return undefined;
    }
    if (!force && !draft) {
      return undefined;
    }
    return draftPatch();
  };

  const saveDrafts = () => {
    if (contentProtected) {
      setProtectedDraft({
        title: node.title,
        note: node.note,
        imageOffsetUtf16: node.imageOffsetUtf16,
      });
      return;
    }
    if (!draft) {
      return;
    }
    void actions.flushNodeDraft(nodeId);
  };

  const suppressHandledBlur = () => {
    suppressedBlurPatchRef.current = draftPatch();
  };

  const commitDrafts = () => {
    if (contentProtected) {
      setProtectedDraft({
        title: node.title,
        note: node.note,
        imageOffsetUtf16: node.imageOffsetUtf16,
      });
      return;
    }
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
    if (contentProtected) {
      setProtectedDraft({
        title: node.title,
        note: node.note,
        imageOffsetUtf16: node.imageOffsetUtf16,
      });
      return;
    }
    if (includeLiveValue) {
      const note = value.trim().length === 0 ? "" : value;
      if (note.length === 0) {
        setNoteOpen(false);
      }
      actions.updateNodeDraft(
        nodeId,
        { title: titleValue, note, imageOffsetUtf16 },
        "note",
      );
      void actions.flushNodeDraft(nodeId);
      return;
    }
    if (value.trim().length === 0) {
      setNoteOpen(false);
      if (value.length > 0) {
        actions.updateNodeDraft(
          nodeId,
          { title: titleValue, note: "", imageOffsetUtf16 },
          "note",
        );
      }
    }
    commitDrafts();
  };

  const runStructuralCommand = (
    command: () => Promise<NotesWorkspaceCommandOutcome | void>,
    onTerminalFailure?: () => void,
  ) => {
    if (structuralCommandInFlightRef.current) {
      return;
    }
    structuralCommandInFlightRef.current = true;
    if (commandNotice !== null) {
      setCommandNotice(null);
    }
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
      onTerminalFailure?.();
      structuralCommandInFlightRef.current = false;
      return;
    }
    const settle = (outcome: NotesWorkspaceCommandOutcome | void) => {
      structuralCommandInFlightRef.current = false;
      if (outcome !== "committed") {
        onTerminalFailure?.();
      }
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
    void completion.then(settle, () => {
      settle();
    });
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
      noteRef.current,
    );
  };

  const removeNote = () => {
    setNoteOpen(false);
    actions.updateNodeDraft(
      nodeId,
      { title: titleValue, note: "", imageOffsetUtf16 },
      "note",
    );
    void actions.flushNodeDraft(nodeId);
  };

  // Returns true when the paste was handled (clipboard images win — plan
  // Phase 0.5) so the caller does not also try a subtree import or fall
  // through to a normal text paste.
  const handleImagePaste = (
    event: ClipboardEvent<HTMLTextAreaElement>,
  ): boolean => {
    if (
      !isImageIngestEnabled() ||
      actions.importClipboardImages === undefined
    ) {
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
    event: ClipboardEvent<HTMLTextAreaElement>,
  ): boolean => {
    if (!isImageIngestEnabled()) {
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
    const existingChildIds =
      getStateSnapshot().state.childIdsByParent[nodeId] ?? [];
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
    field: "title" | "note",
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
      platform: detectOutlineShortcutPlatform(),
    });
    if (historyShortcut) {
      event.preventDefault();
      void actions[historyShortcut]?.();
      return;
    }
    if (
      !dragEnabled &&
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
      platform: detectOutlineShortcutPlatform(),
    });
    if (historyShortcut) {
      event.preventDefault();
      void actions[historyShortcut]?.();
      return;
    }
    if (
      contentProtected &&
      event.key === "Escape" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      commitDrafts();
      return;
    }
    const stateSnapshot = getStateSnapshot();
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
      workspace: stateSnapshot.state,
      authoritativeWorkspace:
        stateSnapshot.libraryView === "all" ? stateSnapshot.state : undefined,
      visibleNodeIds: getVisibleNodeIds(),
      outdentBoundaryRootId: GITHUB_NOTIFICATIONS_ROOT_ID,
      selectionVisibleNodeIds: getSelectionVisibleNodeIds(),
      selection: getSelection(),
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
    if (contentProtected || movementProtected) {
      if (contentProtected && resolution.type === "split") {
        commitDrafts();
        runStructuralCommand(() => actions.createNextTextSibling(nodeId));
        return;
      }
      if (
        resolution.type === "move" ||
        resolution.type === "consumeTabShortcut"
      ) {
        if (contentProtected) commitDrafts();
        return;
      }
      if (
        contentProtected &&
        (resolution.type === "delete" ||
          resolution.type === "confirmDelete" ||
          resolution.type === "remove")
      ) {
        commitDrafts();
        return;
      }
    }
    switch (resolution.type) {
      case "createFirstChild": {
        let newNodeId: NoteId;
        try {
          newNodeId = createNoteId();
        } catch {
          return;
        }
        const keyboardInsertion = actions.prepareKeyboardInsertion?.({
          ownerPaneId: paneId,
          interactionEpochAtDispatch: interactionEpoch.current(),
          intent: {
            token: nextKeyboardInsertionToken(),
            sourceId: nodeId,
            expectedNodeId: newNodeId,
            postcondition: {
              kind: "first-child",
              expectedParentId: nodeId,
              expectedIndex: 0,
              expectedInsertedTitle: "",
            },
          },
        });
        if (!keyboardInsertion) return;
        onKeyboardInsertionPrepared?.(
          keyboardInsertion.pending.intent.token,
          keyboardInsertion.pending.layoutGenerationAtDispatch,
        );
        runStructuralCommand(
          () =>
            actions.createChild(nodeId, "first", {
              newNodeId,
              keyboardInsertion,
            }),
          () =>
            onKeyboardInsertionTerminated?.(
              keyboardInsertion.pending.intent.token,
              keyboardInsertion.pending.layoutGenerationAtDispatch,
            ),
        );
        return;
      }
      case "split": {
        let newNodeId: NoteId;
        try {
          newNodeId = createNoteId();
        } catch {
          return;
        }
        const keyboardInsertion = actions.prepareKeyboardInsertion?.({
          ownerPaneId: paneId,
          interactionEpochAtDispatch: interactionEpoch.current(),
          intent: {
            token: nextKeyboardInsertionToken(),
            sourceId: nodeId,
            expectedNodeId: newNodeId,
            postcondition: {
              kind: "split",
              expectedSourceTitle: resolution.prefix,
              expectedInsertedTitle: resolution.suffix,
            },
          },
        });
        if (!keyboardInsertion) return;
        onKeyboardInsertionPrepared?.(
          keyboardInsertion.pending.intent.token,
          keyboardInsertion.pending.layoutGenerationAtDispatch,
        );
        markSplitPhase(newNodeId, "keydown");
        runStructuralCommand(
          () => {
            const patch = draftToSave();
            suppressHandledBlur();
            return actions.splitNode(
              nodeId,
              newNodeId,
              resolution.prefix,
              resolution.suffix,
              { draft: patch, keyboardInsertion },
            );
          },
          () =>
            onKeyboardInsertionTerminated?.(
              keyboardInsertion.pending.intent.token,
              keyboardInsertion.pending.layoutGenerationAtDispatch,
            ),
        );
        return;
      }
      case "move": {
        runStructuralCommand(() => {
          const patch = draftToSave();
          suppressHandledBlur();
          return actions.moveNode(resolution.input, resolution.focusNodeId, {
            draft: patch,
            expandNodeId: resolution.expandNodeId,
          });
        });
        return;
      }
      case "focus": {
        markCaretPhase(resolution.nodeId, "keydown", {
          visibleRows: getVisibleNodeIds().length,
        });
        saveDrafts();
        suppressHandledBlur();
        // Fast path (plan Track T1): move the DOM caret straight to the target
        // row's title, skipping the focusNode reducer round trip. The reducer
        // catches up on a later frame via notifyCaretMovedByDom. Arrow moves
        // between rows always land in the title field.
        const paneRoot =
          event.currentTarget.closest<HTMLElement>(".notes-outline");
        const edge = resolution.selection
          ? {
              start: resolution.selection.anchorUtf16,
              end: resolution.selection.focusUtf16,
            }
          : null;
        if (
          paneRoot &&
          actions.notifyCaretMovedByDom &&
          focusOutlineEditorDom(paneRoot, resolution.nodeId, "title", edge)
        ) {
          markCaretPhase(resolution.nodeId, "dom-focus");
          actions.notifyCaretMovedByDom(resolution.nodeId, "title");
          return;
        }
        // Fallback: the target row is not mounted or the browser refused focus,
        // so hand off to the reducer focus path (which republishes a request).
        void (resolution.selection
          ? actions.focusNode(resolution.nodeId, resolution.selection)
          : actions.focusNode(resolution.nodeId));
        return;
      }
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
            draft: patch,
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
      platform: detectOutlineShortcutPlatform(),
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
      workspace: getStateSnapshot().state,
      visibleNodeIds: getVisibleNodeIds(),
      outdentBoundaryRootId: GITHUB_NOTIFICATIONS_ROOT_ID,
      selection: getSelection(),
    });
    if (!resolution) return;

    event.preventDefault();
    if (contentProtected || movementProtected) {
      if (
        resolution.type === "move" ||
        resolution.type === "consumeTabShortcut" ||
        resolution.type === "batchIndent" ||
        resolution.type === "batchOutdent"
      ) {
        if (contentProtected) commitDrafts();
        return;
      }
      if (
        contentProtected &&
        (resolution.type === "delete" ||
          resolution.type === "remove" ||
          resolution.type === "batchDelete")
      ) {
        commitDrafts();
        return;
      }
      if (resolution.type === "createNextTextSibling") {
        commitDrafts();
        runStructuralCommand(() => actions.createNextTextSibling(nodeId));
        return;
      }
      if (
        resolution.type === "focus" ||
        resolution.type === "focusNote" ||
        resolution.type === "extendSelection" ||
        resolution.type === "clearSelection"
      ) {
        commitDrafts();
      }
    }
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
            expandNodeId: resolution.expandNodeId,
          }),
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
            completed: resolution.completed,
          }),
        );
        return;
      case "batchDelete":
        runStructuralCommand(() =>
          actions.applyBatch(
            resolution.nodeIds,
            { type: "delete" },
            { focusNodeId: resolution.focusNodeId },
          ),
        );
        return;
      case "batchIndent":
        runStructuralCommand(() =>
          actions.applyBatch(resolution.nodeIds, { type: "indent" }),
        );
        return;
      case "batchOutdent":
        runStructuralCommand(() =>
          actions.applyBatch(resolution.nodeIds, { type: "outdent" }),
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
    if (contentProtected) {
      setProtectedDraft({ ...nextDraft });
      return;
    }
    actions.updateNodeDraft(nodeId, nextDraft, "title");
  };

  const commitRemoteMarkdownImageWidth = (width: number) => {
    actions.updateNodeDraft(
      nodeId,
      {
        title: titleValue,
        note: noteValue,
        imageOffsetUtf16,
        markdownImageWidth: width,
      },
      "title",
    );
    void actions.flushNodeDraft(nodeId);
  };

  const runImageAtomEnter = () => {
    if (contentProtected) {
      commitDrafts();
      runStructuralCommand(() => actions.createNextTextSibling(nodeId));
      return;
    }
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
        siblingId,
      });
    });
  };

  const runImageAtomKeyboardRemove = () => {
    runStructuralCommand(async () => {
      const selection = await imageEditorRef.current?.flushAndGetSelection();
      return selection
        ? actions.applyImageAtomEdit(nodeId, selection, {
            kind: "remove",
            replacementText: "",
          })
        : "skipped";
    });
  };

  const runImageAtomCut = async ({
    selection,
    selectionAuthority,
  }: ImageAtomEditorCutRequest) => {
    const editor = imageEditorRef.current;
    if (
      !editor ||
      !getLiveAction("captureActiveImageAtomEditorAuthority") ||
      !getLiveAction("captureImageAtomCutAuthority") ||
      !getLiveAction("applyImageAtomCutWithAuthority")
    ) {
      return false;
    }
    const editorAuthority = getLiveAction(
      "captureActiveImageAtomEditorAuthority",
    )!(nodeId, selectionAuthority);
    if (!editorAuthority || (await editor.flush()) !== "flushed") return false;
    if (imageEditorRef.current !== editor) return false;
    let persisted = false;
    try {
      persisted = await actions.flushNodeDraft(nodeId);
    } catch {
      return false;
    }
    if (!persisted || imageEditorRef.current !== editor) return false;
    const cutAuthority = getLiveAction("captureImageAtomCutAuthority")!(
      nodeId,
      editorAuthority,
    );
    if (!cutAuthority) return false;
    return (
      (await getLiveAction("applyImageAtomCutWithAuthority")!(
        cutAuthority,
        nodeId,
        { ...selection },
      )) === "committed"
    );
  };

  const runImageAtomMenuRemove = () => {
    runStructuralCommand(async () => {
      const result = await imageEditorRef.current?.flush();
      if (result !== "flushed" && result !== "deferred") return "skipped";
      return actions.applyImageAtomEdit(
        nodeId,
        {
          anchorUtf16: imageOffsetUtf16,
          focusUtf16: imageOffsetUtf16 + 1,
        },
        { kind: "remove", replacementText: "" },
      );
    });
  };

  const claimEditingFocus = (
    field: "title" | "note",
    target: HTMLElement,
  ): void => {
    if (!actions.claimEditingFocus) {
      actions.markEditingFocus?.(nodeId, field);
      return;
    }
    void actions.claimEditingFocus(nodeId, field).then((claimed) => {
      if (!claimed && document.activeElement === target) target.blur();
    });
  };

  const handleImageAtomPaste = (event: globalThis.ClipboardEvent): boolean => {
    if (!isImageIngestEnabled() || !event.clipboardData) return false;
    const clipboardData = event.clipboardData;
    const candidate = readNotesImageAtomPasteCandidate(clipboardData);
    if (!candidate.claimed) return false;

    event.preventDefault();
    const parse = parseNotesImageAtomPaste(candidate).catch(() => ({
      kind: "none" as const,
    }));
    const editor = imageEditorRef.current;
    void (async () => {
      const initial = await editor?.flushAndGetSelectionSnapshot();
      if (!editor || !initial || imageEditorRef.current !== editor) return;
      const editorAuthority = getLiveAction(
        "captureActiveImageAtomEditorAuthority",
      )?.(nodeId, initial.authority);
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
        !isImageIngestEnabled()
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
      const authority = getLiveAction("captureImageAtomPasteAuthority")?.(
        nodeId,
        editorAuthority,
      );
      const applyImageAtomPasteWithAuthority = getLiveAction(
        "applyImageAtomPasteWithAuthority",
      );
      if (!authority || !applyImageAtomPasteWithAuthority) return;
      const exactSelection = { ...admitted.selection };
      const parsed = await parse;
      if (parsed.kind !== "imageAtom" && parsed.kind !== "external") return;
      if (
        !getLiveAction("isImageAtomPasteAuthorityCurrent")?.(authority) ||
        imageEditorRef.current !== editor ||
        !imageRef.current?.contains(document.activeElement) ||
        !isImageIngestEnabled()
      ) {
        return;
      }
      const live = await editor.flushAndGetSelectionSnapshot();
      if (
        !live ||
        live.selection.anchorUtf16 !== exactSelection.anchorUtf16 ||
        live.selection.focusUtf16 !== exactSelection.focusUtf16 ||
        live.authority !== admitted.authority ||
        !getLiveAction("isImageAtomPasteAuthorityCurrent")?.(authority) ||
        imageEditorRef.current !== editor ||
        !imageRef.current?.contains(document.activeElement) ||
        !isImageIngestEnabled()
      ) {
        return;
      }
      runStructuralCommand(() =>
        applyImageAtomPasteWithAuthority(
          authority,
          nodeId,
          exactSelection,
          parsed.value,
        ),
      );
    })().catch(() => undefined);
    return true;
  };

  return (
    <>
      {guides}
      <div className="notes-node-main">
        <div className="notes-node-menu-slot">
          {!pluginRoot && (
            <NotesBulletMenu
              label={navigationLabel}
              completed={completed}
              markerKind={markerKind}
              starred={node.isStarred}
              isReadonly={node.isReadonly === true}
              hasNote={Boolean(noteValue.trim())}
              saveFailed={draft?.status === "failed"}
              disabled={disabled}
              actionBusy={false}
              createdAt={node.createdAt}
              updatedAt={node.updatedAt}
              selectionBridge={selectionBridge}
              subscribeExportState={subscribeExportState}
              getExportSnapshot={getExportSnapshot}
              onOpenChange={(open) => {
                if (open && !selectionBridge && getSelection()) {
                  actions.clearSelection();
                }
              }}
              getMoveDestinations={() => {
                preparedMoveRef.current = null;
                const prepareMoveNode = getLiveAction("prepareMoveNode");
                if (prepareMoveNode) {
                  return prepareMoveNode(nodeId).then((prepared) => {
                    preparedMoveRef.current = prepared;
                    return buildNotesMoveDestinations(
                      Object.fromEntries(
                        prepared.nodes.map((item) => [item.id, item]),
                      ),
                      nodeId,
                    );
                  });
                }
                const loadActiveNodesForMove = getLiveAction(
                  "loadActiveNodesForMove",
                );
                if (!loadActiveNodesForMove) {
                  return buildNotesMoveDestinations(
                    getStateSnapshot().state.nodesById,
                    nodeId,
                  );
                }
                return loadActiveNodesForMove()
                  .then((nodes) =>
                    buildNotesMoveDestinations(
                      Object.fromEntries(nodes.map((item) => [item.id, item])),
                      nodeId,
                    ),
                  )
                  .catch(() =>
                    buildNotesMoveDestinations(
                      getStateSnapshot().state.nodesById,
                      nodeId,
                    ),
                  );
              }}
              onToggleComplete={() =>
                runStructuralCommand(() => actions.toggleComplete(nodeId))
              }
              onChangeMarkerKind={(markerKind) =>
                runStructuralCommand(() =>
                  actions.updateNode(nodeId, {
                    title: titleValue,
                    note: noteValue,
                    markerKind,
                  }),
                )
              }
              onToggleStar={() =>
                runStructuralCommand(() => actions.toggleStar(nodeId))
              }
              onToggleReadonly={
                actions.setReadonly
                  ? () =>
                      runStructuralCommand(() =>
                        actions.setReadonly!(nodeId, node.isReadonly !== true),
                      )
                  : undefined
              }
              onOpenNote={openAndFocusNote}
              onAddDate={() => {
                if (node.nodeKind === "image") {
                  openNoteDate();
                  return;
                }
                datePicker.openTitleDate(
                  titleSelectionRef.current ?? undefined,
                );
                titleSelectionRef.current = null;
              }}
              onUploadImage={
                actions.uploadImage
                  ? () => void actions.uploadImage?.(nodeId)
                  : undefined
              }
              onMoveTo={
                movementProtected
                  ? undefined
                  : (destinationId) => {
                      const commitPreparedMove =
                        getLiveAction("commitPreparedMove");
                      if (preparedMoveRef.current && commitPreparedMove) {
                        return commitPreparedMove(
                          preparedMoveRef.current,
                          destinationId,
                        );
                      }
                      const input = buildNotesMoveNodeInput(
                        getStateSnapshot().state.nodesById,
                        nodeId,
                        destinationId,
                      );
                      if (input) {
                        runStructuralCommand(() =>
                          actions.moveNode(input, nodeId),
                        );
                        return { ok: true } as const;
                      }
                      return {
                        ok: false,
                        error:
                          "That destination is no longer valid. Refresh Move To.",
                      } as const;
                    }
              }
              onExpandAll={() =>
                runStructuralCommand(() => actions.expandAll(nodeId))
              }
              onCollapseAll={() =>
                runStructuralCommand(() => actions.collapseAll(nodeId))
              }
              onSortAscending={
                movementProtected
                  ? undefined
                  : () =>
                      runStructuralCommand(() =>
                        actions.sortSubtreeAscending(nodeId),
                      )
              }
              onSortDescending={
                movementProtected
                  ? undefined
                  : () =>
                      runStructuralCommand(() =>
                        actions.sortSubtreeDescending(nodeId),
                      )
              }
              onRemoveNote={removeNote}
              onDuplicate={() =>
                runStructuralCommand(() => actions.duplicateNode(nodeId))
              }
              onExport={(format) =>
                getExportController().startExport(
                  nodeId,
                  node.nodeKind === "image" ? label : titleValue,
                  format,
                )
              }
              onDelete={() =>
                runStructuralCommand(() => actions.deleteNode(nodeId))
              }
              onRetrySave={() =>
                runStructuralCommand(() =>
                  getLiveAction("retryFailedDraft")!(nodeId),
                )
              }
            />
          )}
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

        <OutlineSortableHandle
          enabled={dragEnabled}
          className="notes-node-bullet"
          type="button"
          onKeyDown={handleBulletKeyDown}
          aria-label={`Zoom into ${navigationLabel}`}
          aria-description={dragDisabledReason}
          disabled={disabled}
          data-collapsed={hasChildren && isCollapsed ? "true" : undefined}
          data-sortable-activator={dragEnabled ? "true" : undefined}
          onPointerDownCapture={(event) => {
            trackDisabledDragAttempt(event);
            shiftClickAnchorRef.current =
              event.shiftKey && !selectionDisabled
                ? activeSelectionRowId()
                : undefined;
          }}
          onClick={(event) => {
            if (suppressNextPointerClickRef.current && event.detail > 0) {
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
                  : capturedAnchorId,
              );
              return;
            }
            void actions.zoomTo(nodeId);
          }}
        >
          <span className="notes-node-bullet-dot" aria-hidden="true" />
        </OutlineSortableHandle>

        {isTodo && (
          <NotesTodoCheckbox
            checked={completed}
            disabled={disabled}
            label={`${completed ? "Mark incomplete" : "Mark complete"}: ${navigationLabel}`}
            onToggle={() =>
              runStructuralCommand(() => actions.toggleComplete(nodeId))
            }
          />
        )}

        <div
          className="notes-node-content-line"
          data-readonly={contentProtected ? "true" : undefined}
          style={contentProtected ? { gridColumn: isTodo ? 5 : 4 } : undefined}
        >
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
          ) : node.nodeKind === "image" ? (
            primaryImageAttachment ? (
              <div
                style={{ gridColumn: isTodo ? 5 : 4, gridRow: 1, minWidth: 0 }}
              >
                <ImageAtomEditor
                  ref={imageEditorRef}
                  nodeId={nodeId}
                  draft={{
                    title: titleValue,
                    note: noteValue,
                    imageOffsetUtf16,
                  }}
                  attachment={primaryImageAttachment}
                  onDraftChange={updateImageDraft}
                  registerFlushAdapter={actions.registerImageAtomFlushAdapter}
                  registerActiveEditor={getLiveAction(
                    "registerActiveImageAtomEditor",
                  )}
                  onFocusLeave={contentProtected ? commitDrafts : undefined}
                  onEnter={runImageAtomEnter}
                  onAtomDelete={
                    contentProtected ? undefined : runImageAtomKeyboardRemove
                  }
                  onUnhandledKeyDown={handleImageKeyDown}
                  onSupportingNote={
                    contentProtected
                      ? () => {
                          commitDrafts();
                          openAndFocusNote();
                        }
                      : openAndFocusNote
                  }
                  onUndo={() => void actions.undo?.()}
                  onRedo={() => void actions.redo?.()}
                  onImageAtomPaste={
                    contentProtected
                      ? (event) =>
                          event.clipboardData !== null &&
                          readNotesImageAtomPasteCandidate(event.clipboardData)
                            .claimed
                      : handleImageAtomPaste
                  }
                  loadAttachmentBytes={
                    disabled ? undefined : actions.loadAttachmentBytes
                  }
                  onAtomCut={
                    disabled || contentProtected ? undefined : runImageAtomCut
                  }
                  onTagClick={(token) =>
                    void actions.toggleTagFilter({
                      prefix: token.prefix,
                      normalizedTag: token.normalized,
                    })
                  }
                  onDateClick={
                    disabled
                      ? undefined
                      : (token, anchor) =>
                          datePicker.openExistingDate(
                            "title",
                            token,
                            anchor,
                            imageRef.current ?? undefined,
                          )
                  }
                  onDateTrigger={
                    disabled
                      ? undefined
                      : (range, anchor, source) =>
                          datePicker.openTypedDate(
                            "title",
                            range,
                            anchor,
                            source,
                          )
                  }
                  isTagActive={(token) =>
                    getStateSnapshot().activeTagFilters.some(
                      (filter) =>
                        filter.prefix === token.prefix &&
                        filter.normalizedTag === token.normalized,
                    )
                  }
                  today={datePicker.today}
                  getToday={datePicker.getToday}
                  slashCommands
                  onSlashMarkerCommand={(markerKind, nextDraft) =>
                    actions.updateNodeDraft(
                      nodeId,
                      { ...nextDraft, markerKind },
                      "title",
                    )
                  }
                  className="notes-node-primary-image"
                  contentRef={imageRef}
                  atomReadOnly={contentProtected}
                  disabled={disabled}
                  onRemoveImage={
                    contentProtected ? undefined : runImageAtomMenuRemove
                  }
                />
              </div>
            ) : (
              <NotesImageNodeContent
                nodeId={nodeId}
                attachment={attachments[0]}
                originalName={titleValue || node.title}
                className="notes-node-primary-image"
                style={{ gridColumn: isTodo ? 5 : 4, gridRow: 1, minWidth: 0 }}
                contentRef={imageRef}
                onKeyDown={handleImageKeyDown}
                readOnly={contentProtected}
                disabled={disabled}
              />
            )
          ) : (
            <NoteTextField
              markdown
              restingPresentation={
                remoteMarkdownImage
                  ? (requestEdit) => (
                      <NotesRemoteMarkdownImage
                        nodeId={nodeId}
                        alt={remoteMarkdownImage.alt}
                        url={remoteMarkdownImage.url}
                        persistedWidth={markdownImageWidth}
                        disabled={disabled || contentProtected}
                        onDisplayWidthCommit={
                          contentProtected
                            ? () => undefined
                            : commitRemoteMarkdownImageWidth
                        }
                        onEditRequest={requestEdit}
                      />
                    )
                  : undefined
              }
              slashCommands
              onSlashMarkerCommand={(markerKind, value) =>
                contentProtected
                  ? setProtectedDraft((current) => ({
                      ...current,
                      title: value,
                    }))
                  : actions.updateNodeDraft(
                      nodeId,
                      {
                        title: value,
                        note: noteValue,
                        imageOffsetUtf16,
                        markerKind,
                      },
                      "title",
                    )
              }
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
                  normalizedTag: token.normalized,
                })
              }
              isTagActive={(token) =>
                getStateSnapshot().activeTagFilters.some(
                  (filter) =>
                    filter.prefix === token.prefix &&
                    filter.normalizedTag === token.normalized,
                )
              }
              onChange={(event) => {
                resizeTextarea(event.currentTarget);
                if (contentProtected) {
                  setProtectedDraft((current) => ({
                    ...current,
                    title: event.target.value,
                  }));
                  return;
                }
                actions.updateNodeDraft(
                  nodeId,
                  {
                    title: event.target.value,
                    note: noteValue,
                    imageOffsetUtf16,
                  },
                  "title",
                );
              }}
              onFocus={(event) => {
                if (contentProtected) {
                  protectedFocusRef.current = {
                    field: "title",
                    startUtf16: event.currentTarget.selectionStart,
                    endUtf16: event.currentTarget.selectionEnd,
                  };
                }
                if (!pendingFocusInProgressRef.current) {
                  claimEditingFocus("title", event.currentTarget);
                }
              }}
              onKeyDown={handleTitleKeyDown}
              onPaste={(event) => handlePaste(event, "title")}
              onSelect={(event) => {
                titleSelectionRef.current = {
                  startUtf16: event.currentTarget.selectionStart,
                  endUtf16: event.currentTarget.selectionEnd,
                };
                if (contentProtected) {
                  protectedFocusRef.current = {
                    field: "title",
                    startUtf16: event.currentTarget.selectionStart,
                    endUtf16: event.currentTarget.selectionEnd,
                  };
                }
              }}
              onBlur={(event) => {
                protectedFocusRef.current = null;
                titleSelectionRef.current = {
                  startUtf16: event.currentTarget.selectionStart,
                  endUtf16: event.currentTarget.selectionEnd,
                };
                if (!datePicker.shouldSuppressBlur()) {
                  commitDrafts();
                }
              }}
            />
          )}
          {contentProtected && (
            <span className="notes-node-inline-actions notes-node-readonly-actions">
              <span
                className="notes-node-lock"
                role="img"
                aria-label="읽기 전용"
              >
                <Lock size={12} aria-hidden="true" />
              </span>
            </span>
          )}
        </div>
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
              normalizedTag: token.normalized,
            })
          }
          isTagActive={(token) =>
            getStateSnapshot().activeTagFilters.some(
              (filter) =>
                filter.prefix === token.prefix &&
                filter.normalizedTag === token.normalized,
            )
          }
          onKeyDown={(event) => {
            if (
              contentProtected &&
              (event.nativeEvent.isComposing ||
                event.nativeEvent.key === "Process")
            ) {
              return;
            }
            const historyShortcut = resolveNotesHistoryShortcut({
              key: event.key,
              altKey: event.altKey,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
              platform: detectOutlineShortcutPlatform(),
            });
            if (historyShortcut) {
              event.preventDefault();
              void actions[historyShortcut]?.();
              return;
            }
            if (
              contentProtected &&
              event.key === "Escape" &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              commitDrafts();
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
              value: event.currentTarget.value,
            });
            if (!resolution) {
              return;
            }
            event.preventDefault();
            const focusTarget = supportingNoteFocusTarget(
              resolution,
              nodeId,
              getVisibleNodeIds(),
            );
            if (contentProtected) {
              commitDrafts();
              if (resolution === "nextTitleOrCreate") {
                runStructuralCommand(() =>
                  actions.createNextTextSibling(nodeId),
                );
                return;
              }
              void actions.focusNode(focusTarget);
              return;
            }
            actions.updateNodeDraft(
              nodeId,
              {
                title: titleValue,
                note: event.currentTarget.value,
                imageOffsetUtf16,
              },
              "note",
            );
            if (resolution === "nextTitleOrCreate" && focusTarget === nodeId) {
              runStructuralCommand(() => actions.createNextTextSibling(nodeId));
              return;
            }
            void actions.flushNodeDraft(nodeId);
            void actions.focusNode(focusTarget);
          }}
          onChange={(event) => {
            resizeTextarea(event.currentTarget);
            if (contentProtected) {
              setProtectedDraft((current) => ({
                ...current,
                note: event.target.value,
              }));
              return;
            }
            actions.updateNodeDraft(
              nodeId,
              {
                title: titleValue,
                note: event.target.value,
                imageOffsetUtf16,
              },
              "note",
            );
          }}
          onFocus={(event) => {
            noteBlurredDuringCompositionRef.current = false;
            if (contentProtected) {
              protectedFocusRef.current = {
                field: "note",
                startUtf16: event.currentTarget.selectionStart,
                endUtf16: event.currentTarget.selectionEnd,
              };
            }
            if (!pendingFocusInProgressRef.current) {
              claimEditingFocus("note", event.currentTarget);
            }
          }}
          onPaste={(event) => handlePaste(event, "note")}
          onSelect={(event) => {
            if (contentProtected) {
              protectedFocusRef.current = {
                field: "note",
                startUtf16: event.currentTarget.selectionStart,
                endUtf16: event.currentTarget.selectionEnd,
              };
            }
          }}
          onBlur={(event) => {
            protectedFocusRef.current = null;
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
      <NotesTodoProgress
        value={todoProgress}
        className="notes-node-todo-progress"
      />
      {node.nodeKind === "text" ? (
        attachments.length > 0 || attachmentUploadError ? (
          <NotesAttachmentList
            nodeId={nodeId}
            attachments={attachments}
            uploadError={attachmentUploadError}
            uploadRetryAttemptId={attachmentUploadRetryAttemptId}
            className="notes-node-attachments"
            readOnly={disabled || contentProtected}
          />
        ) : null
      ) : attachmentUploadError ? (
        <NotesImageUploadStatus
          nodeId={nodeId}
          uploadError={attachmentUploadError}
          uploadRetryAttemptId={attachmentUploadRetryAttemptId}
          readOnly={disabled || contentProtected}
        />
      ) : null}
      {imageDropEnabled && showDropPlaceholder && (
        <span
          className="notes-image-drop-position"
          data-testid="notes-image-drop-position"
          aria-hidden="true"
        />
      )}
      {datePicker.picker}
      {trashConfirmOpen && (
        <ConfirmDialog
          open
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
      )}
    </>
  );
}

// Memoized so a draft keystroke in one row (which re-renders the pane shell and
// re-creates every row element) only re-renders the row whose atomic props
// actually changed. All props are primitives, referentially stable objects, or
// stable callbacks; the drafts context is read at the pane and passed down as
// the `draft`/attachment props so sibling rows keep identical props and bail.
export const MemoizedOutlineNodeEditor = memo(OutlineNodeEditorComponent);
