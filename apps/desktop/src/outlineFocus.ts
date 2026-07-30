export type OutlineFocusEdge = "start" | "end" | "preserve";

const outlineMaterializers = new WeakMap<
  HTMLElement,
  (nodeId: string) => boolean
>();

export function registerOutlineMaterializer(
  scope: HTMLElement,
  materialize: (nodeId: string) => boolean
): () => void {
  outlineMaterializers.set(scope, materialize);
  return () => {
    if (outlineMaterializers.get(scope) === materialize) {
      outlineMaterializers.delete(scope);
    }
  };
}

export function materializeOutlineNode(
  scope: HTMLElement,
  nodeId: string
): boolean {
  return outlineMaterializers.get(scope)?.(nodeId) ?? false;
}

function focusWithoutAncestorScroll(target: HTMLElement): void {
  target.focus({ preventScroll: true });
}

function revealInLocalOutline(target: HTMLElement): void {
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

function requestMaterializedFocus(
  scope: HTMLElement,
  nodeId: string,
  focus: () => boolean
): void {
  if (!materializeOutlineNode(scope, nodeId)) return;
  let attempts = 0;
  const retry = () => {
    attempts += 1;
    if (!focus() && attempts < 2) requestAnimationFrame(retry);
  };
  requestAnimationFrame(retry);
}

export function focusOutlineEditorAt(
  scope: HTMLElement,
  nodeId: string,
  requestedOffset: number
): boolean {
  const focus = () => {
    const target = editorById(scope, nodeId);
    if (!target) return false;
    if (!(target instanceof HTMLTextAreaElement)) {
      focusWithoutAncestorScroll(target);
      revealInLocalOutline(target);
      return true;
    }
    const offset = Math.max(
      0,
      Math.min(requestedOffset, target.value.length)
    );
    focusWithoutAncestorScroll(target);
    target.setSelectionRange(offset, offset);
    revealInLocalOutline(target);
    return true;
  };
  if (focus()) return true;
  requestMaterializedFocus(scope, nodeId, focus);
  return false;
}

function focusOutlineEditorInternal(
  scope: HTMLElement,
  nodeId: string,
  edge: OutlineFocusEdge,
  materialize: boolean
): boolean {
  const active = scope.ownerDocument.activeElement;
  const preservedOffset = active instanceof HTMLTextAreaElement &&
    scope.contains(active)
    ? active.selectionStart
    : 0;
  const target = editorById(scope, nodeId);
  if (!target) {
    if (materialize) {
      requestMaterializedFocus(
        scope,
        nodeId,
        () => focusOutlineEditorInternal(scope, nodeId, edge, false)
      );
    }
    return false;
  }
  if (!(target instanceof HTMLTextAreaElement)) {
    focusWithoutAncestorScroll(target);
    revealInLocalOutline(target);
    return true;
  }

  const offset = edge === "start"
    ? 0
    : edge === "end"
      ? target.value.length
      : Math.min(preservedOffset, target.value.length);
  focusWithoutAncestorScroll(target);
  target.setSelectionRange(offset, offset);
  revealInLocalOutline(target);
  return true;
}

export function focusOutlineEditor(
  scope: HTMLElement,
  nodeId: string,
  edge: OutlineFocusEdge
): boolean {
  return focusOutlineEditorInternal(scope, nodeId, edge, true);
}
