import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type { OutlineLineMetadata } from "./metadata";

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
        showIfCollapsed: true,
        isWholeLine: true,
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
