import type { ClipboardEvent, KeyboardEvent, ReactNode } from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesStore } from "./notesStore";
import type { OutlineIndex } from "./outlineIndex";
import {
  focusOutlineEditor,
  focusOutlineEditorAt,
  type OutlineFocusEdge
} from "./outlineFocus";
import { parsePastedOutline } from "./outlinePaste";
import { clipboardImageCandidates } from "./imageClipboard";
import {
  handleImageNodeKeyDown,
  resolveOutlineKey,
  type OutlineKeyIntent
} from "./outlineKeyboard";
import { measureTextareaCaretLines } from "./textareaCaretLines";

export interface SelectionKeyboardActions {
  readonly indent: () => void;
  readonly outdent: () => void;
  readonly move: (direction: "up" | "down") => void;
  readonly toggleComplete: () => void;
  readonly duplicate: () => void;
  readonly delete: () => void;
  readonly copy: () => void;
  readonly cut: () => void;
}

interface EnterSplitGesture {
  // The row holding the caret and the half after it, which is what the next
  // repeat splits again. Always the row the split just created.
  readonly tailId: string;
  readonly parentId: string;
  readonly beforeId: string | null;
}

const enterSplitGestures = new WeakMap<HTMLElement, EnterSplitGesture>();
const pendingOutlineFocus = new WeakMap<HTMLElement, {
  readonly nodeId: string;
  readonly edge: OutlineFocusEdge;
}>();

export function endOutlineEnterGesture(target: HTMLElement): void {
  const scope = target.closest<HTMLElement>(".notes-outline");
  if (scope) enterSplitGestures.delete(scope);
}

/**
 * One bullet-menu row: `icon | label | shortcut` in the 3-column grid the
 * stylesheet defines. A disabled item stays visible, dimmed, and focusable so
 * arrow roving can reach it and a screen reader can read `reason`; only its
 * activation is suppressed.
 */
export function RowMenuItem({
  icon, label, shortcut, keyshortcuts, danger = false, disabled = false,
  reason, onClick
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly shortcut?: string;
  readonly keyshortcuts?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly reason?: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      className="notes-bullet-menu-item"
      type="button"
      role="menuitem"
      data-danger={danger ? "true" : undefined}
      data-disabled={disabled ? "true" : undefined}
      aria-disabled={disabled || undefined}
      aria-keyshortcuts={keyshortcuts}
      title={disabled ? reason : undefined}
      style={{ width: "100%", border: 0, background: "transparent" }}
      onClick={() => {
        if (!disabled) onClick();
      }}
    >
      {icon}
      <span>{label}</span>
      {/* `aria-keyshortcuts` already carries the binding, so keeping the
          printed hint out of the accessible name leaves it just "Duplicate". */}
      {shortcut && (
        <span className="notes-bullet-menu-shortcut" aria-hidden="true">
          {shortcut}
        </span>
      )}
    </button>
  );
}

export function handleMultilinePaste(
  event: ClipboardEvent<HTMLElement>,
  store: NotesStore,
  node: NoteView
) {
  const images = clipboardImageCandidates(event.clipboardData);
  if (images.length > 0 && node.parentId) {
    event.preventDefault();
    const state = store.getSnapshot();
    const siblings = state.nodes
      .filter((candidate) =>
        candidate.parentId === node.parentId && !candidate.deleted)
      .sort((left, right) =>
        left.sortKey - right.sortKey || left.id.localeCompare(right.id));
    const position = siblings.findIndex((candidate) => candidate.id === node.id);
    const beforeId = position >= 0 ? siblings[position + 1]?.id ?? null : null;
    const scope = event.currentTarget.closest<HTMLElement>(".notes-outline");
    void store.images.importAfter(node.parentId, beforeId, images).then((id) => {
      if (scope) requestAnimationFrame(() =>
        focusOutlineEditor(scope, id, "start"));
    });
    return;
  }
  const roots = parsePastedOutline(event.clipboardData.getData("text/plain"));
  if (!roots) return;
  event.preventDefault();
  const scope = event.currentTarget.closest<HTMLElement>(".notes-outline");
  void store.importOutline(node.id, null, roots).then((id) => {
    if (scope) requestAnimationFrame(() => focusOutlineEditor(scope, id, "start"));
  });
}

