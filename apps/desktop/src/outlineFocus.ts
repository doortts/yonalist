import { outlinePane } from "./outlinePaneRegistry";

export type OutlineFocusEdge = "start" | "end" | "preserve";

// Frames to wait for a revealed row to mount before giving up on it.
const REVEAL_FRAMES = 3;

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
  const target = editorById(scope, nodeId);
  if (target) {
    apply(target);
    return true;
  }
  if (!outlinePane(scope)?.reveal(nodeId)) return false;
  const retry = (remaining: number) => requestAnimationFrame(() => {
    const revealed = editorById(scope, nodeId);
    if (revealed) apply(revealed);
    else if (remaining > 0) retry(remaining - 1);
  });
  retry(REVEAL_FRAMES);
  return true;
}

function caretPlacement(offset: (value: string) => number) {
  return (target: HTMLElement) => {
    if (!(target instanceof HTMLTextAreaElement)) {
      target.focus();
      return;
    }
    const caret = Math.max(0, Math.min(offset(target.value), target.value.length));
    target.focus();
    target.setSelectionRange(caret, caret);
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
