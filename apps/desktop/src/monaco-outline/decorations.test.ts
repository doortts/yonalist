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
      content: "▾  ",
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
      content: "    ▸  ",
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

  it("marks a completed line for struck-through styling", () => {
    const decorations = buildOutlineDecorations([
      { ...line("done", "page", 0), completed: true },
      line("open", "page", 0)
    ], [1, 2]);

    expect(decorations[0]?.options.inlineClassName).toBe(
      "yonalist-outline-completed-line"
    );
    expect(decorations[1]?.options.inlineClassName).toBeUndefined();
  });

  it("marks an image caption and leaves its chevron slot a leaf", () => {
    const decorations = buildOutlineDecorations([
      { ...line("picture", "page", 0), kind: "image" as const },
      { ...line("done", "page", 0), kind: "image" as const, completed: true }
    ], [1, 2]);

    expect(decorations[0]?.options.inlineClassName).toBe(
      "yonalist-outline-image-caption"
    );
    expect(decorations[0]?.options.before).toMatchObject({
      content: "▸  ",
      inlineClassName:
        "yonalist-outline-chevron yonalist-outline-chevron--leaf"
    });
    expect(decorations[0]?.options.after?.inlineClassName).toBe(
      "yonalist-outline-injected-bullet"
    );
    expect(decorations[1]?.options.inlineClassName).toBe(
      "yonalist-outline-completed-line yonalist-outline-image-caption"
    );
  });

  it("keeps the injected prefix anchored when typing at column one", () => {
    const model = monaco.editor.createModel("", "plaintext");
    const [decoration] = buildOutlineDecorations([line("root", "page", 0)], [1]);
    const [id] = model.deltaDecorations([], [decoration!]);

    model.pushEditOperations([], [{
      range: new monaco.Range(1, 1, 1, 1),
      text: "이슈"
    }], () => null);

    expect(model.getDecorationRange(id!)).toEqual(new monaco.Range(1, 1, 1, 1));
    model.dispose();
  });

  it("renders a note line as bare indent aligned with the title body", () => {
    const title = { ...line("first", "page", 1), kind: "note" as const };
    const decorations = buildOutlineDecorations([
      line("first", "page", 1),
      title
    ], [1, 2]);
    const titleOptions = decorations[0]!.options;
    const noteOptions = decorations[1]!.options;

    expect(noteOptions.before?.content).toBe(" ".repeat(10));
    // The note text starts where the title text starts, at the same depth.
    expect(noteOptions.before?.content).toHaveLength(
      (titleOptions.before?.content?.length ?? 0) +
        (titleOptions.after?.content?.length ?? 0)
    );
    expect(noteOptions.inlineClassName).toBe("yonalist-outline-note-line");
    expect(noteOptions.after).toBeUndefined();
    expect(noteOptions.before?.attachedData).toBeUndefined();
    expect(noteOptions.stickiness).toBe(
      monaco.editor.TrackedRangeStickiness.GrowsOnlyWhenTypingBefore
    );
  });

  it("keeps a chevron on a parent whose note run precedes its children", () => {
    const decorations = buildOutlineDecorations([
      line("root", "page", 0),
      { ...line("root", "page", 0), kind: "note" as const },
      line("child", "root", 1)
    ], [1]);

    expect(decorations[0]?.options.before).toMatchObject({
      content: "▾  ",
      attachedData: { kind: "yonalist-chevron", nodeId: "root" }
    });
  });

  it("keeps a note indent anchored when typing at column one", () => {
    const model = monaco.editor.createModel("alpha\n", "plaintext");
    const [decoration] = buildOutlineDecorations(
      [
        line("root", "page", 0),
        { ...line("root", "page", 0), kind: "note" as const }
      ],
      [2]
    );
    const [id] = model.deltaDecorations([], [decoration!]);

    model.pushEditOperations([], [{
      range: new monaco.Range(2, 1, 2, 1),
      text: "메모"
    }], () => null);

    expect(model.getDecorationRange(id!)).toEqual(new monaco.Range(2, 1, 2, 1));
    model.dispose();
  });

  it("marks a collapsed parent with the collapsed chevron", () => {
    const decorations = buildOutlineDecorations([
      { ...line("root", "page", 0), collapsed: true },
      line("child", "root", 1)
    ], [1]);

    expect(decorations[0]?.options.before).toMatchObject({
      content: "▸  ",
      inlineClassName:
        "yonalist-outline-chevron yonalist-outline-chevron--collapsed"
    });
    expect(decorations[0]?.options.after?.inlineClassName).toBe(
      "yonalist-outline-injected-bullet " +
      "yonalist-outline-injected-bullet--collapsed"
    );
  });
});
