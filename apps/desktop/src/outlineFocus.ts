import { outlinePane } from "./outlinePaneRegistry";

export type OutlineFocusEdge = "start" | "end" | "preserve";

// Frames to wait for a revealed row to mount before giving up on it.
const REVEAL_FRAMES = 3;

// Newest focus request per pane wins. A revealed row can mount frames after it
// was asked for, and by then a newer request may already have placed the caret
// elsewhere -- letting the older retry land would pull it back to a row the
// caller has moved past. Same last-request-wins guard focusAfter applies to its
// own microtask.
const pendingReveal = new WeakMap<HTMLElement, object>();

function revealInLocalOutline(target: HTMLElement): void {
  adjustLocalOutlineScroll(target);
  globalThis.requestAnimationFrame?.(() => adjustLocalOutlineScroll(target));
}

function adjustLocalOutlineScroll(target: HTMLElement): void {
  if (!target.isConnected) return;
  const rows = target.closest<HTMLElement>(".notes-outline-rows");
  if (!rows) return;
  const rowsRect = rows.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  if (targetRect.top < rowsRect.top) {
    rows.scrollTop += targetRect.top - rowsRect.top;
  } else if (targetRect.bottom > rowsRect.bottom) {
    rows.scrollTop += targetRect.bottom - rowsRect.bottom;
  }
}

function editorById(
  scope: HTMLElement,
  nodeId: string
): HTMLElement | undefined {
  return [...scope.querySelectorAll<HTMLElement>("[data-node-id]")]
    .find((editor) => editor.dataset.nodeId === nodeId && (
      editor.dataset.outlineField === "image" ||
      editor instanceof HTMLTextAreaElement &&
        (!editor.dataset.outlineField ||
          editor.dataset.outlineField === "title")
    ));
}

/**
 * Focuses a row's editor, asking the pane to bring the row into its rendered
 * window first when it is not mounted. Returns false only when the pane does
 * not hold the node at all.
 */
function focusWhenReady(
  scope: HTMLElement,
  nodeId: string,
  apply: (target: HTMLElement) => void
): boolean {
  // Callers scope focus to the pane section or to the row list inside it; the
  // pane registers itself on the section.
  const paneScope = scope.closest<HTMLElement>(".notes-outline") ?? scope;
  const request = {};
  const target = editorById(scope, nodeId);
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
  const retry = (remaining: number) => requestAnimationFrame(() => {
    if (pendingReveal.get(paneScope) !== request) return;
    const revealed = editorById(scope, nodeId);
    if (revealed) apply(revealed);
    else if (remaining > 0) retry(remaining - 1);
  });
  retry(REVEAL_FRAMES);
  return true;
}

function caretPlacement(offset: (value: string) => number) {
  return (target: HTMLElement) => {
    // preventScroll stops an ancestor from yanking the whole pane around; the
    // outline's own scroller does the revealing instead.
    target.focus({ preventScroll: true });
    if (target instanceof HTMLTextAreaElement) {
      const caret = Math.max(
        0, Math.min(offset(target.value), target.value.length));
      target.setSelectionRange(caret, caret);
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
    scope, nodeId, caretPlacement(() => requestedOffset));
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
  return focusWhenReady(scope, nodeId, caretPlacement((value) => edge === "start"
    ? 0
    : edge === "end"
      ? value.length
      : preservedOffset));
}
