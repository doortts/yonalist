import { describe, expect, it } from "vitest";
import type { NoteNode, NotesWorkspace } from "../../domain/notes";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import {
  detectOutlineShortcutPlatform,
  resolveNotesHistoryShortcut,
  resolveOutlineKey,
  resolveSupportingNoteKey,
  supportingNoteFocusTarget,
  type ResolveNotesHistoryShortcutInput,
  type ResolveOutlineKeyInput,
  type ResolveSupportingNoteKeyInput
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

function supportingNoteInput(
  overrides: Partial<ResolveSupportingNoteKeyInput> = {}
): ResolveSupportingNoteKeyInput {
  return {
    key: "Escape",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    selectionStart: 2,
    selectionEnd: 2,
    value: "note",
    ...overrides
  };
}

describe("resolveSupportingNoteKey", () => {
  it("exits to the current title with Escape", () => {
    expect(resolveSupportingNoteKey(supportingNoteInput())).toBe(
      "currentTitle"
    );
  });

  it("uses selections touching vertical boundaries", () => {
    expect(
      resolveSupportingNoteKey(
        supportingNoteInput({
          key: "ArrowUp",
          selectionStart: 0,
          selectionEnd: 3
        })
      )
    ).toBe("currentTitle");
    expect(
      resolveSupportingNoteKey(
        supportingNoteInput({
          key: "ArrowDown",
          selectionStart: 1,
          selectionEnd: 4
        })
      )
    ).toBe("nextTitle");
  });

  it("keeps mid-text and modifier arrows native", () => {
    expect(
      resolveSupportingNoteKey(supportingNoteInput({ key: "ArrowUp" }))
    ).toBeNull();
    expect(
      resolveSupportingNoteKey(
        supportingNoteInput({
          key: "ArrowDown",
          ctrlKey: true,
          selectionEnd: 4
        })
      )
    ).toBeNull();
    expect(
      resolveSupportingNoteKey(
        supportingNoteInput({
          key: "ArrowUp",
          shiftKey: true,
          selectionStart: 0
        })
      )
    ).toBeNull();
  });

  it("resolves the following visible title with current fallback", () => {
    expect(
      supportingNoteFocusTarget("nextTitle", "b", ["a", "b", "c"])
    ).toBe("c");
    expect(
      supportingNoteFocusTarget("nextTitle", "c", ["a", "b", "c"])
    ).toBe("c");
    expect(
      supportingNoteFocusTarget("nextTitle", "missing", ["a", "b", "c"])
    ).toBe("missing");
    expect(
      supportingNoteFocusTarget("currentTitle", "b", ["a", "b", "c"])
    ).toBe("b");
  });
});

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

  it("keeps Backspace native for an empty row that still has image attachments", () => {
    const attachment = {
      id: "att-1",
      nodeId: "with-att",
      sortKey: 1,
      relativePath: "assets/att-1.png",
      contentHash: "hash",
      originalName: "att-1.png",
      mimeType: "image/png" as const,
      byteSize: 10,
      intrinsicWidth: 1,
      intrinsicHeight: 1,
      displayWidth: 1,
      createdAt: "2026-07-10T00:00:00Z",
      updatedAt: "2026-07-10T00:00:00Z"
    };
    const withAttachment = normalizeWorkspace({
      nodes: [
        node({ id: "keep", sortKey: 1, title: "" }),
        node({ id: "with-att", sortKey: 2, title: "" })
      ],
      attachmentsByNodeId: { "with-att": [attachment] }
    });

    expect(
      resolveOutlineKey(
        input({
          key: "Backspace",
          nodeId: "with-att",
          title: "",
          note: "",
          selectionStart: 0,
          selectionEnd: 0,
          workspace: withAttachment
        })
      )
    ).toBeNull();

    expect(
      resolveOutlineKey(
        input({
          key: "Backspace",
          nodeId: "keep",
          title: "",
          note: "",
          selectionStart: 0,
          selectionEnd: 0,
          workspace: withAttachment
        })
      )
    ).toEqual({ type: "remove", focusNodeId: "with-att" });
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
    // Shift+Arrow now extends the selection (see the selection suite); a Shift
    // chord carrying an extra modifier stays unsupported.
    expect(
      resolveOutlineKey(input({ key: "ArrowDown", shiftKey: true, ctrlKey: true }))
    ).toBeNull();
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

// Visible-row order of `tree`: root-a, child-a, grandchild, child-b, root-b,
// root-c (root-c is collapsed so hidden-child is not visible).
describe("resolveOutlineKey selection", () => {
  it("Shift+ArrowDown starts a range at the caret row and moves the head down", () => {
    expect(
      resolveOutlineKey(
        input({ key: "ArrowDown", shiftKey: true, nodeId: "root-a" })
      )
    ).toEqual({ type: "extendSelection", headId: "child-a" });
  });

  it("Shift+ArrowDown extends an existing range from its current head", () => {
    expect(
      resolveOutlineKey(
        input({
          key: "ArrowDown",
          shiftKey: true,
          nodeId: "root-a",
          selection: { anchorId: "root-a", headId: "child-a" }
        })
      )
    ).toEqual({ type: "extendSelection", headId: "grandchild" });
  });

  it("Shift+ArrowUp moves the head up from the current head", () => {
    expect(
      resolveOutlineKey(
        input({
          key: "ArrowUp",
          shiftKey: true,
          nodeId: "child-b",
          selection: { anchorId: "child-b", headId: "child-a" }
        })
      )
    ).toEqual({ type: "extendSelection", headId: "root-a" });
  });

  it("Shift+ArrowDown at the last visible row is a no-op", () => {
    expect(
      resolveOutlineKey(
        input({
          key: "ArrowDown",
          shiftKey: true,
          nodeId: "root-a",
          selection: { anchorId: "root-a", headId: "root-c" }
        })
      )
    ).toBeNull();
  });

  it("ArrowDown without Shift collapses to a caret move (focus), not a range", () => {
    expect(
      resolveOutlineKey(
        input({
          key: "ArrowDown",
          nodeId: "root-a",
          selection: { anchorId: "root-a", headId: "child-b" }
        })
      )
    ).toEqual({ type: "focus", nodeId: "child-a" });
  });

  it("Escape clears an active selection", () => {
    expect(
      resolveOutlineKey(
        input({
          key: "Escape",
          nodeId: "root-a",
          selection: { anchorId: "root-a", headId: "child-b" }
        })
      )
    ).toEqual({ type: "clearSelection" });
  });

  it("Escape with no selection falls through to default handling", () => {
    expect(resolveOutlineKey(input({ key: "Escape", nodeId: "root-a" }))).toBeNull();
  });

  it("ignores Shift+Arrow while composing (IME guard)", () => {
    expect(
      resolveOutlineKey(
        input({ key: "ArrowDown", shiftKey: true, isComposing: true })
      )
    ).toBeNull();
  });

  it("ignores Shift+Arrow when another modifier is held", () => {
    expect(
      resolveOutlineKey(
        input({ key: "ArrowDown", shiftKey: true, metaKey: true })
      )
    ).toBeNull();
  });
});

// A flat sibling tree so a range can span several siblings that share one
// parent — the common batch shape. Visible order: root-a, c1, c2, c3, c4, root-b.
const batchTree = normalizeWorkspace(
  workspace([
    node({ id: "root-a", sortKey: 1 }),
    node({ id: "c1", parentId: "root-a", sortKey: 1 }),
    node({ id: "c2", parentId: "root-a", sortKey: 2 }),
    node({ id: "c3", parentId: "root-a", sortKey: 3 }),
    node({ id: "c4", parentId: "root-a", sortKey: 4 }),
    node({ id: "root-b", sortKey: 2 })
  ])
);
const batchVisibleIds = ["root-a", "c1", "c2", "c3", "c4", "root-b"];

function batchInput(
  overrides: Partial<ResolveOutlineKeyInput> = {}
): ResolveOutlineKeyInput {
  return input({
    workspace: batchTree,
    visibleNodeIds: batchVisibleIds,
    nodeId: "c2",
    title: "c2",
    selection: { anchorId: "c2", headId: "c4" },
    ...overrides
  });
}

describe("resolveOutlineKey batch selection (Phase 4.1c)", () => {
  it("Cmd/Ctrl+Enter completes the whole selection when the focused row is open", () => {
    expect(
      resolveOutlineKey(
        batchInput({ key: "Enter", ctrlKey: true, selectionStart: 2, selectionEnd: 2 })
      )
    ).toEqual({
      type: "batchComplete",
      nodeIds: ["c2", "c3", "c4"],
      completed: true
    });
  });

  it("Cmd/Ctrl+Enter completes a mixed selection even when the focused row is done", () => {
    const withDone = normalizeWorkspace(
      workspace([
        node({ id: "root-a", sortKey: 1 }),
        node({
          id: "c2",
          parentId: "root-a",
          sortKey: 2,
          completedAt: "2026-07-10T00:00:00Z"
        }),
        node({ id: "c3", parentId: "root-a", sortKey: 3 }),
        node({ id: "c4", parentId: "root-a", sortKey: 4 })
      ])
    );
    expect(
      resolveOutlineKey(
        batchInput({
          key: "Enter",
          ctrlKey: true,
          workspace: withDone,
          visibleNodeIds: ["root-a", "c2", "c3", "c4"]
        })
      )
    ).toEqual({
      type: "batchComplete",
      nodeIds: ["c2", "c3", "c4"],
      completed: true
    });
  });

  it("Cmd/Ctrl+Enter uncompletes only when every selected row is done", () => {
    const allDone = normalizeWorkspace(
      workspace([
        node({ id: "root-a", sortKey: 1 }),
        node({
          id: "c2",
          parentId: "root-a",
          sortKey: 2,
          completedAt: "2026-07-10T00:00:00Z"
        }),
        node({
          id: "c3",
          parentId: "root-a",
          sortKey: 3,
          completedAt: "2026-07-10T00:00:00Z"
        }),
        node({
          id: "c4",
          parentId: "root-a",
          sortKey: 4,
          completedAt: "2026-07-10T00:00:00Z"
        })
      ])
    );

    expect(
      resolveOutlineKey(
        batchInput({
          key: "Enter",
          ctrlKey: true,
          workspace: allDone,
          visibleNodeIds: ["root-a", "c2", "c3", "c4"]
        })
      )
    ).toEqual({
      type: "batchComplete",
      nodeIds: ["c2", "c3", "c4"],
      completed: false
    });
  });

  it("Cmd/Ctrl+Shift+Backspace deletes the whole selection and focuses the next row", () => {
    expect(
      resolveOutlineKey(
        batchInput({ key: "Backspace", ctrlKey: true, shiftKey: true })
      )
    ).toEqual({
      type: "batchDelete",
      nodeIds: ["c2", "c3", "c4"],
      focusNodeId: "root-b"
    });
  });

  it("batch delete falls back to the row before the range when nothing follows", () => {
    expect(
      resolveOutlineKey(
        batchInput({
          key: "Backspace",
          ctrlKey: true,
          shiftKey: true,
          nodeId: "root-a",
          selection: { anchorId: "root-a", headId: "root-b" }
        })
      )
    ).toEqual({
      type: "batchDelete",
      nodeIds: ["root-a", "root-b"],
      focusNodeId: null
    });
  });

  it("Tab indents the whole selection under the first non-selected visible sibling", () => {
    expect(
      resolveOutlineKey(batchInput({ key: "Tab" }))
    ).toEqual({ type: "batchIndent", nodeIds: ["c2", "c3", "c4"] });
  });

  it("Tab is a no-op when every child of the parent is selected", () => {
    expect(
      resolveOutlineKey(
        batchInput({
          key: "Tab",
          nodeId: "c1",
          selection: { anchorId: "c1", headId: "c4" }
        })
      )
    ).toBeNull();
  });

  it("Tab refuses to indent the selection under a hidden completed sibling (0.3)", () => {
    const withHiddenDone = normalizeWorkspace(
      workspace([
        node({ id: "a", sortKey: 1 }),
        node({
          id: "done",
          sortKey: 2,
          completedAt: "2026-07-10T00:00:00Z"
        }),
        node({ id: "s1", sortKey: 3 }),
        node({ id: "s2", sortKey: 4 })
      ])
    );
    expect(
      resolveOutlineKey(
        batchInput({
          key: "Tab",
          nodeId: "s1",
          title: "s1",
          workspace: withHiddenDone,
          visibleNodeIds: ["a", "s1", "s2"],
          selection: { anchorId: "s1", headId: "s2" }
        })
      )
    ).toBeNull();
  });

  it("Shift+Tab outdents the whole selection", () => {
    expect(
      resolveOutlineKey(
        batchInput({
          key: "Tab",
          shiftKey: true,
          nodeId: "c1",
          selection: { anchorId: "c1", headId: "c3" }
        })
      )
    ).toEqual({ type: "batchOutdent", nodeIds: ["c1", "c2", "c3"] });
  });

  it("Shift+Tab refuses to outdent the zoom root's direct children out of the zoom (0.3)", () => {
    const zoomed = { ...batchTree, zoomRootId: "root-a" };
    expect(
      resolveOutlineKey(
        batchInput({
          key: "Tab",
          shiftKey: true,
          workspace: zoomed,
          visibleNodeIds: ["c1", "c2", "c3", "c4"],
          nodeId: "c1",
          selection: { anchorId: "c1", headId: "c3" }
        })
      )
    ).toBeNull();
  });

  it.each([
    {
      label: "Alt+Shift+D on other platforms",
      overrides: {
        key: "D",
        altKey: true,
        shiftKey: true,
        platform: "other" as const
      }
    },
    {
      label: "Cmd+Shift+D on macOS",
      overrides: {
        key: "D",
        metaKey: true,
        shiftKey: true,
        platform: "mac" as const
      }
    }
  ])("routes $label to batch duplicate", ({ overrides }) => {
    expect(resolveOutlineKey(batchInput(overrides))).toEqual({
      type: "batchDuplicate",
      nodeIds: ["c2", "c3", "c4"]
    });
  });

  it.each([
    {
      label: "Ctrl+Shift+ArrowUp",
      overrides: {
        key: "ArrowUp",
        ctrlKey: true,
        shiftKey: true,
        platform: "other" as const
      },
      target: { parentId: "root-a", afterId: null }
    },
    {
      label: "Cmd+Shift+ArrowDown",
      overrides: {
        key: "ArrowDown",
        metaKey: true,
        shiftKey: true,
        platform: "mac" as const
      },
      target: { parentId: "root-a", afterId: "c4" }
    }
  ])("routes $label to an exact one-step batch reorder", ({
    overrides,
    target
  }) => {
    expect(
      resolveOutlineKey(
        batchInput({
          ...overrides,
          selection: { anchorId: "c2", headId: "c3" }
        })
      )
    ).toEqual({
      type: "batchReorder",
      nodeIds: ["c2", "c3"],
      ...target
    });
  });

  it("keeps a reorder shortcut inside the selection branch at a boundary", () => {
    expect(
      resolveOutlineKey(
        batchInput({
          key: "ArrowDown",
          ctrlKey: true,
          shiftKey: true,
          selection: { anchorId: "c3", headId: "c4" }
        })
      )
    ).toBeNull();
  });

  it.each([
    {
      label: "Ctrl+C",
      key: "c",
      type: "selectionCopy",
      modifiers: { ctrlKey: true, platform: "other" as const }
    },
    {
      label: "Cmd+C",
      key: "c",
      type: "selectionCopy",
      modifiers: { metaKey: true, platform: "mac" as const }
    },
    {
      label: "Ctrl+X",
      key: "x",
      type: "selectionCut",
      modifiers: { ctrlKey: true, platform: "other" as const }
    },
    {
      label: "Cmd+X",
      key: "x",
      type: "selectionCut",
      modifiers: { metaKey: true, platform: "mac" as const }
    }
  ] as const)("routes selection $label when the native text selection is collapsed", ({
    key,
    type,
    modifiers
  }) => {
    expect(
      resolveOutlineKey(
        batchInput({
          key,
          ...modifiers,
          selectionStart: 1,
          selectionEnd: 1
        })
      )
    ).toEqual({ type, nodeIds: ["c2", "c3", "c4"] });
  });

  it.each(["c", "x"])(
    "leaves Ctrl+%s native when the title has a non-collapsed text selection",
    (key) => {
      expect(
        resolveOutlineKey(
          batchInput({
            key,
            ctrlKey: true,
            selectionStart: 0,
            selectionEnd: 2
          })
        )
      ).toBeNull();
    }
  );

  it("allows Copy but rejects lossy Cut for a rich selected subtree", () => {
    const rich = normalizeWorkspace(
      workspace([
        node({ id: "root-a", sortKey: 1 }),
        node({ id: "c2", parentId: "root-a", sortKey: 2, note: "rich" }),
        node({ id: "c3", parentId: "root-a", sortKey: 3 })
      ])
    );
    const shared = {
      workspace: rich,
      visibleNodeIds: ["root-a", "c2", "c3"],
      selection: { anchorId: "c2", headId: "c3" },
      ctrlKey: true,
      selectionStart: 0,
      selectionEnd: 0
    };

    expect(resolveOutlineKey(batchInput({ ...shared, key: "c" }))).toEqual({
      type: "selectionCopy",
      nodeIds: ["c2", "c3"]
    });
    expect(resolveOutlineKey(batchInput({ ...shared, key: "x" }))).toBeNull();
  });

  it.each([
    ["duplicate repeat", { key: "D", altKey: true, shiftKey: true, repeat: true }],
    [
      "reorder repeat",
      { key: "ArrowUp", ctrlKey: true, shiftKey: true, repeat: true }
    ],
    ["copy repeat", { key: "c", ctrlKey: true, repeat: true }],
    ["cut IME", { key: "x", ctrlKey: true, isComposing: true }]
  ])("suppresses selection $label", (_label, overrides) => {
    expect(resolveOutlineKey(batchInput(overrides))).toBeNull();
  });

  it("routes selected descendants through their stable structural root", () => {
    expect(
      resolveOutlineKey(
        input({
          key: "D",
          altKey: true,
          shiftKey: true,
          workspace: tree,
          visibleNodeIds: [
            "root-a",
            "child-a",
            "grandchild",
            "child-b",
            "root-b",
            "root-c"
          ],
          nodeId: "root-a",
          selection: { anchorId: "root-a", headId: "grandchild" }
        })
      )
    ).toEqual({ type: "batchDuplicate", nodeIds: ["root-a"] });
  });

  it("resolves nothing to batch when the range endpoints are not both visible", () => {
    expect(
      resolveOutlineKey(
        batchInput({
          key: "Enter",
          ctrlKey: true,
          selection: { anchorId: "c2", headId: "not-visible" }
        })
      )
    ).toBeNull();
  });

  it("keeps single-node behavior when there is no selection", () => {
    expect(
      resolveOutlineKey(batchInput({ key: "Enter", ctrlKey: true, selection: null }))
    ).toEqual({ type: "toggleComplete" });
    expect(
      resolveOutlineKey(batchInput({ key: "Tab", selection: null }))
    ).toEqual({
      type: "move",
      input: { id: "c2", parentId: "c1", afterId: null },
      focusNodeId: "c2"
    });
  });
});
