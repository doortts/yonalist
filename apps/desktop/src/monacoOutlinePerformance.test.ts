import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import { OutlineIndex } from "./outlineIndex";
import {
  buildMonacoOutlineProjection,
  planMonacoProjectionEdit,
  type MonacoOutlineProjection
} from "./monacoOutlineProjection";

describe("Monaco outline performance guards", () => {
  it("projects 5,000 nodes and keeps repeated edits bounded", () => {
    const nodes = Array.from({ length: 5_000 }, (_, index) =>
      textNode(`node-${index}`, `Thought ${index}`, index)
    );
    const outlineIndex = new OutlineIndex(nodes);

    const projectionStarted = performance.now();
    let current = buildMonacoOutlineProjection(
      nodes,
      outlineIndex,
      "page",
      (id) => outlineIndex.node(id)?.text ?? ""
    );
    const projectionMs = performance.now() - projectionStarted;

    const editStarted = performance.now();
    for (let sample = 0; sample < 200; sample += 1) {
      const line = 2_500 + sample % 5;
      const next = replaceLine(current, line, `Edited thought ${sample}`);
      const edit = planMonacoProjectionEdit(current, next);
      expect(edit).not.toBeNull();
      expect(edit?.startLineNumber).toBe(line);
      expect(edit?.endLineNumber).toBe(line);
      expect(edit?.text.length).toBeLessThan(32);
      current = next;
    }
    const editMs = performance.now() - editStarted;

    const insertionStarted = performance.now();
    for (let sample = 0; sample < 100; sample += 1) {
      const line = 2_501;
      const next = insertLine(current, line, `Inserted thought ${sample}`);
      const edit = planMonacoProjectionEdit(current, next);
      expect(edit).not.toBeNull();
      expect(edit?.startLineNumber).toBe(line);
      expect(edit?.endLineNumber).toBe(line);
      expect(edit?.text.length).toBeLessThan(32);
      current = next;
    }
    const insertionMs = performance.now() - insertionStarted;

    expect(current.lines).toHaveLength(5_100);
    console.info("monaco-outline-sample", {
      projectionMs,
      twoHundredEditsMs: editMs,
      oneHundredInsertionsMs: insertionMs
    });
  });
});

function textNode(id: string, text: string, index: number): NoteView {
  return {
    id,
    parentId: "page",
    sortKey: (index + 1) * 1_024,
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

function replaceLine(
  projection: MonacoOutlineProjection,
  lineNumber: number,
  text: string
): MonacoOutlineProjection {
  const lines = projection.lines.map((line, index) =>
    index === lineNumber - 1 ? { ...line, text } : line
  );
  return withLines(lines);
}

function insertLine(
  projection: MonacoOutlineProjection,
  lineNumber: number,
  text: string
): MonacoOutlineProjection {
  const lines = [...projection.lines];
  lines.splice(lineNumber - 1, 0, {
    nodeId: `inserted-${projection.lines.length}`,
    text,
    depth: 0,
    editable: true
  });
  return withLines(lines);
}

function withLines(
  lines: MonacoOutlineProjection["lines"]
): MonacoOutlineProjection {
  const nodeIdByLine = lines.map((line) => line.nodeId);
  return {
    lines,
    value: lines.map((line) => line.text).join("\n"),
    nodeIdByLine,
    lineByNodeId: new Map(
      nodeIdByLine.map((nodeId, index) => [nodeId, index + 1])
    )
  };
}
