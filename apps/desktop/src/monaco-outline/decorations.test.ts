import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type { OutlineLineMetadata } from "./metadata";
import { buildOutlineDecorations } from "./decorations";

function line(
  nodeId: string,
  parentId: string,
  depth: number
): OutlineLineMetadata {
  return {
    nodeId,
    parentId,
    depth,
    kind: "text",
    collapsed: false,
    completed: false
  };
}

describe("outline decorations", () => {
  it("renders depth and bullet as injected text at model column one", () => {
    const decorations = buildOutlineDecorations([
      line("root", "page", 0),
      line("child", "root", 1)
    ], [1, 2]);

    expect(decorations[1]?.range).toEqual(new monaco.Range(2, 1, 2, 1));
    expect(decorations[1]?.options.before).toMatchObject({
      content: "\u00a0\u00a0\u00a0\u00a0\u2022\u00a0\u00a0",
      inlineClassName: "yonalist-outline-injected-bullet",
      cursorStops: monaco.editor.InjectedTextCursorStops.Right,
      attachedData: {
        kind: "yonalist-bullet",
        nodeId: "child"
      }
    });
  });
});
