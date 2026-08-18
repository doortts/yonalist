import type { PaneFocusSnapshot } from "../appNavigation";
import { outlinePane } from "./outlinePaneRegistry";

export type OutlineFocusEdge = "start" | "end" | "preserve";

// Tries to wait for a revealed row to mount before giving up on it.
const REVEAL_TRIES = 3;

// Newest focus request per pane wins. A revealed row can mount ticks after it
// was asked for, and by then a newer request may already have placed the caret
// elsewhere -- letting the older retry land would pull it back to a row the
// caller has moved past. Same last-request-wins guard focusAfterCommit applies
// to its own microtask.
const pendingReveal = new WeakMap<HTMLElement, object>();
const pendingFocus = new WeakMap<HTMLElement, object>();

function revealInLocalOutline(target: HTMLElement): void {
  adjustLocalOutlineScroll(target);
  globalThis.requestAnimationFrame?.(() => adjustLocalOutlineScroll(target));
}

// A row arriving at an edge brings this many lines of what surrounds it, so
// the caret reads with context ahead of it instead of against the boundary.
const LEAD_LINES = 3;
// What a line is worth where the editor reports no line height of its own --
// an unstyled field, or a test environment that lays nothing out. The row
// line height in `notes.css`.
const FALLBACK_LINE_HEIGHT = 25;

function leadHeight(target: HTMLElement): number {
  const view = target.ownerDocument.defaultView;
  const line = Number.parseFloat(view?.getComputedStyle(target).lineHeight ?? "");
  return LEAD_LINES * (Number.isFinite(line) ? line : FALLBACK_LINE_HEIGHT);
}

function adjustLocalOutlineScroll(target: HTMLElement): void {
  if (!target.isConnected) return;
  const rows = target.closest<HTMLElement>(".notes-outline-rows");
  if (!rows) return;
  const rowsRect = rows.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const lead = leadHeight(target);
  // The lead is what the scroll aims for; the other edge of the row is what it
  // may never cross. A row taller than the room left over stops on the edge it
  // came from rather than being carried out the far side of the viewport.
  if (targetRect.top - lead < rowsRect.top) {
    rows.scrollTop += Math.max(
      targetRect.top - lead - rowsRect.top,
      Math.min(0, targetRect.bottom - rowsRect.bottom)
    );
  } else if (targetRect.bottom + lead > rowsRect.bottom) {
    rows.scrollTop += Math.min(
      targetRect.bottom + lead - rowsRect.bottom,
      Math.max(0, targetRect.top - rowsRect.top)
    );
  }
}

function editorById(
  scope: HTMLElement,
  nodeId: string,
  field: PaneFocusSnapshot["field"],
  edge: OutlineFocusEdge
): HTMLElement | undefined {
  const candidates = [...scope.querySelectorAll<HTMLElement>("[data-node-id]")]
    .filter((editor) => editor.dataset.nodeId === nodeId && (
      field === "note"
        ? editor instanceof HTMLTextAreaElement &&
          editor.dataset.outlineField === "note"
        : editor.dataset.outlineField === "image" ||
          editor instanceof HTMLTextAreaElement &&
            (!editor.dataset.outlineField ||
              editor.dataset.outlineField === "title")
    ));
  // An image parks a caret station on each of its sides, so the edge that would
  // place a caret inside a title picks the side here. Everything else has one.
  if (candidates.length < 2) return candidates[0];
  const active = scope.ownerDocument.activeElement;
  if (edge === "preserve" && active instanceof HTMLElement &&
    candidates.includes(active)) {
    return active;
  }
  const side = edge === "start" ? "before" : "after";
  return candidates.find((editor) => editor.dataset.imageEdge === side) ??
    candidates[0];
}

/**
 * Focuses a row's editor, asking the pane to bring the row into its rendered
 * window first when it is not mounted. Returns false only when the pane does
 * not hold the node at all.
 */
