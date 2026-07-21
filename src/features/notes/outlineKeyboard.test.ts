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
    nodeKind: "text",
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
    imageOffsetUtf16: 0,
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
  const workspace = overrides.workspace ?? tree;
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
    workspace,
    authoritativeWorkspace: workspace,
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
    isComposing: false,
    repeat: false,
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

  it("moves or creates from supporting-note Shift+Enter only once outside IME", () => {
    expect(
      resolveSupportingNoteKey(
        supportingNoteInput({ key: "Enter", shiftKey: true })
      )
    ).toBe("nextTitleOrCreate");
    expect(
      resolveSupportingNoteKey(
        supportingNoteInput({
          key: "Enter",
          shiftKey: true,
          isComposing: true
        })
      )
    ).toBeNull();
    expect(
      resolveSupportingNoteKey(
        supportingNoteInput({ key: "Enter", shiftKey: true, repeat: true })
      )
    ).toBeNull();
    expect(
      resolveSupportingNoteKey(supportingNoteInput({ key: "Enter" }))
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
    expect(
      supportingNoteFocusTarget("nextTitleOrCreate", "b", ["a", "b", "c"])
    ).toBe("c");
    expect(
      supportingNoteFocusTarget("nextTitleOrCreate", "c", ["a", "b", "c"])
    ).toBe("c");
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

  it("resolves image primary-content Enter without splitting the hidden filename", () => {
    expect(
      resolveOutlineKey(
        input({
          target: "image",
          key: "Enter",
          nodeId: "child-b",
          title: "diagram.png",
          selectionStart: null,
          selectionEnd: null
        })
      )
    ).toEqual({ type: "createNextTextSibling" });
  });

  it("opens an image description with Shift+Enter", () => {
    expect(
      resolveOutlineKey(
        input({
          target: "image",
          key: "Enter",
          shiftKey: true,
          nodeId: "child-b",
          title: "diagram.png",
          selectionStart: null,
          selectionEnd: null
        })
      )
    ).toEqual({ type: "focusNote" });
  });

  it("keeps image Tab and Shift+Tab on the existing move resolutions", () => {
    expect(
      resolveOutlineKey(
        input({
          target: "image",
          key: "Tab",
          nodeId: "child-b",
          title: "diagram.png",
          selectionStart: null,
          selectionEnd: null
        })
      )
    ).toEqual({
      type: "move",
      input: { id: "child-b", parentId: "child-a", afterId: "grandchild" },
      focusNodeId: "child-b"
    });
    expect(
      resolveOutlineKey(
        input({
          target: "image",
          key: "Tab",
          shiftKey: true,
          nodeId: "grandchild",
          title: "diagram.png",
          selectionStart: null,
          selectionEnd: null
        })
      )
    ).toEqual({
      type: "move",
      input: { id: "grandchild", parentId: "root-a", afterId: "child-a" },
      focusNodeId: "grandchild"
    });
  });

  it("provides image-only Alt+Arrow structural shortcuts while Tab enters controls", () => {
    expect(
      resolveOutlineKey(
        input({
          target: "image",
          key: "ArrowRight",
          altKey: true,
          nodeId: "child-b",
          title: "diagram.png",
          selectionStart: null,
          selectionEnd: null
        })
      )
    ).toEqual({
      type: "move",
      input: { id: "child-b", parentId: "child-a", afterId: "grandchild" },
      focusNodeId: "child-b"
    });
    expect(
      resolveOutlineKey(
        input({
          target: "image",
          key: "ArrowLeft",
          altKey: true,
          nodeId: "grandchild",
          title: "diagram.png",
          selectionStart: null,
          selectionEnd: null
        })
      )
    ).toEqual({
      type: "move",
      input: { id: "grandchild", parentId: "root-a", afterId: "child-a" },
      focusNodeId: "grandchild"
    });
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

  it("consumes Tab when a first sibling cannot indent", () => {
    expect(
      resolveOutlineKey(
        input({ key: "Tab", nodeId: "child-a", title: "child-a" })
      )
    ).toEqual({ type: "consumeTabShortcut" });
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

  it("outdents immediately after the former parent and consumes roots", () => {
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
    ).toEqual({ type: "consumeTabShortcut" });
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
    ).toEqual({ type: "consumeTabShortcut" });
  });

  it("consumes Tab and Shift+Tab on the zoom root itself", () => {
    const zoomedAtChildA = { ...tree, zoomRootId: "child-a" };
    expect(
      resolveOutlineKey(
        input({
          key: "Tab",
          nodeId: "child-a",
          title: "child-a",
          workspace: zoomedAtChildA
        })
      )
    ).toEqual({ type: "consumeTabShortcut" });
    expect(
      resolveOutlineKey(
        input({
          key: "Tab",
          shiftKey: true,
          nodeId: "child-a",
          title: "child-a",
          workspace: zoomedAtChildA
        })
      )
    ).toEqual({ type: "consumeTabShortcut" });
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

  it("consumes Tab when the only prior sibling is hidden", () => {
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
    ).toEqual({ type: "consumeTabShortcut" });
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
    ).toEqual({ type: "consumeTabShortcut" });
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
    ).toEqual({ type: "consumeTabShortcut" });
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

  it("moves Left at the title start to the end of the previous visible bullet", () => {
    expect(
      resolveOutlineKey(
        input({
          key: "ArrowLeft",
          nodeId: "root-a",
          selectionStart: 0,
          selectionEnd: 0
        })
      )
    ).toBeNull();
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
    ).toEqual({
      type: "focus",
      nodeId: "grandchild",
      selection: {
        anchorUtf16: Number.MAX_SAFE_INTEGER,
        focusUtf16: Number.MAX_SAFE_INTEGER
      }
    });
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

  it("moves Right at the title end to the start of the next visible bullet", () => {
    expect(
      resolveOutlineKey(
        input({
          key: "ArrowRight",
          nodeId: "child-b",
          title: "child-b",
          selectionStart: 7,
          selectionEnd: 7
        })
      )
    ).toEqual({
      type: "focus",
      nodeId: "root-b",
      selection: { anchorUtf16: 0, focusUtf16: 0 }
    });
    expect(
      resolveOutlineKey(
        input({
          key: "ArrowRight",
          nodeId: "root-a",
          selectionStart: 10,
          selectionEnd: 10
        })
      )
    ).toEqual({
      type: "focus",
      nodeId: "child-a",
      selection: { anchorUtf16: 0, focusUtf16: 0 }
    });
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
          nodeId: "with-att",
          title: "",
          note: "context",
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

  it("requests confirmation for a note-only row at the title start", () => {
    expect(
      resolveOutlineKey(
        input({
          key: "Backspace",
          title: " \t",
          note: "context",
          selectionStart: 0,
          selectionEnd: 0
        })
      )
    ).toEqual({ type: "confirmDelete" });
  });

  it("keeps note-only Backspace native away from a plain start caret", () => {
    expect(
      resolveOutlineKey(
        input({
          key: "Backspace",
          title: "",
          note: "context",
          repeat: true
        })
      )
    ).toBeNull();
    expect(
      resolveOutlineKey(
        input({
          key: "Backspace",
          title: "",
          note: "context",
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

  it("consumes Shift+ArrowUp at the first selection-only visible row", () => {
    expect(
      resolveOutlineKey(
        input({
          key: "ArrowUp",
          shiftKey: true,
          nodeId: "child-a",
          visibleNodeIds: ["root-a", "child-a", "grandchild", "child-b"],
          selectionVisibleNodeIds: ["child-a", "grandchild", "child-b"]
        })
      )
    ).toEqual({ type: "consumeSelectionShortcut" });
  });

  it("keeps structural visible rows for ordinary zoomed caret navigation", () => {
    expect(
      resolveOutlineKey(
        input({
          key: "ArrowUp",
          nodeId: "child-a",
          visibleNodeIds: ["root-a", "child-a", "grandchild", "child-b"],
          selectionVisibleNodeIds: ["child-a", "grandchild", "child-b"]
        })
      )
    ).toEqual({ type: "focus", nodeId: "root-a" });
  });

  it("does not extend when the live selection head is outside selection rows", () => {
    expect(
      resolveOutlineKey(
        input({
          key: "ArrowDown",
          shiftKey: true,
          nodeId: "child-a",
          visibleNodeIds: ["root-a", "child-a", "grandchild", "child-b"],
          selectionVisibleNodeIds: ["child-a", "grandchild", "child-b"],
          selection: { anchorId: "child-a", headId: "root-a" }
        })
      )
    ).toBeNull();
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

  it("consumes Shift+ArrowDown at the last visible row", () => {
    expect(
      resolveOutlineKey(
        input({
          key: "ArrowDown",
          shiftKey: true,
          nodeId: "root-a",
          selection: { anchorId: "root-a", headId: "root-c" }
        })
      )
    ).toEqual({ type: "consumeSelectionShortcut" });
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

describe("resolveOutlineKey semantic selection actions", () => {
  it.each([
    [
      "Ctrl+Enter",
      { key: "Enter", ctrlKey: true, platform: "other" as const },
      "toggleComplete"
    ],
    [
      "Cmd+Enter",
      { key: "Enter", metaKey: true, platform: "mac" as const },
      "toggleComplete"
    ],
    [
      "Ctrl+Shift+Backspace",
      {
        key: "Backspace",
        ctrlKey: true,
        shiftKey: true,
        platform: "other" as const
      },
      "delete"
    ],
    ["Tab", { key: "Tab" }, "indent"],
    ["Shift+Tab", { key: "Tab", shiftKey: true }, "outdent"],
    [
      "Alt+Shift+D",
      {
        key: "D",
        altKey: true,
        shiftKey: true,
        platform: "other" as const
      },
      "duplicate"
    ],
    [
      "Cmd+Shift+D",
      {
        key: "D",
        metaKey: true,
        shiftKey: true,
        platform: "mac" as const
      },
      "duplicate"
    ],
    [
      "Ctrl+Shift+ArrowUp",
      {
        key: "ArrowUp",
        ctrlKey: true,
        shiftKey: true,
        platform: "other" as const
      },
      "moveUp"
    ],
    [
      "Cmd+Shift+ArrowDown",
      {
        key: "ArrowDown",
        metaKey: true,
        shiftKey: true,
        platform: "mac" as const
      },
      "moveDown"
    ]
  ] as const)("routes selected %s as a shared command intent", (
    _label,
    overrides,
    action
  ) => {
    expect(resolveOutlineKey(batchInput(overrides))).toEqual({
      type: "selectionAction",
      action
    });
  });

  it.each([
    ["complete", { key: "Enter", ctrlKey: true }, "toggleComplete"],
    ["delete", { key: "Backspace", ctrlKey: true, shiftKey: true }, "delete"],
    ["indent", { key: "Tab" }, "indent"],
    ["outdent", { key: "Tab", shiftKey: true }, "outdent"],
    ["duplicate", { key: "D", altKey: true, shiftKey: true }, "duplicate"],
    [
      "move",
      { key: "ArrowDown", ctrlKey: true, shiftKey: true },
      "moveDown"
    ]
  ] as const)("owns an ineligible %s chord without computing eligibility", (
    _label,
    overrides,
    action
  ) => {
    expect(
      resolveOutlineKey(
        batchInput({
          ...overrides,
          authoritativeWorkspace: undefined,
          visibleNodeIds: ["c2"],
          selection: { anchorId: "c2", headId: "not-visible" }
        })
      )
    ).toEqual({
      type: "selectionAction",
      action
    });
  });

  it.each([
    ["Ctrl+C", { key: "c", ctrlKey: true, platform: "other" as const }],
    ["Ctrl+X", { key: "x", ctrlKey: true, platform: "other" as const }],
    ["Cmd+C", { key: "c", metaKey: true, platform: "mac" as const }],
    ["Cmd+X", { key: "x", metaKey: true, platform: "mac" as const }]
  ] as const)("leaves selected %s to the native clipboard event", (
    _label,
    overrides
  ) => {
    expect(
      resolveOutlineKey(
        batchInput({
          ...overrides,
          selectionStart: 1,
          selectionEnd: 1
        })
      )
    ).toBeNull();
  });

  it("leaves copy and cut native regardless of textarea selection shape", () => {
    expect(
      resolveOutlineKey(
        batchInput({
          key: "c",
          ctrlKey: true,
          selectionStart: 0,
          selectionEnd: 2
        })
      )
    ).toBeNull();
    expect(
      resolveOutlineKey(
        batchInput({
          key: "x",
          ctrlKey: true,
          selectionStart: null,
          selectionEnd: null
        })
      )
    ).toBeNull();
  });

  it.each([
    ["complete", { key: "Enter", ctrlKey: true }],
    ["delete", { key: "Backspace", ctrlKey: true, shiftKey: true }],
    ["indent", { key: "Tab" }],
    ["outdent", { key: "Tab", shiftKey: true }],
    ["duplicate", { key: "D", altKey: true, shiftKey: true }],
    ["move up", { key: "ArrowUp", ctrlKey: true, shiftKey: true }],
    ["move down", { key: "ArrowDown", ctrlKey: true, shiftKey: true }]
  ])("consumes repeated selected %s commands without executing", (
    _label,
    overrides
  ) => {
    expect(
      resolveOutlineKey(batchInput({ ...overrides, repeat: true }))
    ).toEqual({ type: "consumeSelectionShortcut" });
  });

  it.each([
    ["copy", { key: "c", ctrlKey: true, repeat: true }],
    ["cut", { key: "x", ctrlKey: true, repeat: true }],
    ["IME", { key: "Enter", ctrlKey: true, isComposing: true }],
    ["Process", { key: "Process", ctrlKey: true }]
  ])("does not consume selected %s input", (_label, overrides) => {
    expect(resolveOutlineKey(batchInput(overrides))).toBeNull();
  });

  it("does not let a wrong-platform selected shortcut fall through", () => {
    expect(
      resolveOutlineKey(
        batchInput({ key: "Enter", metaKey: true, platform: "other" })
      )
    ).toBeNull();
    expect(
      resolveOutlineKey(
        batchInput({
          key: "D",
          metaKey: true,
          shiftKey: true,
          platform: "other"
        })
      )
    ).toBeNull();
  });

  it("keeps single-node behavior when there is no selection", () => {
    expect(
      resolveOutlineKey(
        batchInput({ key: "Enter", ctrlKey: true, selection: null })
      )
    ).toEqual({ type: "toggleComplete" });
    expect(resolveOutlineKey(batchInput({ key: "Tab", selection: null }))).toEqual(
      {
        type: "move",
        input: { id: "c2", parentId: "c1", afterId: null },
        focusNodeId: "c2"
      }
    );
  });
});
