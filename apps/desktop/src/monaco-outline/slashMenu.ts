import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import {
  applySlashCommand,
  filterSlashCommands,
  localDateIso,
  resolveSlashCommandQuery,
  type SlashCommandDefinition,
  type SlashCommandId,
  type SlashCommandQuery
} from "../outlineSlash";
import type { OutlineMetadataSnapshot } from "./metadata";
import type { MonacoOutlineSession } from "./session";

/** The open menu, and the caret box the shared menu places itself against. */
export interface OutlineSlashMenuTarget {
  readonly nodeId: string;
  readonly lineNumber: number;
  readonly query: SlashCommandQuery;
  readonly commands: readonly SlashCommandDefinition[];
  readonly activeIndex: number;
  /** Viewport coordinates of the caret's line. */
  readonly top: number;
  readonly left: number;
  readonly height: number;
  getBoundingClientRect(): DOMRect;
}

/** What a React overlay reads to draw the menu. */
export interface OutlineSlashMenuSource {
  subscribe(listener: () => void): () => void;
  current(): OutlineSlashMenuTarget | null;
  select(id: SlashCommandId): void;
}

/** The subset of a keyboard event the menu reads. */
export interface OutlineSlashKeyEvent {
  readonly key: string;
  readonly isComposing: boolean;
}

/** Every member below is `ICodeEditor`'s; the alias is what tests stand in for. */
type SlashMenuEditor = Pick<
  monaco.editor.ICodeEditor,
  | "onDidChangeCursorPosition"
  | "onDidScrollChange"
  | "onDidBlurEditorText"
  | "getSelection"
  | "getModel"
  | "getDomNode"
  | "getScrolledVisiblePosition"
  | "setPosition"
  | "focus"
>;

/**
 * The `/` affordance of `OutlineRow`, on a surface with no rows. The query and
 * the edit are `outlineSlash`'s, shared with the React surface; what lives here
 * is where the menu hangs (the caret's own line) and which keys it takes before
 * Monaco does — Enter would otherwise split the line and the arrows would move
 * the caret out from under the menu.
 *
 * Recomputation on a text change rides `handleMetadataChange` (the pane's one
 * sync point); the subscriptions here are the caret and the viewport.
 */
export class OutlineSlashMenuTracker implements OutlineSlashMenuSource {
  private readonly subscriptions: readonly monaco.IDisposable[];
  private readonly listeners = new Set<() => void>();
  private target: OutlineSlashMenuTarget | null = null;
  /** What Escape shut, so the same query does not reopen behind the caret. */
  private dismissed: { line: number; query: string } | null = null;

  constructor(private readonly input: {
    readonly editor: SlashMenuEditor;
    readonly metadata: () => OutlineMetadataSnapshot;
    readonly session: Pick<MonacoOutlineSession, "applySlashEdit">;
  }) {
    const { editor } = input;
    this.subscriptions = [
      editor.onDidChangeCursorPosition(() => this.refresh()),
      editor.onDidScrollChange(() => this.refresh()),
      editor.onDidBlurEditorText(() => this.publish(null))
    ];
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly current = (): OutlineSlashMenuTarget | null => this.target;

  /** The pane calls this from its metadata sync point. */
  refresh(): void {
    const resolved = this.resolve();
    if (resolved) this.dismissed = null;
    // A fresh resolution always highlights the first command, but the caret
    // and the viewport move under an open menu without changing the query —
    // and the arrows the user pressed have to survive that.
    const held = this.target;
    const next = resolved && held && sameQuery(resolved, held)
      ? { ...resolved, activeIndex: held.activeIndex }
      : resolved;
    if (sameTarget(next, this.target)) return;
    this.publish(next);
  }

  /** True when the menu took the key, so Monaco must not see it. */
  handleKeyDown(event: OutlineSlashKeyEvent): boolean {
    const target = this.target;
    if (!target) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const delta = event.key === "ArrowDown" ? 1 : -1;
      this.publish({
        ...target,
        activeIndex:
          (target.activeIndex + delta + target.commands.length) %
          target.commands.length
      });
      return true;
    }
    if (event.key === "Enter" && !event.isComposing) {
      this.select(target.commands[target.activeIndex]!.id);
      return true;
    }
    if (event.key === "Escape") {
      this.dismissed = { line: target.lineNumber, query: target.query.query };
      this.publish(null);
      return true;
    }
    return false;
  }

