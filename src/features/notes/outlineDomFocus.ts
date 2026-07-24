/**
 * Move the DOM caret straight into an outline row's editor, bypassing the React
 * focus round trip (plan Track T1). Arrow-key cursor moves used to dispatch a
 * `focusNode` reducer action, re-render the whole pane, then focus the target in
 * an effect and re-render again; on key repeat that overran the frame budget.
 * This focuses the target textarea synchronously and lets the reducer state
 * catch up on a later frame.
 *
 * Generalizes the direct-focus the GitHub-notifications rows already used
 * (`NotesOutlinePane`'s `handleGithubCompositeKeyDownCapture`) to ordinary
 * bullets.
 */

export type OutlineCaretEdge =
  | "start"
  | "end"
  | { readonly start: number; readonly end: number };

/**
 * Focus the `field` editor of the row `nodeId` inside `paneRoot`.
 *
 * `edge` places the caret: `"start"`/`"end"` collapse to the field's bounds, an
 * object sets an explicit range (clamped to the value length). `edge === null`
 * focuses without touching the selection — matching the legacy no-selection
 * `focusNode` path (ArrowUp/ArrowDown), which left the caret where the browser
 * put it.
 *
 * Returns false when the target row/field is not mounted (a not-yet-opened note
 * field, an image row with no title textarea, or — later — a virtualized row) or
 * the browser refused focus, so the caller can fall back to the reducer path.
 */
export function focusOutlineEditorDom(
  paneRoot: HTMLElement,
  nodeId: string,
  field: "title" | "note",
  edge: OutlineCaretEdge | null,
): boolean {
  const fieldSelector =
    field === "title" ? "textarea.notes-node-title" : "textarea.notes-node-note";
  const textarea = paneRoot.querySelector<HTMLTextAreaElement>(
    `[data-outline-id="${CSS.escape(nodeId)}"] ${fieldSelector}`,
  );
  if (!textarea) {
    return false;
  }
  textarea.focus();
  if (document.activeElement !== textarea) {
    return false;
  }
  if (edge !== null) {
    const length = textarea.value.length;
    const clamp = (value: number): number =>
      Math.max(0, Math.min(length, value));
    const start = edge === "start" ? 0 : edge === "end" ? length : clamp(edge.start);
    const end = edge === "start" ? 0 : edge === "end" ? length : clamp(edge.end);
    textarea.setSelectionRange(Math.min(start, end), Math.max(start, end));
  }
  return true;
}
