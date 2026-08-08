import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type { OutlineLineMetadata } from "./metadata";

const INDENT = "\u00a0";
const INDENT_PER_DEPTH = 4;
/** Chevron glyph and bullet glyph, two spaces each: the title body offset. */
const BODY_OFFSET = 6;

export function buildOutlineDecorations(
  lines: readonly OutlineLineMetadata[],
  lineNumbers: readonly number[]
): monaco.editor.IModelDeltaDecoration[] {
  return lineNumbers.flatMap((lineNumber) => {
    const line = lines[lineNumber - 1];
    if (!line) return [];
    return [
      line.kind === "note"
        ? noteDecoration(line, lineNumber)
        : bulletDecoration(lines, line, lineNumber)
    ];
  });
}

/**
 * A note carries no bullet and no chevron (N7). Its one injection is the
 * indent that lines the note text up with its title's text.
 */
function noteDecoration(
  line: OutlineLineMetadata,
  lineNumber: number
): monaco.editor.IModelDeltaDecoration {
  return {
    range: new monaco.Range(lineNumber, 1, lineNumber, 1),
    options: {
      stickiness:
        monaco.editor.TrackedRangeStickiness.GrowsOnlyWhenTypingBefore,
      showIfCollapsed: true,
      isWholeLine: true,
      inlineClassName: "yonalist-outline-note-line",
      before: {
        content: INDENT.repeat(line.depth * INDENT_PER_DEPTH + BODY_OFFSET),
        inlineClassNameAffectsLetterSpacing: true,
        cursorStops: monaco.editor.InjectedTextCursorStops.Right
      }
    }
  };
}

function bulletDecoration(
  lines: readonly OutlineLineMetadata[],
  line: OutlineLineMetadata,
  lineNumber: number
): monaco.editor.IModelDeltaDecoration {
  // Children come after the note run, which belongs to this same node.
  let index = lineNumber;
  while (lines[index]?.kind === "note") index += 1;
  const hasChildren = lines[index]?.parentId === line.nodeId;
  const chevronState = hasChildren
    ? line.collapsed
      ? "collapsed"
      : "expanded"
    : "leaf";
  // A to-do takes the checkbox the React surface draws beside its hidden
  // bullet dot; the bullet slot is the only injection either surface has, so
  // here the checkbox stands in the bullet's place. A caption is a label for
  // its picture, never a task.
  const todo = line.marker === "todo" && line.kind === "text";
  // An image node never has children (V4), so its chevron slot stays a leaf and
  // the caption only takes its own class.
  const lineClasses = [
    line.completed ? "yonalist-outline-completed-line" : null,
    line.kind === "image" ? "yonalist-outline-image-caption" : null
  ].filter((name): name is string => name !== null).join(" ");
  return {
    range: new monaco.Range(lineNumber, 1, lineNumber, 1),
    options: {
      stickiness:
        monaco.editor.TrackedRangeStickiness.GrowsOnlyWhenTypingBefore,
      showIfCollapsed: true,
      isWholeLine: true,
      ...lineClasses ? { inlineClassName: lineClasses } : {},
      before: {
        content:
          INDENT.repeat(line.depth * INDENT_PER_DEPTH) +
          (chevronState === "expanded" ? "\u25be" : "\u25b8") +
          "\u00a0\u00a0",
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
        inlineClassName: todo
          ? "yonalist-outline-injected-todo" + (line.completed
              ? " yonalist-outline-injected-todo--checked"
              : "")
          : chevronState === "collapsed"
            ? "yonalist-outline-injected-bullet " +
              "yonalist-outline-injected-bullet--collapsed"
            : "yonalist-outline-injected-bullet",
        inlineClassNameAffectsLetterSpacing: true,
        cursorStops: monaco.editor.InjectedTextCursorStops.Right,
        attachedData: {
          kind: todo ? "yonalist-todo" : "yonalist-bullet",
          nodeId: line.nodeId
        }
      }
    }
  };
}
