import { describe, expect, it } from "vitest";
import type { NoteNode, NotesWorkspace } from "../../domain/notes";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import {
  detectOutlineShortcutPlatform,
  resolveNotesHistoryShortcut,
  resolveOutlineKey,
  type ResolveNotesHistoryShortcutInput,
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
    archivedAt: null,
    archiveRootId: null,
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
    platform: "other",
    workspace: tree,
    ...overrides
  };
}

function historyShortcutInput(
  overrides: Partial<ResolveNotesHistoryShortcutInput> = {}
): ResolveNotesHistoryShortcutInput {
  return {
    key: "z",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    platform: "other",
    ...overrides
  };
}

describe("resolveOutlineKey", () => {
  it.each([
    ["MacIntel", "mac"],
    ["MacPPC", "mac"],
    ["iPhone", "mac"],
    ["Win32", "other"],
    ["Linux x86_64", "other"],
    ["", "other"]
  ] as const)("detects %s as %s", (platform, expected) => {
    expect(detectOutlineShortcutPlatform(platform)).toBe(expected);
  });

  it.each([
    {
      label: "Shift+Enter",
      overrides: { key: "Enter", shiftKey: true },
      resolution: { type: "focusNote" }
    },
    {
      label: "Ctrl+Enter on other platforms",
      overrides: { key: "Enter", ctrlKey: true, platform: "other" as const },
      resolution: { type: "toggleComplete" }
    },
    {
      label: "Cmd+Enter on macOS",
      overrides: { key: "Enter", metaKey: true, platform: "mac" as const },
      resolution: { type: "toggleComplete" }
    },
    {
      label: "Alt+Shift+D on other platforms",
      overrides: {
        key: "D",
        altKey: true,
        shiftKey: true,
        platform: "other" as const
      },
      resolution: { type: "duplicate" }
    },
    {
      label: "Cmd+Shift+D on macOS",
      overrides: {
        key: "D",
        metaKey: true,
        shiftKey: true,
        platform: "mac" as const
      },
      resolution: { type: "duplicate" }
    },
    {
      label: "Ctrl+Shift+Backspace on other platforms",
      overrides: {
        key: "Backspace",
        ctrlKey: true,
        shiftKey: true,
        platform: "other" as const
      },
      resolution: { type: "delete" }
    },
    {
      label: "Cmd+Shift+Backspace on macOS",
      overrides: {
        key: "Backspace",
        metaKey: true,
        shiftKey: true,
        platform: "mac" as const
      },
      resolution: { type: "delete" }
    }
  ])("resolves $label to a Workflowy command", ({ overrides, resolution }) => {
    expect(resolveOutlineKey(input(overrides))).toEqual(resolution);
  });

  it.each([
    {
      label: "Cmd+Enter on other platforms",
      overrides: { key: "Enter", metaKey: true, platform: "other" as const }
    },
    {
      label: "Ctrl+Enter on macOS",
      overrides: { key: "Enter", ctrlKey: true, platform: "mac" as const }
    },
    {
      label: "Cmd+Shift+D on other platforms",
      overrides: {
        key: "D",
        metaKey: true,
        shiftKey: true,
        platform: "other" as const
      }
    },
    {
      label: "Alt+Shift+D on macOS",
      overrides: {
        key: "D",
        altKey: true,
        shiftKey: true,
        platform: "mac" as const
      }
    },
    {
      label: "Cmd+Shift+Backspace on other platforms",
      overrides: {
        key: "Backspace",
        metaKey: true,
        shiftKey: true,
        platform: "other" as const
      }
    },
    {
      label: "Ctrl+Shift+Backspace on macOS",
      overrides: {
        key: "Backspace",
        ctrlKey: true,
        shiftKey: true,
        platform: "mac" as const
      }
    }
  ])("rejects $label", ({ overrides }) => {
    expect(resolveOutlineKey(input(overrides))).toBeNull();
  });

  it("ignores repeated Workflowy commands", () => {
    expect(
      resolveOutlineKey(input({ key: "Enter", shiftKey: true, repeat: true }))
    ).toBeNull();
    expect(
      resolveOutlineKey(input({ key: "Enter", ctrlKey: true, repeat: true }))
    ).toBeNull();
    expect(
      resolveOutlineKey(
        input({ key: "D", altKey: true, shiftKey: true, repeat: true })
      )
    ).toBeNull();
    expect(
      resolveOutlineKey(
        input({
          key: "Backspace",
          metaKey: true,
          shiftKey: true,
          repeat: true
        })
      )
    ).toBeNull();
  });

  it("keeps Workflowy commands native for textarea and IME targets", () => {
    expect(
      resolveOutlineKey(input({ target: "textarea", key: "Enter", shiftKey: true }))
    ).toBeNull();
    expect(
      resolveOutlineKey(input({ key: "Enter", ctrlKey: true, isComposing: true }))
    ).toBeNull();
    expect(
      resolveOutlineKey(input({ key: "D", metaKey: true, shiftKey: true, isComposing: true }))
    ).toBeNull();
    expect(
      resolveOutlineKey(
        input({ key: "Backspace", ctrlKey: true, shiftKey: true, isComposing: true })
      )
    ).toBeNull();
  });

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

  it("refuses to outdent a zoom root's direct child out of the zoomed subtree", () => {
    const zoomedAtRootA = { ...tree, zoomRootId: "root-a" };
    expect(
      resolveOutlineKey(
        input({
          key: "Tab",
          shiftKey: true,
          nodeId: "child-a",
          title: "child-a",
          workspace: zoomedAtRootA
        })
      )
    ).toBeNull();
  });

  it("still outdents a deeper descendant while confined to the zoomed subtree", () => {
    const zoomedAtRootA = { ...tree, zoomRootId: "root-a" };
    expect(
      resolveOutlineKey(
        input({
          key: "Tab",
          shiftKey: true,
          nodeId: "grandchild",
          title: "grandchild",
          workspace: zoomedAtRootA
        })
      )
    ).toEqual({
      type: "move",
      input: { id: "grandchild", parentId: "root-a", afterId: "child-a" },
      focusNodeId: "grandchild"
    });
  });

  it("keeps unzoomed root-level outdent behavior unchanged", () => {
    expect(
      resolveOutlineKey(
        input({ key: "Tab", shiftKey: true, nodeId: "child-a", title: "child-a" })
      )
    ).toEqual({
      type: "move",
      input: { id: "child-a", parentId: null, afterId: "root-a" },
      focusNodeId: "child-a"
    });
  });

  it("refuses to indent under a hidden completed prior sibling", () => {
    const hiddenCompleted = normalizeWorkspace(
      workspace([
        node({
          id: "done",
          sortKey: 1,
          completedAt: "2026-07-10T00:00:00Z"
        }),
        node({ id: "task", sortKey: 2 })
      ])
    );
    expect(
      resolveOutlineKey(
        input({
          key: "Tab",
          nodeId: "task",
          title: "task",
          workspace: hiddenCompleted,
          visibleNodeIds: ["task"]
        })
      )
    ).toBeNull();
  });

  it("indents under the nearest visible prior sibling and expands it when collapsed", () => {
    const hiddenBetween = normalizeWorkspace(
      workspace([
        node({ id: "a", sortKey: 1, isCollapsed: true }),
        node({ id: "a-child", parentId: "a", sortKey: 1 }),
        node({
          id: "done",
          sortKey: 2,
          completedAt: "2026-07-10T00:00:00Z"
        }),
        node({ id: "task", sortKey: 3 })
      ])
    );
    expect(
      resolveOutlineKey(
        input({
          key: "Tab",
          nodeId: "task",
          title: "task",
          workspace: hiddenBetween,
          visibleNodeIds: ["a", "task"]
        })
      )
    ).toEqual({
      type: "move",
      input: { id: "task", parentId: "a", afterId: "a-child" },
      focusNodeId: "task",
      expandNodeId: "a"
    });
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

  it("ignores repeated structural keys while keeping vertical focus navigation responsive", () => {
    expect(resolveOutlineKey(input({ key: "Enter", repeat: true }))).toBeNull();
    expect(
      resolveOutlineKey(
        input({ key: "Tab", nodeId: "child-b", title: "child-b", repeat: true })
      )
    ).toBeNull();
    expect(
      resolveOutlineKey(
        input({
          key: "Tab",
          shiftKey: true,
          nodeId: "grandchild",
          title: "grandchild",
          repeat: true
        })
      )
    ).toBeNull();
    expect(
      resolveOutlineKey(
        input({ key: "ArrowLeft", selectionStart: 0, selectionEnd: 0, repeat: true })
      )
    ).toBeNull();
    expect(
      resolveOutlineKey(
        input({
          key: "ArrowRight",
          nodeId: "root-c",
          title: "root-c",
          selectionStart: 6,
          selectionEnd: 6,
          repeat: true
        })
      )
    ).toBeNull();
    expect(
      resolveOutlineKey(
        input({ key: "ArrowDown", nodeId: "root-a", repeat: true })
      )
    ).toEqual({ type: "focus", nodeId: "child-a" });
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
    expect(
      resolveOutlineKey(input({ key: "ArrowDown", ctrlKey: true }))
    ).toBeNull();
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

describe("resolveNotesHistoryShortcut", () => {
  it.each([
    ["Cmd+Z", { key: "z", metaKey: true, platform: "mac" }, "undo"],
    ["Ctrl+Z", { key: "Z", ctrlKey: true, platform: "other" }, "undo"],
    [
      "Cmd+Shift+Z",
      { key: "z", metaKey: true, shiftKey: true, platform: "mac" },
      "redo"
    ],
    [
      "Ctrl+Shift+Z",
      { key: "Z", ctrlKey: true, shiftKey: true, platform: "other" },
      "redo"
    ],
    ["Ctrl+Y", { key: "y", ctrlKey: true, platform: "other" }, "redo"]
  ] as const)("resolves %s", (_label, overrides, expected) => {
    expect(
      resolveNotesHistoryShortcut(historyShortcutInput(overrides))
    ).toBe(expected);
  });

  it.each([
    { key: "Process", ctrlKey: true },
    { key: "z", ctrlKey: true, isComposing: true },
    { key: "y", metaKey: true, platform: "mac" },
    { key: "y", ctrlKey: true, platform: "mac" },
    { key: "z", ctrlKey: true, metaKey: true },
    { key: "z", ctrlKey: true, altKey: true }
  ])("ignores unsupported or composing input %#", (overrides) => {
    expect(
      resolveNotesHistoryShortcut(
        historyShortcutInput(
          overrides as Partial<ResolveNotesHistoryShortcutInput>
        )
      )
    ).toBeNull();
  });
});
