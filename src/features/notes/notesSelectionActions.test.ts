import { describe, expect, it } from "vitest";
import type {
  NoteAttachment,
  NoteId,
  NoteNode,
  NotesWorkspace
} from "../../domain/notes";
import {
  deriveNotesSelectionActionSnapshot,
  type NotesSelectionActionSnapshot
} from "./notesSelectionActions";
import {
  normalizeWorkspace,
  type NotesSelection
} from "./notesWorkspaceReducer";

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

function attachment(nodeId: NoteId, id = `attachment-${nodeId}`): NoteAttachment {
  return {
    id,
    nodeId,
    sortKey: 1024,
    relativePath: `assets/${id}.png`,
    contentHash: id,
    originalName: `${id}.png`,
    mimeType: "image/png",
    byteSize: 1,
    intrinsicWidth: 1,
    intrinsicHeight: 1,
    displayWidth: 160,
    createdAt: "2026-07-10T00:00:00Z",
    updatedAt: "2026-07-10T00:00:00Z"
  };
}

function snapshot(
  nodes: NoteNode[],
  visibleNodeIds: readonly NoteId[],
  selection: NotesSelection,
  attachmentsByNodeId: NotesWorkspace["attachmentsByNodeId"] = {}
): NotesSelectionActionSnapshot | null {
  return deriveNotesSelectionActionSnapshot({
    selection,
    visibleNodeIds,
    workspace: normalizeWorkspace({ nodes, attachmentsByNodeId })
  });
}

