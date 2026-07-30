import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesStore } from "./notesStore";
import { OutlineIndex } from "./outlineIndex";
import {
  executeMonacoOutlineGesture,
  type MonacoOutlineCommandRuntime
} from "./monacoOutlineCommands";
import type { MonacoOutlineProjection } from "./monacoOutlineProjection";

describe("Monaco outline command execution", () => {
  it("routes a selected split through the optimistic NotesStore command", () => {
    const nodes = [node("first", "Alpha")];
    const beginSplitNode = vi.fn(() => ({
      id: "created",
      committed: Promise.resolve()
    }));
    const store = {
      beginSplitNode,
      getSnapshot: () => ({ nodes }),
      getNodeSnapshot: () => ({ title: "Alpha" })
    } as unknown as NotesStore;
    const runtime = commandRuntime(projection(nodes));

    executeMonacoOutlineGesture(
      { kind: "split", nodeId: "first", startOffset: 2, endOffset: 4 },
      false,
      null,
      runtime,
      store,
      context(nodes)
    );

    expect(beginSplitNode).toHaveBeenCalledWith({
      id: "first",
      parentId: "page",
      beforeId: null,
      prefix: "Al",
      suffix: "a"
    });
    expect(runtime.pendingCaret).toEqual({ nodeId: "created", column: 1 });
  });

  it("keeps the surviving node and join column after a backward merge", () => {
    const nodes = [
      node("previous", "Alpha", 1_024),
      node("current", "Beta", 2_048)
    ];
    const beginMergeNodeBackward = vi.fn(() => ({
      committed: Promise.resolve()
    }));
    const store = {
      beginMergeNodeBackward,
      getNodeSnapshot: (id: string) => ({
        title: id === "previous" ? "Alpha" : "Beta"
      })
    } as unknown as NotesStore;
    const runtime = commandRuntime(projection(nodes));

    executeMonacoOutlineGesture(
      {
        kind: "mergeBackward",
        nodeId: "current",
        previousId: "previous"
      },
      true,
      "backspace-group",
      runtime,
      store,
      context(nodes)
    );

    expect(beginMergeNodeBackward).toHaveBeenCalledWith({
      id: "current",
      previousId: "previous",
      previousText: "Alpha",
      currentText: "Beta",
      historyGroup: "backspace-group"
    });
    expect(runtime.pendingCaret).toEqual({
      nodeId: "current",
      column: 6
    });
  });
});

function commandRuntime(
  currentProjection: MonacoOutlineProjection
): MonacoOutlineCommandRuntime {
  return {
    editor: {
      getPosition: () => ({ lineNumber: 1, column: 1 })
    } as unknown as monaco.editor.IStandaloneCodeEditor,
    model: {
      getLineContent: (lineNumber: number) =>
        currentProjection.lines[lineNumber - 1]?.text ?? ""
    } as unknown as monaco.editor.ITextModel,
    projection: currentProjection,
    enterGesture: null,
    pendingCaret: null
  };
}

function context(nodes: readonly NoteView[]) {
  return {
    index: new OutlineIndex(nodes),
    rootId: "page",
    structuralContextComplete: true
  };
}

function projection(nodes: readonly NoteView[]): MonacoOutlineProjection {
  return {
    lines: nodes.map((item) => ({
      nodeId: item.id,
      text: item.text,
      depth: 0,
      editable: true
    })),
    value: nodes.map((item) => item.text).join("\n"),
    lineByNodeId: new Map(
      nodes.map((item, index) => [item.id, index + 1])
    ),
    nodeIdByLine: nodes.map((item) => item.id)
  };
}

function node(id: string, text: string, sortKey = 1_024): NoteView {
  return {
    id,
    parentId: "page",
    sortKey,
    kind: "bullet",
    image: null,
    text,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}