export function handleOutlineKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  store: NotesStore,
  node: NoteView,
  nodes: readonly NoteView[],
  visibleNodes: readonly NoteView[],
  structureIndex: OutlineIndex,
  visibleIndex: OutlineIndex,
  pageId: string,
  onZoomIn: () => void,
  onZoomOut: () => void,
  selectionHeadId: string | null,
  hasSelection: boolean,
  onExtendSelection: (originId: string, headId: string) => void,
  onClearSelection: (collapse?: "start" | "end") => void,
  onFocusNote: () => void,
  onMoveTo: () => void,
  supportingNote: string,
  selectionActions: SelectionKeyboardActions
) {
  const backspaceGroup = updateBackspaceGesture(event, store);
  const caretLines = event.key === "ArrowUp" || event.key === "ArrowDown"
    ? measureTextareaCaretLines(event.currentTarget)
    : { first: true, last: true };
  const intent = resolveOutlineKey({
    key: event.key,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    isComposing: event.nativeEvent.isComposing,
    repeat: event.repeat,
    nodeId: node.id,
    pageId,
    value: event.currentTarget.value,
    supportingNote,
    selectionStart: event.currentTarget.selectionStart,
    selectionEnd: event.currentTarget.selectionEnd,
    selectionDirection: event.currentTarget.selectionDirection ?? undefined,
    firstVisualLine: caretLines.first,
    lastVisualLine: caretLines.last,
    visibleNodes,
    structureNodes: nodes,
    visibleIndex,
    structureIndex,
    selectionHeadId,
    hasSelection,
    target: "row",
    platform: outlinePlatform()
  });
  if (!intent) return;

  event.preventDefault();
  // The sweep over a row's own text stays inside the field it started in, so it
  // needs no outline scope and no store round trip.
  if (intent.kind === "selectTextEdge") {
    event.currentTarget.setSelectionRange(
      intent.start, intent.end, intent.direction
    );
    return;
  }
  const scope = event.currentTarget.closest<HTMLElement>(".notes-outline");
  if (!scope) return;
  if (hasSelection) {
    if (intent.kind === "indent") return selectionActions.indent();
    if (intent.kind === "outdent") return selectionActions.outdent();
    if (intent.kind === "move") return selectionActions.move(intent.direction);
    if (intent.kind === "toggleComplete") return selectionActions.toggleComplete();
    if (intent.kind === "duplicate") return selectionActions.duplicate();
    if (intent.kind === "trash") return selectionActions.delete();
  }
  executeRowIntent(
    intent,
    scope,
    store,
    node,
    nodes,
    structureIndex,
    onZoomIn,
    onZoomOut,
    onExtendSelection,
    onClearSelection,
    onFocusNote,
    onMoveTo,
    backspaceGroup,
    event.repeat
  );
}

function imageEdgeOf(target: EventTarget): "before" | "after" | undefined {
  const edge = target instanceof HTMLElement
    ? target.dataset.imageEdge
    : undefined;
  return edge === "before" || edge === "after" ? edge : undefined;
}

