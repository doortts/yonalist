import type { MonacoOutlineProjection } from "./monacoOutlineProjection";

export interface MonacoContentChange {
  readonly startLineNumber: number;
  readonly endLineNumber: number;
  readonly text: string;
}

export type MonacoContentChangeResult =
  | "draft"
  | "deferred"
  | "structural"
  | "rejected";

export class MonacoOutlineController {
  private composing = false;
  private readonly compositionLines = new Set<number>();

  constructor(
    private projection: MonacoOutlineProjection,
    private readonly publishDraft: (nodeId: string, text: string) => void
  ) {}

  setProjection(projection: MonacoOutlineProjection): void {
    this.projection = projection;
  }

  beginComposition(): void {
    this.composing = true;
    this.compositionLines.clear();
  }

  endComposition(lineContent: (lineNumber: number) => string): void {
    this.composing = false;
    for (const lineNumber of this.compositionLines) {
      this.publishLine(lineNumber, lineContent);
    }
    this.compositionLines.clear();
  }

  applyContentChange(
    changes: readonly MonacoContentChange[],
    lineContent: (lineNumber: number) => string
  ): MonacoContentChangeResult {
    if (
      changes.some((change) =>
        change.startLineNumber !== change.endLineNumber ||
        /[\r\n]/u.test(change.text)
      )
    ) {
      return "structural";
    }
    const lineNumbers = new Set(
      changes.map((change) => change.startLineNumber)
    );
    for (const lineNumber of lineNumbers) {
      const line = this.projection.lines[lineNumber - 1];
      if (!line?.editable) return "rejected";
    }
    if (this.composing) {
      lineNumbers.forEach((lineNumber) =>
        this.compositionLines.add(lineNumber)
      );
      return "deferred";
    }
    lineNumbers.forEach((lineNumber) =>
      this.publishLine(lineNumber, lineContent)
    );
    return "draft";
  }

  private publishLine(
    lineNumber: number,
    lineContent: (lineNumber: number) => string
  ): void {
    const line = this.projection.lines[lineNumber - 1];
    if (!line?.editable) return;
    this.publishDraft(line.nodeId, lineContent(lineNumber));
  }
}