function focusWhenReady(
  scope: HTMLElement,
  nodeId: string,
  field: PaneFocusSnapshot["field"],
  apply: (target: HTMLElement) => void,
  edge: OutlineFocusEdge = "end"
): boolean {
  // Callers scope focus to the pane section or to the row list inside it; the
  // pane registers itself on the section.
  const paneScope = scope.closest<HTMLElement>(".notes-outline") ?? scope;
  const request = {};
  const target = editorById(scope, nodeId, field, edge);
  if (target) {
    pendingReveal.set(paneScope, request);
    apply(target);
    return true;
  }
  const pane = outlinePane(paneScope);
  // A pane that does not hold the row is only being probed, so it must not
  // cancel a retry some other request is still waiting on.
  if (!pane?.reveal(nodeId)) return false;
  pendingReveal.set(paneScope, request);
  // A timer, not a frame callback: the reveal has to be waited out on a browser
  // that paints nothing, and an occluded or backgrounded window runs no frames
  // at all. A timer there is throttled, never skipped.
  const retry = (remaining: number) => setTimeout(() => {
    if (pendingReveal.get(paneScope) !== request) return;
    const revealed = editorById(scope, nodeId, field, edge);
    if (revealed) apply(revealed);
    else if (remaining > 0) retry(remaining - 1);
  });
  retry(REVEAL_TRIES);
  return true;
}

/**
 * Places the caret once the render the caller just triggered has committed --
 * `where` is an edge, or the exact offset to land on. A microtask, not a frame
 * callback: focus rides the commit, and the browser runs no frames while its
 * window is occluded or backgrounded, so a frame-bound caret never arrives
 * there at all.
 */
export function focusAfterCommit(
  scope: HTMLElement,
  nodeId: string,
  where: OutlineFocusEdge | number
): void {
  const request = {};
  pendingFocus.set(scope, request);
  queueMicrotask(() => {
    if (pendingFocus.get(scope) !== request) return;
    pendingFocus.delete(scope);
    if (typeof where === "number") focusOutlineEditorAt(scope, nodeId, where);
    else focusOutlineEditor(scope, nodeId, where);
  });
}

function caretPlacement(
  range: (value: string) => readonly [number, number]
) {
  return (target: HTMLElement) => {
    // preventScroll stops an ancestor from yanking the whole pane around; the
    // outline's own scroller does the revealing instead.
    target.focus({ preventScroll: true });
    if (target instanceof HTMLTextAreaElement) {
      const clamp = (offset: number) =>
        Math.max(0, Math.min(offset, target.value.length));
      const [start, end] = range(target.value);
      target.setSelectionRange(clamp(start), clamp(end));
    }
    revealInLocalOutline(target);
  };
}

export function focusOutlineEditorAt(
  scope: HTMLElement,
  nodeId: string,
  requestedOffset: number
): boolean {
  return focusWhenReady(
    scope, nodeId, "title",
    caretPlacement(() => [requestedOffset, requestedOffset]));
}

/** Puts a captured caret back, its field and its selection included. */
export function focusOutlineSnapshot(
  scope: HTMLElement,
  focus: PaneFocusSnapshot
): boolean {
  return focusWhenReady(
    scope, focus.nodeId, focus.field,
    caretPlacement(() => [focus.selectionStart, focus.selectionEnd]),
    "start");
}

export function focusOutlineEditor(
  scope: HTMLElement,
  nodeId: string,
  edge: OutlineFocusEdge
): boolean {
  const active = scope.ownerDocument.activeElement;
  const preservedOffset = active instanceof HTMLTextAreaElement &&
    scope.contains(active)
    ? active.selectionStart
    : 0;
  return focusWhenReady(scope, nodeId, "title", caretPlacement((value) => {
    const caret = edge === "start"
      ? 0
      : edge === "end"
        ? value.length
        : preservedOffset;
    return [caret, caret];
  }), edge);
}
