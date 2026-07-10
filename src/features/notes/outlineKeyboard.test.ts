import { describe, expect, it } from "vitest";
import type { NoteNode, NotesWorkspace } from "../../domain/notes";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import {
  resolveOutlineKey,
  type ResolveOutlineKeyInput
} from "./outlineKeyboard";

function node(overrides: Partial<NoteNode> & Pick<NoteNode, "id">): NoteNode {
  return {
    parentId: null,
    sortKey: 1024,
    title: overrides.id,
    note: "",
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-10T00:00:00Z",
    updatedAt: "2026-07-10T00:00:00Z",
    deletedAt: null,
    ...overrides
  };
}

function workspace(nodes: NoteNode[]): NotesWorkspace {
  return { nodes };
}

const tree = normalizeWorkspace(
  workspace([
    node({ id: "root-a", sortKey: 1, title: "Root alpha" }),
    node({ id: "child-a", parentId: "root-a", sortKey: 1 }),
    node({ id: "grandchild", parentId: "child-a", sortKey: 1 }),
    node({ id: "child-b", parentId: "root-a", sortKey: 2 }),
    node({ id: "root-b", sortKey: 2 }),
    node({ id: "root-c", sortKey: 3, isCollapsed: true }),
    node({ id: "hidden-child", parentId: "root-c", sortKey: 1 })
  ])
);

function input(
  overrides: Partial<ResolveOutlineKeyInput> = {}
): ResolveOutlineKeyInput {
  return {
    target: "title",
    key: "Enter",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    repeat: false,
    selectionStart: 0,
    selectionEnd: 0,
    title: "Root alpha",
    note: "",
    nodeId: "root-a",
    workspace: tree,
    ...overrides
  };
}

