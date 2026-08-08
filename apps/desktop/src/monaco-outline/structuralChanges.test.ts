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
  depth = 0,
  kind: OutlineLineMetadata["kind"] = "text"
): OutlineLineMetadata {
  return {
    nodeId,
    parentId,
    depth,
    kind,
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

  it("splits the end of a parent into an empty first child", () => {
    const transition = applyModelEditFixture({
      value: "Parent\nChild",
      lines: [line("parent"), line("child", "parent", 1)],
      range: new monaco.Range(1, 7, 1, 7),
      text: "\n",
      allocatedIds: ["inserted"]
    });

    expect(transition.after.lines).toMatchObject([
      { nodeId: "parent", depth: 0 },
      { nodeId: "inserted", parentId: "parent", depth: 1 },
      { nodeId: "child", parentId: "parent", depth: 1 }
    ]);
    expect(transition.forward).toEqual([
      {
        kind: "createNode",
        id: "inserted",
        parent_id: "parent",
        before_id: "child",
        text: ""
      }
    ]);
    expect(transition.inverse).toEqual([
      { kind: "updateText", id: "inserted", text: "" },
      { kind: "removeEmptyNode", id: "inserted" }
    ]);
  });

  it("moves the suffix of a mid-text parent split into the first child", () => {
    const transition = applyModelEditFixture({
      value: "Parent\nChild",
      lines: [line("parent"), line("child", "parent", 1)],
      range: new monaco.Range(1, 4, 1, 4),
      text: "\n",
      allocatedIds: ["inserted"]
    });

    expect(transition.after.lines).toMatchObject([
      { nodeId: "parent", depth: 0 },
      { nodeId: "inserted", parentId: "parent", depth: 1 },
      { nodeId: "child", parentId: "parent", depth: 1 }
    ]);
    expect(transition.forward).toEqual([
      { kind: "updateText", id: "parent", text: "Par" },
      {
        kind: "createNode",
        id: "inserted",
        parent_id: "parent",
        before_id: "child",
        text: "ent"
      }
    ]);
    expect(transition.inverse).toEqual([
      { kind: "updateText", id: "inserted", text: "" },
      { kind: "removeEmptyNode", id: "inserted" },
      { kind: "updateText", id: "parent", text: "Parent" }
    ]);
  });

  it("splits column one of a parent into an empty sibling above", () => {
    const transition = applyModelEditFixture({
      value: "Parent\nChild",
      lines: [line("parent"), line("child", "parent", 1)],
      range: new monaco.Range(1, 1, 1, 1),
      text: "\n",
      allocatedIds: ["inserted"]
    });

    expect(transition.after.lines).toMatchObject([
      { nodeId: "inserted", parentId: "page", depth: 0 },
      { nodeId: "parent", parentId: "page", depth: 0 },
      { nodeId: "child", parentId: "parent", depth: 1 }
    ]);
    expect(transition.forward).toEqual([
      {
        kind: "createNode",
        id: "inserted",
        parent_id: "page",
        before_id: "parent",
        text: ""
      }
    ]);
  });

  it("expands a collapsed parent when a split enters its children", () => {
    const transition = applyModelEditFixture({
      value: "Parent\nChild",
      lines: [
        { ...line("parent"), collapsed: true },
        line("child", "parent", 1)
      ],
      range: new monaco.Range(1, 7, 1, 7),
      text: "\n",
      allocatedIds: ["inserted"]
    });

    expect(transition.after.lines[0]).toMatchObject({
      nodeId: "parent",
      collapsed: false
    });
    expect(transition.forward).toEqual([
      { kind: "setCollapsed", id: "parent", collapsed: false },
      {
        kind: "createNode",
        id: "inserted",
        parent_id: "parent",
        before_id: "child",
        text: ""
      }
    ]);
    expect(transition.inverse).toEqual([
      { kind: "updateText", id: "inserted", text: "" },
      { kind: "removeEmptyNode", id: "inserted" },
      { kind: "setCollapsed", id: "parent", collapsed: true }
    ]);
  });

  it("removes an empty child line backward into a shallower parent", () => {
    const transition = applyModelEditFixture({
      value: "Parent\n\nChild",
      lines: [
        line("parent"),
        line("empty", "parent", 1),
        line("child", "parent", 1)
      ],
      range: new monaco.Range(1, 7, 2, 1),
      text: "",
      allocatedIds: []
    });

    expect(transition.after.lines).toMatchObject([
      { nodeId: "parent", depth: 0 },
      { nodeId: "child", parentId: "parent", depth: 1 }
    ]);
    expect(transition.forward).toEqual([
      { kind: "removeEmptyNode", id: "empty" }
    ]);
    expect(transition.inverse).toEqual([
      {
        kind: "createNode",
        id: "empty",
        parent_id: "parent",
        before_id: "child",
        text: ""
      }
    ]);
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

  it("allows removing an empty current line across a depth boundary", () => {
    const snapshot = OutlineMetadataTimeline.hydrate(1, [
      line("parent"),
      line("empty", "parent", 1),
      line("child", "parent", 1)
    ]).current();
    expect(
      canApplyNativeBoundaryEdit({
        snapshot,
        texts: ["parent", "", "child"],
        selection: new monaco.Selection(2, 1, 2, 1),
        command: "backspace"
      })
    ).toBe(true);

    const emptyParentSnapshot = OutlineMetadataTimeline.hydrate(1, [
      line("parent"),
      line("empty", "parent", 1),
      line("grandchild", "empty", 2)
    ]).current();
    expect(
      canApplyNativeBoundaryEdit({
        snapshot: emptyParentSnapshot,
        texts: ["parent", "", "grandchild"],
        selection: new monaco.Selection(2, 1, 2, 1),
        command: "backspace"
      })
    ).toBe(false);
  });
});

describe("note and image line interpretation", () => {
  it("maps a note line text edit onto the reassembled note", () => {
    const transition = applyModelEditFixture({
      value: "alpha\nnote one\nnote two",
      lines: [line("first"), line("first", "page", 0, "note"), line("first", "page", 0, "note")],
      range: new monaco.Range(2, 1, 2, 9),
      text: "changed",
      allocatedIds: []
    });

    expect(transition.structural).toBe(false);
    expect(transition.forward).toEqual([
      { kind: "updateNote", id: "first", note: "changed\nnote two" }
    ]);
    expect(transition.inverse).toEqual([
      { kind: "updateNote", id: "first", note: "note one\nnote two" }
    ]);
  });

  it("splits a note line without allocating a node", () => {
    const transition = applyModelEditFixture({
      value: "alpha\nnote one",
      lines: [line("first"), line("first", "page", 0, "note")],
      range: new monaco.Range(2, 5, 2, 5),
      text: "\n",
      allocatedIds: []
    });

    expect(transition.after.lines.map(({ nodeId, kind }) => `${nodeId}:${kind}`)).toEqual([
      "first:text",
      "first:note",
      "first:note"
    ]);
    expect(transition.forward).toEqual([
      { kind: "updateNote", id: "first", note: "note\n one" }
    ]);
    expect(transition.inverse).toEqual([
      { kind: "updateNote", id: "first", note: "note one" }
    ]);
  });

  it("merges two note lines of one run into a single note", () => {
    const transition = applyModelEditFixture({
      value: "alpha\nnote one\nnote two",
      lines: [line("first"), line("first", "page", 0, "note"), line("first", "page", 0, "note")],
      range: new monaco.Range(2, 9, 3, 1),
      text: "",
      allocatedIds: []
    });

    expect(transition.after.lines).toHaveLength(2);
    expect(transition.forward).toEqual([
      { kind: "updateNote", id: "first", note: "note onenote two" }
    ]);
    expect(transition.inverse).toEqual([
      { kind: "updateNote", id: "first", note: "note one\nnote two" }
    ]);
  });

  it("refuses merges that cross a note boundary and allows merges inside a run", () => {
    const snapshot = OutlineMetadataTimeline.hydrate(1, [
      line("first"),
      line("first", "page", 0, "note"),
      line("first", "page", 0, "note"),
      line("second")
    ]).current();
    const texts = ["alpha", "note one", "note two", "beta"];

    // Note run first line, Backspace at column 1 — would merge into the title.
    expect(
      canApplyNativeBoundaryEdit({
        snapshot,
        texts,
        selection: new monaco.Selection(2, 1, 2, 1),
        command: "backspace"
      })
    ).toBe(false);
    // Title line below a note run, Backspace at column 1.
    expect(
      canApplyNativeBoundaryEdit({
        snapshot,
        texts,
        selection: new monaco.Selection(4, 1, 4, 1),
        command: "backspace"
      })
    ).toBe(false);
    // Delete at the end of a title that owns a note run.
    expect(
      canApplyNativeBoundaryEdit({
        snapshot,
        texts,
        selection: new monaco.Selection(1, 6, 1, 6),
        command: "delete"
      })
    ).toBe(false);
    // Delete at the end of the last note line of a run.
    expect(
      canApplyNativeBoundaryEdit({
        snapshot,
        texts,
        selection: new monaco.Selection(3, 9, 3, 9),
        command: "delete"
      })
    ).toBe(false);
    // Backspace inside the run stays native.
    expect(
      canApplyNativeBoundaryEdit({
        snapshot,
        texts,
        selection: new monaco.Selection(3, 1, 3, 1),
        command: "backspace"
      })
    ).toBe(true);
  });

  it("refuses every structural edit that touches an image line", () => {
    const snapshot = OutlineMetadataTimeline.hydrate(1, [
      line("picture", "page", 0, "image"),
      line("second")
    ]).current();
    const texts = ["caption", "beta"];

    expect(
      canApplyNativeBoundaryEdit({
        snapshot,
        texts,
        selection: new monaco.Selection(1, 1, 2, 5),
        command: "backspace"
      })
    ).toBe(false);
    expect(
      canApplyNativeBoundaryEdit({
        snapshot,
        texts,
        selection: new monaco.Selection(2, 1, 2, 1),
        command: "backspace"
      })
    ).toBe(false);
    expect(() =>
      applyModelEditFixture({
        value: "caption\nbeta",
        lines: [line("picture", "page", 0, "image"), line("second")],
        range: new monaco.Range(1, 8, 2, 1),
        text: "",
        allocatedIds: []
      })
    ).toThrow("image line");
    expect(() =>
      applyModelEditFixture({
        value: "caption\nbeta",
        lines: [line("picture", "page", 0, "image"), line("second")],
        range: new monaco.Range(1, 8, 1, 8),
        text: "\n",
        allocatedIds: []
      })
    ).toThrow("image line");
  });
});