describe("deriveNotesSelectionActionSnapshot", () => {
  const flatNodes = [
    node({ id: "a", sortKey: 1 }),
    node({ id: "b", sortKey: 2 }),
    node({ id: "c", sortKey: 3 })
  ];

  it.each([
    {
      label: "forward",
      selection: { anchorId: "a", headId: "c" }
    },
    {
      label: "reverse",
      selection: { anchorId: "c", headId: "a" }
    }
  ])("freezes a stable outline-ordered $label range", ({ selection }) => {
    const visibleNodeIds = ["a", "b", "c"];
    const originalSelection = { ...selection };
    const result = snapshot(flatNodes, visibleNodeIds, selection);

    expect(result?.selectedNodeIds).toEqual(["a", "b", "c"]);
    expect(result?.structuralRootIds).toEqual(["a", "b", "c"]);
    expect(result?.selection).toEqual(originalSelection);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.selection)).toBe(true);
    expect(Object.isFrozen(result?.selectedNodeIds)).toBe(true);
    expect(Object.isFrozen(result?.structuralRootIds)).toBe(true);

    visibleNodeIds.reverse();
    selection.anchorId = "b";
    expect(result?.selectedNodeIds).toEqual(["a", "b", "c"]);
    expect(result?.selection).toEqual(originalSelection);
  });

  it.each([
    ["missing anchor", { anchorId: "missing", headId: "b" }],
    ["missing head", { anchorId: "a", headId: "missing" }]
  ])("rejects a %s", (_label, selection) => {
    expect(snapshot(flatNodes, ["a", "b", "c"], selection)).toBeNull();
  });

  it("rejects a visible range containing a node absent from confirmed state", () => {
    expect(
      snapshot(flatNodes, ["a", "vanished", "c"], {
        anchorId: "a",
        headId: "c"
      })
    ).toBeNull();
  });

  it("suppresses selected descendants while retaining every explicit row id", () => {
    const nodes = [
      node({ id: "parent", sortKey: 1 }),
      node({ id: "child", parentId: "parent", sortKey: 1 }),
      node({ id: "grandchild", parentId: "child", sortKey: 1 }),
      node({ id: "sibling", sortKey: 2 })
    ];

    const result = snapshot(
      nodes,
      ["parent", "child", "grandchild", "sibling"],
      { anchorId: "parent", headId: "grandchild" }
    );

    expect(result?.selectedNodeIds).toEqual([
      "parent",
      "child",
      "grandchild"
    ]);
    expect(result?.structuralRootIds).toEqual(["parent"]);
  });

  it("includes collapsed descendants when checking whether Cut is lossless", () => {
    const nodes = [
      node({ id: "collapsed", sortKey: 1, isCollapsed: true }),
      node({
        id: "hidden-rich-child",
        parentId: "collapsed",
        sortKey: 1,
        note: "Hidden supporting note"
      }),
      node({ id: "next", sortKey: 2 })
    ];

    const result = snapshot(nodes, ["collapsed", "next"], {
      anchorId: "collapsed",
      headId: "collapsed"
    });

    expect(result?.selectedNodeIds).toEqual(["collapsed"]);
    expect(result?.structuralRootIds).toEqual(["collapsed"]);
    expect(result?.eligibility.cut).toEqual({
      eligible: false,
      reason:
        "Cut is unavailable because the selected subtrees contain supporting notes. Use Move To to preserve rich content."
    });
  });

  it.each([
    ["none", [null, null, null]],
    ["mixed", [null, "2026-07-10T00:00:00Z", null]],
    [
      "all",
      [
        "2026-07-10T00:00:00Z",
        "2026-07-10T00:00:00Z",
        "2026-07-10T00:00:00Z"
      ]
    ]
  ] as const)("derives the %s completion aggregate", (expected, completedAt) => {
    const nodes = flatNodes.map((current, index) =>
      node({ ...current, completedAt: completedAt[index] })
    );

    expect(
      snapshot(nodes, ["a", "b", "c"], {
        anchorId: "a",
        headId: "c"
      })?.completion
    ).toBe(expected);
  });

  it("chooses the next surviving row after a deleted subtree", () => {
    const nodes = [
      node({ id: "parent", sortKey: 1 }),
      node({ id: "child", parentId: "parent", sortKey: 1 }),
      node({ id: "grandchild", parentId: "child", sortKey: 1 }),
      node({ id: "next", sortKey: 2 })
    ];

    expect(
      snapshot(nodes, ["parent", "child", "grandchild", "next"], {
        anchorId: "parent",
        headId: "parent"
      })?.deleteFocusNodeId
    ).toBe("next");
  });

  it("falls back to the previous survivor after a deleted subtree", () => {
    const nodes = [
      node({ id: "previous", sortKey: 1 }),
      node({ id: "parent", sortKey: 2 }),
      node({ id: "child", parentId: "parent", sortKey: 1 })
    ];

    expect(
      snapshot(nodes, ["previous", "parent", "child"], {
        anchorId: "parent",
        headId: "parent"
      })?.deleteFocusNodeId
    ).toBe("previous");
  });

  it.each([
    {
      label: "a supporting note",
      nodes: [node({ id: "rich", note: "note" })],
      attachments: {} as NonNullable<NotesWorkspace["attachmentsByNodeId"]>,
      reason: "supporting notes"
    },
    {
      label: "an attachment",
      nodes: [node({ id: "rich" })],
      attachments: { rich: [attachment("rich")] },
      reason: "attachments"
    },
    {
      label: "an embedded title newline",
      nodes: [node({ id: "rich", title: "one\ntwo" })],
      attachments: {} as NonNullable<NotesWorkspace["attachmentsByNodeId"]>,
      reason: "embedded title newlines"
    }
  ])("rejects Cut when a selected subtree contains $label", ({
    nodes,
    attachments,
    reason
  }) => {
    const result = snapshot(
      nodes,
      ["rich"],
      { anchorId: "rich", headId: "rich" },
      attachments
    );

    const cut = result?.eligibility.cut;
    expect(cut?.eligible).toBe(false);
    if (!cut || cut.eligible) {
      throw new Error("Expected Cut to be ineligible");
    }
    expect(cut.reason).toContain(reason);
  });

  it("allows Cut for a title-only selected forest", () => {
    expect(
      snapshot(flatNodes, ["a", "b"], {
        anchorId: "a",
        headId: "b"
      })?.eligibility.cut
    ).toEqual({ eligible: true });
  });

  it("disables Duplicate and reorder for mixed-parent structural roots", () => {
    const nodes = [
      node({ id: "left", sortKey: 1 }),
      node({ id: "left-child", parentId: "left", sortKey: 1 }),
      node({ id: "right", sortKey: 2 })
    ];
    const result = snapshot(nodes, ["left", "left-child", "right"], {
      anchorId: "left-child",
      headId: "right"
    });

    expect(result?.structuralRootIds).toEqual(["left-child", "right"]);
    expect(result?.eligibility.duplicate).toEqual({
      eligible: false,
      reason: "Duplicate requires selected roots that share one parent."
    });
    expect(result?.eligibility.moveUp).toEqual({
      eligible: false,
      reason: "Reorder requires selected roots that share one parent."
    });
    expect(result?.eligibility.moveDown).toEqual({
      eligible: false,
      reason: "Reorder requires selected roots that share one parent."
    });
  });

  it("allows same-parent Duplicate but rejects reorder across a stored gap", () => {
    const nodes = [
      node({ id: "parent" }),
      node({ id: "a", parentId: "parent", sortKey: 1 }),
      node({ id: "b", parentId: "parent", sortKey: 2 }),
      node({ id: "hidden", parentId: "parent", sortKey: 3 }),
      node({ id: "d", parentId: "parent", sortKey: 4 })
    ];
    const result = snapshot(nodes, ["a", "b", "d"], {
      anchorId: "b",
      headId: "d"
    });

    expect(result?.structuralRootIds).toEqual(["b", "d"]);
    expect(result?.eligibility.duplicate).toEqual({ eligible: true });
    expect(result?.eligibility.moveUp).toEqual({
      eligible: false,
      reason: "Reorder requires contiguous selected siblings."
    });
    expect(result?.eligibility.moveDown).toEqual({
      eligible: false,
      reason: "Reorder requires contiguous selected siblings."
    });
  });

  it("resolves one-step reorder targets across exactly one sibling", () => {
    const nodes = [
      node({ id: "parent" }),
      node({ id: "a", parentId: "parent", sortKey: 1 }),
      node({ id: "b", parentId: "parent", sortKey: 2 }),
      node({ id: "c", parentId: "parent", sortKey: 3 }),
      node({ id: "d", parentId: "parent", sortKey: 4 })
    ];
    const result = snapshot(nodes, ["a", "b", "c", "d"], {
      anchorId: "c",
      headId: "b"
    });

    expect(result?.structuralRootIds).toEqual(["b", "c"]);
    expect(result?.eligibility.moveUp).toEqual({
      eligible: true,
      target: { parentId: "parent", afterId: null }
    });
    expect(result?.eligibility.moveDown).toEqual({
      eligible: true,
      target: { parentId: "parent", afterId: "d" }
    });
  });

  it.each([
    {
      label: "first boundary",
      selection: { anchorId: "a", headId: "b" },
      direction: "moveUp" as const,
      reason: "The selection is already first among its siblings."
    },
    {
      label: "last boundary",
      selection: { anchorId: "c", headId: "d" },
      direction: "moveDown" as const,
      reason: "The selection is already last among its siblings."
    }
  ])("disables reorder at the $label", ({ selection, direction, reason }) => {
    const nodes = [
      node({ id: "parent" }),
      node({ id: "a", parentId: "parent", sortKey: 1 }),
      node({ id: "b", parentId: "parent", sortKey: 2 }),
      node({ id: "c", parentId: "parent", sortKey: 3 }),
      node({ id: "d", parentId: "parent", sortKey: 4 })
    ];

    expect(
      snapshot(nodes, ["a", "b", "c", "d"], selection)?.eligibility[
        direction
      ]
    ).toEqual({ eligible: false, reason });
  });

  it("exposes explicit indent and outdent reasons", () => {
    const nodes = [
      node({ id: "zoom" }),
      node({ id: "first", parentId: "zoom", sortKey: 1 }),
      node({ id: "second", parentId: "zoom", sortKey: 2 })
    ];
    const workspace = {
      ...normalizeWorkspace({ nodes }),
      zoomRootId: "zoom"
    };
    const result = deriveNotesSelectionActionSnapshot({
      workspace,
      visibleNodeIds: ["first", "second"],
      selection: { anchorId: "first", headId: "first" }
    });

    expect(result?.eligibility.indent).toEqual({
      eligible: false,
      reason: "Indent requires a visible preceding sibling outside the selection."
    });
    expect(result?.eligibility.outdent).toEqual({
      eligible: false,
      reason: "Outdent cannot move the selected roots outside the current zoom."
    });
  });

  it("enables indent and outdent when at least one structural root is eligible", () => {
    const nodes = [
      node({ id: "root" }),
      node({ id: "prior", parentId: "root", sortKey: 1 }),
      node({ id: "selected", parentId: "root", sortKey: 2 })
    ];

    const result = snapshot(nodes, ["root", "prior", "selected"], {
      anchorId: "selected",
      headId: "selected"
    });

    expect(result?.eligibility.indent).toEqual({ eligible: true });
    expect(result?.eligibility.outdent).toEqual({ eligible: true });
  });
});
