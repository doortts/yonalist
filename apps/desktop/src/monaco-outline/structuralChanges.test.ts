import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import { describe, expect, it } from "vitest";

import {
  OutlineMetadataTimeline,
  type OutlineLineMetadata
} from "./metadata";
import {
  canApplyNativeBoundaryEdit,
  interpretModelChanges,
  type OutlineStructuralTransition
} from "./structuralChanges";

function line(
  nodeId: string,
  parentId = "page",
  depth = 0
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

function applyModelEditFixture(input: {
  readonly value: string;
  readonly lines: readonly OutlineLineMetadata[];
  readonly range: monaco.Range;
  readonly text: string;
  readonly allocatedIds: readonly string[];
}): OutlineStructuralTransition {
  return applyBatchedEditFixture({
    value: input.value,
    lines: input.lines,
    edits: [{ range: input.range, text: input.text }],
    allocatedIds: input.allocatedIds
  });
}

function applyBatchedEditFixture(input: {
  readonly value: string;
  readonly lines: readonly OutlineLineMetadata[];
  readonly edits: readonly monaco.editor.IIdentifiedSingleEditOperation[];
  readonly allocatedIds: readonly string[];
}): OutlineStructuralTransition {
  const model = monaco.editor.createModel(input.value, "plaintext");
  const before = OutlineMetadataTimeline.hydrate(
    model.getAlternativeVersionId(),
    input.lines
  ).current();
  let event: monaco.editor.IModelContentChangedEvent | undefined;
  const listener = model.onDidChangeContent((next) => {
    event = next;
  });
  model.pushEditOperations([], [...input.edits], () => null);
  const ids = [...input.allocatedIds];
  const transition = interpretModelChanges({
    before,
    beforeTexts: input.value.split("\n"),
    event: event ?? (() => {
      throw new Error("Monaco did not emit a content change.");
    })(),
    model,
    allocateId: () => {
      const next = ids.shift();
      if (!next) throw new Error("The fixture exhausted its allocated IDs.");
      return next;
    }
  });
  expect(ids).toHaveLength(0);
  listener.dispose();
  model.dispose();
  return transition;
}

describe("interpretModelChanges", () => {
  it("keeps the source id on a middle split and allocates the suffix id", () => {
    const transition = applyModelEditFixture({
      value: "Changes appear instantly.",
      lines: [line("first")],
      range: new monaco.Range(1, 9, 1, 9),
      text: "\n",
      allocatedIds: ["inserted"]
    });

    expect(transition.after.lines.map(({ nodeId }) => nodeId)).toEqual([
      "first",
      "inserted"
    ]);
    expect(transition.textPatch).toEqual({
      startIndex: 0,
      deleteCount: 1,
      insertedTexts: ["Changes ", "appear instantly."]
    });
    expect(transition.forward).toEqual([
      {
        kind: "splitNode",
        id: "first",
        new_id: "inserted",
        parent_id: "page",
        before_id: null,
        prefix: "Changes ",
        suffix: "appear instantly."
      }
    ]);
    expect(transition.inverse).toEqual([
      { kind: "updateText", id: "inserted", text: "" },
      { kind: "removeEmptyNode", id: "inserted" },
      {
        kind: "updateText",
        id: "first",
        text: "Changes appear instantly."
      }
    ]);
  });

  it("keeps the current id when Backspace deletes a nonempty previous newline", () => {
    const transition = applyModelEditFixture({
      value: "alpha\nbeta",
      lines: [line("first"), line("second")],
      range: new monaco.Range(1, 6, 2, 1),
      text: "",
      allocatedIds: []
    });

    expect(transition.after.lines.map(({ nodeId }) => nodeId)).toEqual([
      "second"
    ]);
    expect(transition.forward).toEqual([
      {
        kind: "mergeNodeBackward",
        id: "second",
        previous_id: "first",
        previous_text: "alpha",
        current_text: "beta"
      }
    ]);
    expect(transition.inverse).toEqual([
      {
        kind: "createNode",
        id: "first",
        parent_id: "page",
        before_id: "second",
        text: "alpha"
      },
      { kind: "updateText", id: "second", text: "beta" }
    ]);
  });

  it("keeps the previous id when an empty current line is removed backward", () => {
    const transition = applyModelEditFixture({
      value: "alpha\n",
      lines: [line("first"), line("second")],
      range: new monaco.Range(1, 6, 2, 1),
      text: "",
      allocatedIds: []
    });

    expect(transition.after.lines.map(({ nodeId }) => nodeId)).toEqual([
      "first"
    ]);
    expect(transition.forward).toEqual([
      { kind: "removeEmptyNode", id: "second" }
    ]);
    expect(transition.inverse).toEqual([
      {
        kind: "createNode",
        id: "second",
        parent_id: "page",
        before_id: null,
        text: ""
      }
    ]);
  });

  it("coalesces ordinary title edits without copying metadata", () => {
    const transition = applyModelEditFixture({
      value: "alpha",
      lines: [line("first")],
      range: new monaco.Range(1, 6, 1, 6),
      text: "!",
      allocatedIds: []
    });

    expect(transition.structural).toBe(false);
    expect(transition.after.lines).toBe(transition.before.lines);
    expect(transition.forward).toEqual([
      { kind: "updateText", id: "first", text: "alpha!" }
    ]);
    expect(transition.inverse).toEqual([
      { kind: "updateText", id: "first", text: "alpha" }
    ]);
  });

  it("allocates simultaneous split ids in visual source order", () => {
    const transition = applyBatchedEditFixture({
      value: "alpha\nbeta",
      lines: [line("first"), line("second")],
      edits: [
        { range: new monaco.Range(1, 6, 1, 6), text: "\n" },
        { range: new monaco.Range(2, 5, 2, 5), text: "\n" }
      ],
      allocatedIds: ["inserted-1", "inserted-2"]
    });

    expect(transition.after.lines.map(({ nodeId }) => nodeId)).toEqual([
      "first",
      "inserted-1",
      "second",
      "inserted-2"
    ]);
    expect(
      transition.forward
        .filter(({ kind }) => kind === "splitNode")
        .map((command) => command.kind === "splitNode" && command.new_id)
    ).toEqual(["inserted-2", "inserted-1"]);
  });

  it("retains eligible boundary ids for a multi-line replacement", () => {
    const transition = applyModelEditFixture({
      value: "alpha\nbeta\ngamma",
      lines: [line("first"), line("middle"), line("last")],
      range: new monaco.Range(1, 3, 3, 3),
      text: "X\nY",
      allocatedIds: []
    });

    expect(transition.after.lines.map(({ nodeId }) => nodeId)).toEqual([
      "first",
      "last"
    ]);
    expect(transition.textPatch.insertedTexts).toEqual(["alX", "Ymma"]);
    expect(transition.forward).toContainEqual({
      kind: "removeEmptyNode",
      id: "middle"
    });
    expect(transition.inverse).toContainEqual({
      kind: "createNode",
      id: "middle",
      parent_id: "page",
      before_id: "last",
      text: "beta"
    });
  });
});

describe("canApplyNativeBoundaryEdit", () => {
  it("allows same-parent leaf merges and rejects a boundary with children", () => {
    const leafSnapshot = OutlineMetadataTimeline.hydrate(1, [
      line("first"),
      line("second")
    ]).current();
    expect(
      canApplyNativeBoundaryEdit({
        snapshot: leafSnapshot,
        texts: ["alpha", "beta"],
        selection: new monaco.Selection(2, 1, 2, 1),
        command: "backspace"
      })
    ).toBe(true);

    const nestedSnapshot = OutlineMetadataTimeline.hydrate(1, [
      line("parent"),
      line("child", "parent", 1),
      line("second")
    ]).current();
    expect(
      canApplyNativeBoundaryEdit({
        snapshot: nestedSnapshot,
        texts: ["parent", "child", "second"],
        selection: new monaco.Selection(3, 1, 3, 1),
        command: "backspace"
      })
    ).toBe(false);
  });
});