describe("resolveOutlineKey", () => {
  it("splits Enter around the full selected title range", () => {
    expect(
      resolveOutlineKey(
        input({ selectionStart: 5, selectionEnd: 8, title: "alphaXYZomega" })
      )
    ).toEqual({ type: "split", prefix: "alpha", suffix: "omega" });
  });

  it("indents under the prior same-parent sibling as its last child", () => {
    expect(
      resolveOutlineKey(
        input({ key: "Tab", nodeId: "child-b", title: "child-b" })
      )
    ).toEqual({
      type: "move",
      input: {
        id: "child-b",
        parentId: "child-a",
        afterId: "grandchild"
      },
      focusNodeId: "child-b"
    });
  });

  it("does not indent a first sibling", () => {
    expect(
      resolveOutlineKey(
        input({ key: "Tab", nodeId: "child-a", title: "child-a" })
      )
    ).toBeNull();
  });

  it("expands a collapsed prior sibling before indenting under it", () => {
    const collapsedPrior = normalizeWorkspace(
      workspace([
        node({ id: "first", sortKey: 1, isCollapsed: true }),
        node({ id: "hidden", parentId: "first", sortKey: 1 }),
        node({ id: "second", sortKey: 2 })
      ])
    );
    expect(
      resolveOutlineKey(
        input({
          key: "Tab",
          nodeId: "second",
          title: "second",
          workspace: collapsedPrior
        })
      )
    ).toEqual({
      type: "move",
      input: {
        id: "second",
        parentId: "first",
        afterId: "hidden"
      },
      focusNodeId: "second",
      expandNodeId: "first"
    });
  });

  it("outdents immediately after the former parent and ignores roots", () => {
    expect(
      resolveOutlineKey(
        input({
          key: "Tab",
          shiftKey: true,
          nodeId: "grandchild",
          title: "grandchild"
        })
      )
    ).toEqual({
      type: "move",
      input: {
        id: "grandchild",
        parentId: "root-a",
        afterId: "child-a"
      },
      focusNodeId: "grandchild"
    });
    expect(
      resolveOutlineKey(
        input({ key: "Tab", shiftKey: true, nodeId: "root-a" })
      )
    ).toBeNull();
  });

  it("moves Up and Down through visible rows with zoom and bounds", () => {
    expect(
      resolveOutlineKey(
        input({ key: "ArrowUp", nodeId: "child-b", title: "child-b" })
      )
    ).toEqual({ type: "focus", nodeId: "grandchild" });
    expect(
      resolveOutlineKey(
        input({ key: "ArrowDown", nodeId: "root-c", title: "root-c" })
      )
    ).toBeNull();

    const zoomed = { ...tree, zoomRootId: "child-a" };
    expect(
      resolveOutlineKey(
        input({
          key: "ArrowDown",
          nodeId: "child-a",
          title: "child-a",
          workspace: zoomed
        })
      )
    ).toEqual({ type: "focus", nodeId: "grandchild" });
    expect(
      resolveOutlineKey(
        input({
          key: "ArrowUp",
          nodeId: "child-a",
          title: "child-a",
          workspace: zoomed
        })
      )
    ).toBeNull();
  });

  it("uses Left only at the title start to collapse or focus the visible parent", () => {
    expect(
      resolveOutlineKey(
        input({
          key: "ArrowLeft",
          nodeId: "root-a",
          selectionStart: 0,
          selectionEnd: 0
        })
      )
    ).toEqual({ type: "toggleCollapsed" });
    expect(
      resolveOutlineKey(
        input({
          key: "ArrowLeft",
          nodeId: "child-b",
          title: "child-b",
          selectionStart: 0,
          selectionEnd: 0
        })
      )
    ).toEqual({ type: "focus", nodeId: "root-a" });
    expect(
      resolveOutlineKey(
        input({
          key: "ArrowLeft",
          nodeId: "child-b",
          title: "child-b",
          selectionStart: 1,
          selectionEnd: 1
        })
      )
    ).toBeNull();
  });

  it("uses Right only at the title end to expand or focus the first child", () => {
    expect(
      resolveOutlineKey(
        input({
          key: "ArrowRight",
          nodeId: "root-c",
          title: "root-c",
          selectionStart: 6,
          selectionEnd: 6
        })
      )
    ).toEqual({ type: "toggleCollapsed" });
    expect(
      resolveOutlineKey(
        input({
          key: "ArrowRight",
          nodeId: "root-a",
          selectionStart: 10,
          selectionEnd: 10
        })
      )
    ).toEqual({ type: "focus", nodeId: "child-a" });
    expect(
      resolveOutlineKey(
        input({
          key: "ArrowRight",
          nodeId: "root-a",
          selectionStart: 9,
          selectionEnd: 9
        })
      )
    ).toBeNull();
  });

  it("removes only a whitespace-empty row and chooses previous then next focus", () => {
    expect(
      resolveOutlineKey(
        input({
          key: "Backspace",
          nodeId: "root-b",
          title: " \t",
          note: "\n",
          selectionStart: 0,
          selectionEnd: 0
        })
      )
    ).toEqual({ type: "remove", focusNodeId: "child-b" });

    expect(
      resolveOutlineKey(
        input({
          key: "Backspace",
          nodeId: "root-a",
          title: "",
          note: "",
          selectionStart: 0,
          selectionEnd: 0
        })
      )
    ).toEqual({ type: "remove", focusNodeId: "child-a" });
  });

  it("chooses the first lifted child before the next visible row", () => {
    const collapsedEmptyParent = normalizeWorkspace(
      workspace([
        node({ id: "empty", sortKey: 1, title: "", isCollapsed: true }),
        node({ id: "lifted-a", parentId: "empty", sortKey: 1 }),
        node({ id: "lifted-b", parentId: "empty", sortKey: 2 }),
        node({ id: "next", sortKey: 2 })
      ])
    );

    expect(
      resolveOutlineKey(
        input({
          key: "Backspace",
          nodeId: "empty",
          title: "",
          note: "",
          selectionStart: 0,
          selectionEnd: 0,
          workspace: collapsedEmptyParent
        })
      )
    ).toEqual({ type: "remove", focusNodeId: "lifted-a" });
  });

  it("keeps Backspace native for nonempty notes, repeats, and non-start carets", () => {
    expect(
      resolveOutlineKey(
        input({ key: "Backspace", title: "", note: "context" })
      )
    ).toBeNull();
    expect(
      resolveOutlineKey(
        input({ key: "Backspace", title: "", repeat: true })
      )
    ).toBeNull();
    expect(
      resolveOutlineKey(
        input({
          key: "Backspace",
          title: " ",
          selectionStart: 1,
          selectionEnd: 1
        })
      )
    ).toBeNull();
  });

  it("ignores IME, Process, textarea, unsupported modifiers, and invalid bounds", () => {
    expect(resolveOutlineKey(input({ isComposing: true }))).toBeNull();
    expect(resolveOutlineKey(input({ key: "Process" }))).toBeNull();
    expect(resolveOutlineKey(input({ target: "textarea" }))).toBeNull();
    expect(resolveOutlineKey(input({ ctrlKey: true }))).toBeNull();
    expect(resolveOutlineKey(input({ key: "ArrowDown", shiftKey: true }))).toBeNull();
    expect(
      resolveOutlineKey(input({ selectionStart: null, selectionEnd: null }))
    ).toBeNull();
    expect(
      resolveOutlineKey(input({ selectionStart: 7, selectionEnd: 4 }))
    ).toBeNull();
    expect(
      resolveOutlineKey(input({ selectionStart: 0, selectionEnd: 99 }))
    ).toBeNull();
  });
});
