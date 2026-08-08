import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type { OutlineMetadataSnapshot } from "./metadata";

/** The row an action rail is currently offered for, and where to draw it. */
export interface OutlineRowActionTarget {
  readonly nodeId: string;
  readonly lineNumber: number;
  /** The row's own text, for the trigger's accessible name. */
  readonly title: string;
  /** Pixels below the top of the editor host. */
  readonly top: number;
}

/** What a React overlay reads to follow the tracked row. */
export interface OutlineRowActionSource {
  subscribe(listener: () => void): () => void;
  current(): OutlineRowActionTarget | null;
}

/** Every member below is `ICodeEditor`'s; the alias is what tests stand in for. */
type RowActionEditor = Pick<
  monaco.editor.ICodeEditor,
  | "onMouseMove"
  | "onMouseLeave"
  | "onDidChangeCursorPosition"
  | "onDidScrollChange"
  | "onDidFocusEditorText"
  | "onDidBlurEditorText"
  | "hasTextFocus"
  | "getPosition"
  | "getScrollTop"
  | "getTopForLineNumber"
  | "getModel"
>;

/**
 * Monaco draws no rows, so the surface cannot hang an action rail off one. This
 * tracks the single row a rail would belong to — the one under the pointer, or
 * the one the caret sits on while the editor has focus — the same two states
 * that reveal `OutlineRow`'s trigger on the React surface.
 *
 * Recomputation on a metadata change rides `handleMetadataChange` (the pane's
 * one sync point); the subscriptions here are gesture and viewport sources.
 */
export class OutlineRowActionTracker implements OutlineRowActionSource {
  private readonly subscriptions: readonly monaco.IDisposable[];
  private readonly listeners = new Set<() => void>();
  private hoveredLine: number | null = null;
  private target: OutlineRowActionTarget | null = null;

  constructor(private readonly input: {
    readonly editor: RowActionEditor;
    readonly metadata: () => OutlineMetadataSnapshot;
  }) {
    const { editor } = input;
    this.subscriptions = [
      editor.onMouseMove(
        (event) => this.setHovered(event.target.position?.lineNumber ?? null)
      ),
      editor.onMouseLeave(() => this.setHovered(null)),
      editor.onDidChangeCursorPosition(() => this.refresh()),
      editor.onDidScrollChange(() => this.refresh()),
      editor.onDidFocusEditorText(() => this.refresh()),
      editor.onDidBlurEditorText(() => this.refresh())
    ];
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly current = (): OutlineRowActionTarget | null => this.target;

  /** The pane calls this from its metadata sync point. */
  refresh(): void {
    const next = this.resolve();
    if (sameTarget(next, this.target)) return;
    this.target = next;
    for (const listener of [...this.listeners]) listener();
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.listeners.clear();
    this.target = null;
  }

  private setHovered(lineNumber: number | null): void {
    if (lineNumber === this.hoveredLine) return;
    this.hoveredLine = lineNumber;
    this.refresh();
  }

  private resolve(): OutlineRowActionTarget | null {
    const { editor } = this.input;
    const lineNumber = this.hoveredLine ?? (editor.hasTextFocus()
      ? editor.getPosition()?.lineNumber ?? null
      : null);
    if (lineNumber === null) return null;
    const line = this.input.metadata().lines[lineNumber - 1];
    // A note line copies the title's node id (design §1), so it is no row of
    // its own; text and image lines are one node each.
    if (!line || line.kind === "note") return null;
    return {
      nodeId: line.nodeId,
      lineNumber,
      title: editor.getModel()?.getLineContent(lineNumber) ?? "",
      top: editor.getTopForLineNumber(lineNumber) - editor.getScrollTop()
    };
  }
}

function sameTarget(
  left: OutlineRowActionTarget | null,
  right: OutlineRowActionTarget | null
): boolean {
  if (!left || !right) return left === right;
  return left.nodeId === right.nodeId &&
    left.lineNumber === right.lineNumber &&
    left.title === right.title &&
    left.top === right.top;
}