  readonly select = (id: SlashCommandId): void => {
    const target = this.target;
    const source = target === null
      ? null
      : this.input.editor.getModel()?.getLineContent(target.lineNumber) ?? null;
    if (target === null || source === null) return;
    this.publish(null);
    // A racing write can move the text out from under a menu the user is
    // still looking at; that gesture is spent, not misapplied.
    if (source.slice(0, target.query.end) !== `/${target.query.query}`) return;
    const edit = applySlashCommand(source, target.query, id, localDateIso());
    const lineNumber = this.input.session.applySlashEdit(
      target.nodeId,
      edit.value,
      edit.marker
    );
    if (lineNumber === null) return;
    this.input.editor.setPosition({ lineNumber, column: edit.caret + 1 });
    this.input.editor.focus();
  };

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.listeners.clear();
    this.target = null;
  }

  private publish(target: OutlineSlashMenuTarget | null): void {
    this.target = target;
    for (const listener of [...this.listeners]) listener();
  }

  private resolve(): OutlineSlashMenuTarget | null {
    const { editor } = this.input;
    const selection = editor.getSelection();
    const model = editor.getModel();
    if (!selection || !model || !selection.isEmpty()) return null;
    const lineNumber = selection.positionLineNumber;
    // The React surface gives the `/` menu to the title field only, so a note
    // line and an image caption never take it.
    if (this.input.metadata().lines[lineNumber - 1]?.kind !== "text") {
      return null;
    }
    // Monaco columns are one-based over the same UTF-16 offsets a textarea
    // reports, so the caret offset is one less.
    const caret = selection.positionColumn - 1;
    const query = resolveSlashCommandQuery(
      model.getLineContent(lineNumber),
      caret,
      caret
    );
    if (
      !query ||
      (this.dismissed?.line === lineNumber &&
        this.dismissed.query === query.query)
    ) {
      return null;
    }
    const commands = filterSlashCommands(query.query);
    const box = this.caretBox(lineNumber);
    if (commands.length === 0 || !box) return null;
    return {
      nodeId: this.input.metadata().lines[lineNumber - 1]!.nodeId,
      lineNumber,
      query,
      commands,
      activeIndex: 0,
      ...box,
      getBoundingClientRect: () =>
        new DOMRect(box.left, box.top, 0, box.height)
    };
  }

  private caretBox(
    lineNumber: number
  ): { top: number; left: number; height: number } | null {
    const { editor } = this.input;
    const host = editor.getDomNode();
    const at = editor.getScrolledVisiblePosition({ lineNumber, column: 1 });
    if (!host || !at) return null;
    const bounds = host.getBoundingClientRect();
    return {
      top: bounds.top + at.top,
      left: bounds.left + at.left,
      height: at.height
    };
  }
}

function sameQuery(
  left: OutlineSlashMenuTarget,
  right: OutlineSlashMenuTarget
): boolean {
  return left.lineNumber === right.lineNumber &&
    left.query.query === right.query.query;
}

function sameTarget(
  left: OutlineSlashMenuTarget | null,
  right: OutlineSlashMenuTarget | null
): boolean {
  if (!left || !right) return left === right;
  return left.nodeId === right.nodeId &&
    left.lineNumber === right.lineNumber &&
    left.query.query === right.query.query &&
    left.query.end === right.query.end &&
    left.commands.length === right.commands.length &&
    left.activeIndex === right.activeIndex &&
    left.top === right.top &&
    left.left === right.left;
}