export function handleImagePrimaryKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  store: NotesStore,
  node: NoteView,
  nodes: readonly NoteView[],
  visibleNodes: readonly NoteView[],
  structureIndex: OutlineIndex,
  visibleIndex: OutlineIndex,
  pageId: string,
  onZoomIn: () => void,
  onZoomOut: () => void,
  selectionHeadId: string | null,
  hasSelection: boolean,
  onExtendSelection: (originId: string, headId: string) => void,
  onClearSelection: (collapse?: "start" | "end") => void,
  onFocusNote: () => void,
  onMoveTo: () => void,
  selectionActions: SelectionKeyboardActions,
  onCopyImage: (nodeId: string) => void,
  onCutImage: (nodeId: string) => void,
  soloSelectedId: string | null = null
) {
  // A plain arrow off a selected image drops the selection and leaves the caret
  // on the side it names, the way it collapses a selected letter.
  if (
    soloSelectedId === node.id &&
    (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.nativeEvent.isComposing
  ) {
    event.preventDefault();
    const collapseScope =
      event.currentTarget.closest<HTMLElement>(".notes-outline");
    if (!collapseScope) return;
    onClearSelection();
    focusOutlineEditor(
      collapseScope, node.id, event.key === "ArrowLeft" ? "start" : "end"
    );
    return;
  }
  const intent = handleImageNodeKeyDown({
    key: event.key,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    isComposing: event.nativeEvent.isComposing,
    repeat: event.repeat,
    nodeId: node.id,
    pageId,
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    firstVisualLine: true,
    lastVisualLine: true,
    visibleNodes,
    structureNodes: nodes,
    visibleIndex,
    structureIndex,
    selectionHeadId,
    hasSelection,
    // The station the key came from is the caret's side of the image; a key on
    // the frame itself belongs to no side.
    imageEdge: imageEdgeOf(event.target),
    target: "row",
    platform: outlinePlatform()
  });
  if (!intent) return;
  event.preventDefault();
  const scope = event.currentTarget.closest<HTMLElement>(".notes-outline");
  if (!scope) return;
  if (hasSelection) {
    if (intent.kind === "indent") return selectionActions.indent();
    if (intent.kind === "outdent") return selectionActions.outdent();
    if (intent.kind === "move") return selectionActions.move(intent.direction);
    if (intent.kind === "toggleComplete") return selectionActions.toggleComplete();
    if (intent.kind === "duplicate") return selectionActions.duplicate();
    if (intent.kind === "trash") return selectionActions.delete();
  }
  // A selection already carries this image's bytes, so the chord goes to the
  // selection commands and only a bare station falls through to the node.
  if (intent.kind === "copyImage") {
    return hasSelection ? selectionActions.copy() : onCopyImage(node.id);
  }
  if (intent.kind === "cutImage") {
    return hasSelection ? selectionActions.cut() : onCutImage(node.id);
  }
  // The stop between the two stations is the image itself, which is the element
  // this handler is already mounted on.
  if (intent.kind === "focusImage") {
    event.currentTarget.focus();
    return;
  }
  executeRowIntent(
    intent,
    scope,
    store,
    node,
    nodes,
    structureIndex,
    onZoomIn,
    onZoomOut,
    onExtendSelection,
    onClearSelection,
    onFocusNote,
    onMoveTo,
    null,
    event.repeat
  );
}

export function handlePageKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  store: NotesStore,
  pageId: string,
  nodes: readonly NoteView[],
  visibleNodes: readonly NoteView[],
  structureIndex: OutlineIndex,
  visibleIndex: OutlineIndex,
  onZoomOut: () => void,
  onFocusNote: () => void
) {
  updateBackspaceGesture(event, store);
  executePageIntent(event, resolveOutlineKey({
    key: event.key,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    isComposing: event.nativeEvent.isComposing,
    repeat: event.repeat,
    nodeId: pageId,
    pageId,
    value: event.currentTarget.value,
    selectionStart: event.currentTarget.selectionStart,
    selectionEnd: event.currentTarget.selectionEnd,
    firstVisualLine: true,
    lastVisualLine: true,
    visibleNodes,
    structureNodes: nodes,
    visibleIndex,
    structureIndex,
    target: "page",
    platform: outlinePlatform()
  }), store, pageId, structureIndex, onZoomOut, onFocusNote);
}

/**
 * The same keys for the zoom header when the zoom root is an image: it has no
 * text field to type into, so the caret station answers in its place.
 */
export function handleImagePageKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  store: NotesStore,
  pageId: string,
  nodes: readonly NoteView[],
  visibleNodes: readonly NoteView[],
  structureIndex: OutlineIndex,
  visibleIndex: OutlineIndex,
  onZoomOut: () => void,
  onFocusNote: () => void
) {
  executePageIntent(event, resolveOutlineKey({
    key: event.key,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    isComposing: event.nativeEvent.isComposing,
    repeat: event.repeat,
    nodeId: pageId,
    pageId,
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    firstVisualLine: true,
    lastVisualLine: true,
    visibleNodes,
    structureNodes: nodes,
    visibleIndex,
    structureIndex,
    target: "page",
    platform: outlinePlatform()
  }), store, pageId, structureIndex, onZoomOut, onFocusNote);
}

