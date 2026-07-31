import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import { buildOutlineDecorations } from "./decorations";
import type { OutlineMetadataSnapshot } from "./metadata";

const OUTLINE_LINE_HEIGHT = 25;

export type DecorationWindowRange = readonly [number, number];

export function decorationWindowFor(
  visibleStart: number,
  visibleEnd: number,
  lineCount: number
): DecorationWindowRange {
  const visibleLineCount = Math.max(
    1,
    visibleEnd - visibleStart + 1
  );
  return [
    Math.max(1, visibleStart - visibleLineCount),
    Math.min(
      lineCount,
      visibleEnd + visibleLineCount
    )
  ];
}

export class PaneDecorationWindow {
  private readonly collection: monaco.editor.IEditorDecorationsCollection;
  private readonly scrollSubscription: monaco.IDisposable;
  private readonly layoutSubscription: monaco.IDisposable;
  private range: DecorationWindowRange = [1, 0];
  private frameScheduled = false;
  private disposed = false;

  constructor(private readonly input: {
    readonly editor: monaco.editor.IStandaloneCodeEditor;
    readonly metadata: () => OutlineMetadataSnapshot;
  }) {
    this.collection = input.editor.createDecorationsCollection();
    this.scrollSubscription = input.editor.onDidScrollChange(
      () => this.scheduleVisibleRangeUpdate()
    );
    this.layoutSubscription = input.editor.onDidLayoutChange(
      () => this.scheduleVisibleRangeUpdate()
    );
    this.refresh(true);
  }

  invalidate(structural: boolean): void {
    if (!structural || this.disposed) return;
    this.refresh(true);
    // Monaco reveals the new cursor after the model-change callback returns.
    // Re-read the viewport on the next frame so a large native edit cannot
    // leave the decoration window at its pre-reveal location.
    this.scheduleVisibleRangeUpdate();
  }

  scheduleVisibleRangeUpdate(): void {
    if (this.disposed || this.frameScheduled) return;
    this.frameScheduled = true;
    requestAnimationFrame(() => {
      this.frameScheduled = false;
      if (!this.disposed) this.refresh(false);
    });
  }

  get size(): number {
    return Math.max(
      0,
      this.range[1] - this.range[0] + 1
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scrollSubscription.dispose();
    this.layoutSubscription.dispose();
    this.collection.clear();
    this.range = [1, 0];
  }

  private refresh(force: boolean): void {
    const metadata = this.input.metadata();
    const range = visibleWindow(
      this.input.editor,
      metadata.lines.length
    );
    if (
      !force &&
      range[0] === this.range[0] &&
      range[1] === this.range[1]
    ) {
      return;
    }
    this.range = range;
    const lineNumbers: number[] = [];
    for (
      let line = range[0];
      line <= range[1];
      line += 1
    ) lineNumbers.push(line);
    this.collection.set(buildOutlineDecorations(metadata.lines, lineNumbers));
  }
}

function visibleWindow(
  editor: monaco.editor.IStandaloneCodeEditor,
  lineCount: number
): DecorationWindowRange {
  const visible = editor.getVisibleRanges();
  if (visible.length > 0) {
    return decorationWindowFor(
      visible[0]!.startLineNumber,
      visible[visible.length - 1]!.endLineNumber,
      lineCount
    );
  }
  const cursorLine = editor.getPosition()?.lineNumber ?? 1;
  const visibleLineCount = Math.max(
    1,
    Math.ceil(editor.getLayoutInfo().height / OUTLINE_LINE_HEIGHT)
  );
  return decorationWindowFor(
    cursorLine,
    Math.min(lineCount, cursorLine + visibleLineCount - 1),
    lineCount
  );
}
