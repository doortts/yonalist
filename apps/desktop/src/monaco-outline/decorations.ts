import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type {
  OutlineLineMetadata,
  OutlineMetadataSnapshot
} from "./metadata";

interface DecorationEntry {
  readonly decorationId: string;
  readonly lineNumber: number;
}

export function buildOutlineDecorations(
  lines: readonly OutlineLineMetadata[],
  lineNumbers: readonly number[]
): monaco.editor.IModelDeltaDecoration[] {
  return lineNumbers.flatMap((lineNumber) => {
    const line = lines[lineNumber - 1];
    if (!line) return [];
    return [{
      range: new monaco.Range(lineNumber, 1, lineNumber, 1),
      options: {
        stickiness:
          monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        before: {
          content:
            "\u00a0".repeat(line.depth * 4) +
            "\u2022\u00a0\u00a0",
          inlineClassName: "yonalist-outline-injected-bullet",
          inlineClassNameAffectsLetterSpacing: true,
          cursorStops: monaco.editor.InjectedTextCursorStops.Right,
          attachedData: {
            kind: "yonalist-bullet",
            nodeId: line.nodeId
          }
        }
      }
    }];
  });
}

export class OutlineDecorationSet {
  private readonly entries = new Map<string, DecorationEntry>();

  constructor(
    private readonly model: monaco.editor.ITextModel,
    private readonly metadata: () => OutlineMetadataSnapshot
  ) {
    this.update(allLineNumbers(metadata()));
  }

  update(affectedLineNumbers: readonly number[]): void {
    const snapshot = this.metadata();
    const activeNodeIds = new Set(
      snapshot.lines.map(({ nodeId }) => nodeId)
    );
    const affected = new Set(affectedLineNumbers);
    const removedIds: string[] = [];
    for (const [nodeId, entry] of this.entries) {
      if (
        !activeNodeIds.has(nodeId) ||
        affected.has(entry.lineNumber) ||
        affected.has(
          this.model.getDecorationRange(entry.decorationId)?.startLineNumber ??
            -1
        )
      ) {
        removedIds.push(entry.decorationId);
        this.entries.delete(nodeId);
      }
    }

    const refreshedLineNumbers = [...affected]
      .filter((lineNumber) =>
        lineNumber >= 1 && lineNumber <= snapshot.lines.length)
      .sort((left, right) => left - right);
    const decorationIds = this.model.deltaDecorations(
      removedIds,
      buildOutlineDecorations(snapshot.lines, refreshedLineNumbers)
    );
    refreshedLineNumbers.forEach((lineNumber, index) => {
      const line = snapshot.lines[lineNumber - 1];
      const decorationId = decorationIds[index];
      if (line && decorationId) {
        this.entries.set(line.nodeId, { decorationId, lineNumber });
      }
    });
  }

  dispose(): void {
    this.model.deltaDecorations(
      [...this.entries.values()].map(({ decorationId }) => decorationId),
      []
    );
    this.entries.clear();
  }
}

function allLineNumbers(
  snapshot: OutlineMetadataSnapshot
): readonly number[] {
  return snapshot.lines.map((_, index) => index + 1);
}
