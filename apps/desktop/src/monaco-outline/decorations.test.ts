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
  it("renders chevron before and bullet after at model column one", () => {
    const decorations = buildOutlineDecorations([
      line("root", "page", 0),
      line("child", "root", 1)
    ], [1, 2]);

    expect(decorations[0]?.options.before).toMatchObject({
      content: "▾ ",
      inlineClassName:
        "yonalist-outline-chevron yonalist-outline-chevron--expanded",
      cursorStops: monaco.editor.InjectedTextCursorStops.Right,
      attachedData: {
        kind: "yonalist-chevron",
        nodeId: "root"
      }
    });
    expect(decorations[1]?.range).toEqual(new monaco.Range(2, 1, 2, 1));
    expect(decorations[1]?.options.before).toMatchObject({
      content: "    ▸ ",
      inlineClassName:
        "yonalist-outline-chevron yonalist-outline-chevron--leaf"
    });
    expect(decorations[1]?.options.before?.attachedData).toBeUndefined();
    expect(decorations[1]?.options.after).toMatchObject({
      content: "•  ",
      inlineClassName: "yonalist-outline-injected-bullet",
      cursorStops: monaco.editor.InjectedTextCursorStops.Right,
      attachedData: {
        kind: "yonalist-bullet",
        nodeId: "child"
      }
    });
  });

  it("marks a collapsed parent with the collapsed chevron", () => {
    const decorations = buildOutlineDecorations([
      { ...line("root", "page", 0), collapsed: true },
      line("child", "root", 1)
    ], [1]);

    expect(decorations[0]?.options.before).toMatchObject({
      content: "▸ ",
      inlineClassName:
        "yonalist-outline-chevron yonalist-outline-chevron--collapsed"
    });
    expect(decorations[0]?.options.after?.inlineClassName).toBe(
      "yonalist-outline-injected-bullet " +
      "yonalist-outline-injected-bullet--collapsed"
    );
  });
});
