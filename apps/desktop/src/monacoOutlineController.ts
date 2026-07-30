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
  private readonly compositionNodeIds = new Set<string>();

  constructor(
    private projection: MonacoOutlineProjection,
    private readonly publishDraft: (nodeId: string, text: string) => void
  ) {}

  setProjection(projection: MonacoOutlineProjection): void {
    this.projection = projection;
  }

  isCompositionActive(): boolean {
    return this.composing;
  }

  beginComposition(): void {
    this.composing = true;
    this.compositionNodeIds.clear();
  }

  endComposition(lineContent: (lineNumber: number) => string): void {
    this.composing = false;
    for (const nodeId of this.compositionNodeIds) {
      const lineNumber = this.projection.lineByNodeId.get(nodeId);
      if (lineNumber) this.publishNode(nodeId, lineNumber, lineContent);
    }
    this.compositionNodeIds.clear();
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
      lineNumbers.forEach((lineNumber) => {
        const nodeId = this.projection.nodeIdByLine[lineNumber - 1];
        if (nodeId) this.compositionNodeIds.add(nodeId);
      });
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
    this.publishNode(line.nodeId, lineNumber, lineContent);
  }

  private publishNode(
    nodeId: string,
    lineNumber: number,
    lineContent: (lineNumber: number) => string
  ): void {
    const line = this.projection.lines[lineNumber - 1];
    if (line?.nodeId !== nodeId || !line.editable) return;
    this.publishDraft(nodeId, lineContent(lineNumber));
  }
}
