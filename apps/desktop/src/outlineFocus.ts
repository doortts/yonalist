export type OutlineFocusEdge = "start" | "end" | "preserve";

function editorById(
  scope: HTMLElement,
  nodeId: string
): HTMLTextAreaElement | undefined {
  return [...scope.querySelectorAll<HTMLTextAreaElement>(
    "textarea[data-node-id]"
  )].find((editor) => editor.dataset.nodeId === nodeId);
}

export function focusOutlineEditorAt(
  scope: HTMLElement,
  nodeId: string,
  requestedOffset: number
): boolean {
  const target = editorById(scope, nodeId);
  if (!target) return false;
  const offset = Math.max(0, Math.min(requestedOffset, target.value.length));
  target.focus();
  target.setSelectionRange(offset, offset);
  return true;
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
  const target = editorById(scope, nodeId);
  if (!target) return false;

  const offset = edge === "start"
    ? 0
    : edge === "end"
      ? target.value.length
      : Math.min(preservedOffset, target.value.length);
  target.focus();
  target.setSelectionRange(offset, offset);
  return true;
}