function executePageIntent(
  event: KeyboardEvent<HTMLElement>,
  intent: OutlineKeyIntent | null,
  store: NotesStore,
  pageId: string,
  structureIndex: OutlineIndex,
  onZoomOut: () => void,
  onFocusNote: () => void
): void {
  if (!intent) return;
  event.preventDefault();
  const scope = event.currentTarget.closest<HTMLElement>(".notes-outline");
  if (!scope) return;
  if (intent.kind === "focus") {
    focusOutlineEditor(scope, intent.nodeId, intent.edge);
  } else if (intent.kind === "createFirstChild") {
    createFirstChild(scope, store, structureIndex, intent.parentId);
  } else if (intent.kind === "zoom" && intent.direction === "out") {
    void store.flushDraft(pageId).then(onZoomOut);
  } else if (intent.kind === "focusNote") {
    onFocusNote();
  }
}

export function outlinePlatform(): "mac" | "other" {
  return /Mac|iPhone|iPad|iPod/iu.test(globalThis.navigator?.platform ?? "")
    ? "mac"
    : "other";
}

function updateBackspaceGesture(
  event: KeyboardEvent<HTMLTextAreaElement>,
  store: NotesStore
): string | null {
  const isPlainBackspace = event.key === "Backspace" &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.nativeEvent.isComposing;
  if (isPlainBackspace) return store.beginBackspaceGesture(event.repeat);
  store.endBackspaceGesture();
  return null;
}

function focusAfter(
  scope: HTMLElement,
  nodeId: string,
  edge: OutlineFocusEdge
): void {
  const request = { nodeId, edge };
  pendingOutlineFocus.set(scope, request);
  queueMicrotask(() => {
    if (pendingOutlineFocus.get(scope) !== request) return;
    pendingOutlineFocus.delete(scope);
    focusOutlineEditor(scope, nodeId, edge);
  });
}

function createFirstChild(
  scope: HTMLElement,
  store: NotesStore,
  index: OutlineIndex,
  parentId: string
): void {
  const beforeId = index.firstChildId(parentId);
  const pending = store.beginCreateNode(parentId, "", beforeId);
  focusAfter(scope, pending.id, "start");
  void pending.committed.catch(() => undefined);
}

