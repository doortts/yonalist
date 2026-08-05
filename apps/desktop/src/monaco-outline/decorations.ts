import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type { OutlineLineMetadata } from "./metadata";

export function buildOutlineDecorations(
  lines: readonly OutlineLineMetadata[],
  lineNumbers: readonly number[]
): monaco.editor.IModelDeltaDecoration[] {
  return lineNumbers.flatMap((lineNumber) => {
    const line = lines[lineNumber - 1];
    if (!line) return [];
    const next = lines[lineNumber];
    const hasChildren = next?.parentId === line.nodeId;
    const chevronState = hasChildren
      ? line.collapsed
        ? "collapsed"
        : "expanded"
      : "leaf";
    return [{
      range: new monaco.Range(lineNumber, 1, lineNumber, 1),
      options: {
        stickiness:
          monaco.editor.TrackedRangeStickiness.GrowsOnlyWhenTypingBefore,
        showIfCollapsed: true,
        isWholeLine: true,
        ...line.completed
          ? { inlineClassName: "yonalist-outline-completed-line" }
          : {},
        before: {
          content:
            "\u00a0".repeat(line.depth * 4) +
            (chevronState === "expanded" ? "\u25be" : "\u25b8") +
            "\u00a0",
          inlineClassName:
            "yonalist-outline-chevron " +
            `yonalist-outline-chevron--${chevronState}`,
          inlineClassNameAffectsLetterSpacing: true,
          cursorStops: monaco.editor.InjectedTextCursorStops.Right,
          ...hasChildren
            ? {
                attachedData: {
                  kind: "yonalist-chevron",
                  nodeId: line.nodeId
                }
              }
            : {}
        },
        after: {
          content: "\u2022\u00a0\u00a0",
          inlineClassName: chevronState === "collapsed"
            ? "yonalist-outline-injected-bullet " +
              "yonalist-outline-injected-bullet--collapsed"
            : "yonalist-outline-injected-bullet",
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