function executeRowIntent(
  intent: OutlineKeyIntent,
  scope: HTMLElement,
  store: NotesStore,
  node: NoteView,
  nodes: readonly NoteView[],
  structureIndex: OutlineIndex,
  onZoomIn: () => void,
  onZoomOut: () => void,
  onExtendSelection: (originId: string, headId: string) => void,
  onClearSelection: (collapse?: "start" | "end") => void,
  onFocusNote: () => void,
  onMoveTo: () => void,
  backspaceGroup: string | null,
  repeated: boolean
): void {
  switch (intent.kind) {
    case "consume":
    // Only the image surface resolves these, and it routes them itself.
    case "copyImage":
    case "cutImage":
    // Only a text field resolves this one, and it answers before it gets here.
    case "selectTextEdge":
      return;
    case "split":
      {
        const activeGesture = repeated
          ? enterSplitGestures.get(scope)
          : undefined;
        const activeTail = activeGesture
          ? store.getSnapshot().nodes.find(
              (candidate) => candidate.id === activeGesture.tailId
            )
          : undefined;
        const split = activeTail && activeGesture ? {
          id: activeTail.id,
          parentId: activeGesture.parentId,
          beforeId: activeGesture.beforeId,
          prefix: "",
          suffix: store.getSnapshot().drafts[activeTail.id] ?? activeTail.text
        } : {
          id: node.id,
          parentId: intent.parentId,
          beforeId: intent.beforeId,
          prefix: intent.prefix,
          suffix: intent.suffix
        };
        const pending = store.beginSplitNode(split);
        enterSplitGestures.set(scope, {
          tailId: pending.id,
          parentId: split.parentId,
          beforeId: split.beforeId
        });
        focusAfter(scope, pending.id, "start");
        void pending.committed.catch(() => undefined);
      }
      return;
    // No `createFirstChild` here: only the page title still resolves to it, and
    // a row with children now reaches the same result through the split.
    case "createSibling":
      {
        const activeGesture = repeated
          ? enterSplitGestures.get(scope)
          : undefined;
        const parentId = activeGesture?.parentId ?? intent.parentId;
        const beforeId = activeGesture?.beforeId ?? intent.beforeId;
        const pending = store.beginCreateNode(parentId, "", beforeId);
        enterSplitGestures.set(scope, {
          tailId: pending.id,
          parentId,
          beforeId
        });
        focusAfter(scope, pending.id, "start");
        void pending.committed.catch(() => undefined);
      }
      return;
    case "indent":
      void store.indent(node.id, intent.previousSiblingId)
        .then(() => focusAfter(scope, node.id, "preserve"));
      return;
    case "outdent":
      void store.outdent(node.id, intent.parentId, intent.beforeId)
        .then(() => focusAfter(scope, node.id, "preserve"));
      return;
    case "focus":
      focusOutlineEditor(scope, intent.nodeId, intent.edge);
      void store.flushDraft(node.id);
      return;
    case "clearMarker":
      // The caret stays where it is: the row is the same row, minus its box.
      void store.setMarker(node.id, "bullet");
      return;
    case "removeEmpty":
      {
        const pending = store.beginRemoveEmptyNode(node.id, backspaceGroup);
        if (intent.focusId) focusAfter(scope, intent.focusId, "end");
        void pending.committed.catch(() => undefined);
      }
      return;
    case "mergeBackward": {
      const state = store.getSnapshot();
      const previous = state.nodes.find(
        (candidate) => candidate.id === intent.previousId
      );
      if (!previous) return;
      const previousText = state.drafts[previous.id] ?? previous.text;
      const pending = store.beginMergeNodeBackward({
        id: node.id,
        previousId: previous.id,
        previousText,
        currentText: state.drafts[node.id] ?? node.text,
        historyGroup: backspaceGroup
      });
      requestAnimationFrame(() => {
        focusOutlineEditorAt(scope, node.id, previousText.length);
      });
      void pending.committed.catch(() => undefined);
      return;
    }
    case "mergeIntoParent": {
      const state = store.getSnapshot();
      const parent = state.nodes.find(
        (candidate) => candidate.id === intent.parentId
      );
      if (!parent) return;
      const parentText = state.drafts[parent.id] ?? parent.text;
      const pending = store.beginMergeNodeIntoParent({
        id: node.id,
        parentId: parent.id,
        parentText,
        currentText: state.drafts[node.id] ?? node.text,
        historyGroup: backspaceGroup
      });
      requestAnimationFrame(() => {
        focusOutlineEditorAt(scope, parent.id, parentText.length);
      });
      void pending.committed.catch(() => undefined);
      return;
    }
    case "toggleComplete":
      void store.setCompleted(node.id, !node.completed);
      return;
    case "trash":
      void store.deleteSubtree(node.id);
      return;
    // The chooser is mounted by the row and already scopes itself to the live
    // selection, so the key needs no diversion of its own: it flips the same
    // state the menu item flips.
    case "moveTo":
      onMoveTo();
      return;
    case "duplicate": {
      const siblings = node.parentId
        ? structureIndex.childrenOf(node.parentId)
        : nodes.filter((candidate) => candidate.parentId === null);
      const index = node.parentId
        ? structureIndex.siblingPositionOf(node.id)
        : siblings.findIndex((candidate) => candidate.id === node.id);
      const beforeId = index >= 0 ? siblings[index + 1]?.id ?? null : null;
      void store.duplicate(node.id, node.parentId ?? "", beforeId)
        .then((id) => focusAfter(scope, id, "start"));
      return;
    }
    case "move": {
      const siblings = node.parentId
        ? structureIndex.childrenOf(node.parentId)
        : nodes.filter((candidate) => candidate.parentId === null);
      const index = node.parentId
        ? structureIndex.siblingPositionOf(node.id)
        : siblings.findIndex((candidate) => candidate.id === node.id);
      const beforeId = intent.direction === "up"
        ? siblings[index - 1]?.id
        : siblings[index + 2]?.id ?? null;
      if (index < 0 || (intent.direction === "up" && !beforeId)) return;
      void store.moveNode(node.id, node.parentId ?? "", beforeId ?? null)
        .then(() => focusAfter(scope, node.id, "preserve"));
      return;
    }
    case "zoom":
      void store.flushDraft(node.id).then(
        intent.direction === "in" ? onZoomIn : onZoomOut
      );
      return;
    case "focusNote":
      onFocusNote();
      return;
    case "extendSelection":
      onExtendSelection(node.id, intent.headId);
      return;
    case "clearSelection":
      onClearSelection(intent.collapse);
  }
}
