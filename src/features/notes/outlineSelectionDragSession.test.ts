import { describe, expect, it } from "vitest";
import type { NoteId, NoteNode, NotesWorkspace } from "../../domain/notes";
import { OUTLINE_INDENT_PX, type OutlineSiblingOrder } from "./outlineDrag";
import {
  projectOutlineSelectionDragSession,
  startOutlineSelectionDragSession
} from "./outlineSelectionDragSession";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import { flattenVisibleOutlineRows } from "./outlineTree";

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
    createdAt: "2026-07-15T00:00:00Z",
    updatedAt: "2026-07-15T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    ...overrides
  };
}

function dragFixture(nodes: readonly NoteNode[]) {
  const workspace = normalizeWorkspace({
    nodes: [...nodes]
  } satisfies NotesWorkspace);
  return {
    rows: flattenVisibleOutlineRows(workspace, null),
    order: {
      rootIds: workspace.rootIds,
      childIdsByParent: workspace.childIdsByParent,
      zoomRootId: null
    } satisfies OutlineSiblingOrder
  };
}

describe("outline selection drag session", () => {
  it("takes the selected path for a one-row materialized range", () => {
    const fixture = dragFixture([
      node({ id: "target", sortKey: 1 }),
      node({ id: "active", sortKey: 2 })
    ]);
    const context = { selectionRevision: 7 };

    const session = startOutlineSelectionDragSession({
      activeId: "active",
      selectedNodeIds: ["active"],
      ...fixture,
      frozenContext: context
    });

    expect(session.kind).toBe("selected-ready");
    if (session.kind !== "selected-ready") {
      throw new Error("Expected one selected row to start a selected drag.");
    }
    expect(
      projectOutlineSelectionDragSession(session, "target", 0)
    ).toEqual({
      kind: "selected-move",
      target: { parentId: null, afterId: null, beforeId: "target" },
      frozenContext: context
    });
  });

  it("keeps preparation or authority mismatches on an explicit no-move path", () => {
    const fixture = dragFixture([
      node({ id: "active", sortKey: 1 }),
      node({ id: "target", sortKey: 2 })
    ]);
    const session = startOutlineSelectionDragSession({
      activeId: "active",
      selectedNodeIds: ["active"],
      rows: fixture.rows,
      order: {
        ...fixture.order,
        rootIds: ["target"]
      },
      frozenContext: { selectionRevision: 8 }
    });

    expect(session).toEqual({
      kind: "selected-invalid",
      reason: "invalid-geometry"
    });
    if (session.kind === "ordinary") {
      throw new Error("A selected row must never fall back to an ordinary drag.");
    }
    expect(
      projectOutlineSelectionDragSession(session, "target", 0)
    ).toEqual({ kind: "selected-invalid", reason: "invalid-geometry" });
  });

  it("rejects a destination anywhere inside the selected subtree", () => {
    const fixture = dragFixture([
      node({ id: "selected", sortKey: 1 }),
      node({ id: "selected-child", parentId: "selected" }),
      node({ id: "tail", sortKey: 2 })
    ]);
    const session = startOutlineSelectionDragSession({
      activeId: "selected",
      selectedNodeIds: ["selected"],
      ...fixture,
      frozenContext: { selectionRevision: 9 }
    });

    expect(session.kind).toBe("selected-ready");
    if (session.kind !== "selected-ready") {
      throw new Error("Expected a ready selected drag.");
    }
    expect(
      projectOutlineSelectionDragSession(session, "selected-child", 0)
    ).toEqual({
      kind: "selected-invalid",
      reason: "selected-forest-target"
    });
  });

  it("returns a router-ready target and expansion for a collapsed parent", () => {
    const fixture = dragFixture([
      node({ id: "active", sortKey: 1 }),
      node({ id: "parent", sortKey: 2, isCollapsed: true }),
      node({ id: "hidden", parentId: "parent" }),
      node({ id: "tail", sortKey: 3 })
    ]);
    const frozenContext = { selectionRevision: 10 };
    const session = startOutlineSelectionDragSession({
      activeId: "active",
      selectedNodeIds: ["active"],
      ...fixture,
      frozenContext
    });

    expect(session.kind).toBe("selected-ready");
    if (session.kind !== "selected-ready") {
      throw new Error("Expected a ready selected drag.");
    }
    const result = projectOutlineSelectionDragSession(
      session,
      "parent",
      OUTLINE_INDENT_PX
    );

    expect(result).toEqual({
      kind: "selected-move",
      target: { parentId: "parent", afterId: "hidden" },
      expandNodeId: "parent",
      frozenContext
    });
    expect(Object.keys(result).sort()).toEqual([
      "expandNodeId",
      "frozenContext",
      "kind",
      "target"
    ]);
  });

  it("freezes source ordering and opaque context at drag start", () => {
    const fixture = dragFixture([
      node({ id: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 }),
      node({ id: "target", sortKey: 3 })
    ]);
    const selectedNodeIds: NoteId[] = ["second", "first"];
    const frozenContext = { selectionRevision: 11 };
    const input = {
      activeId: "second" as NoteId,
      selectedNodeIds,
      ...fixture,
      frozenContext
    };
    const session = startOutlineSelectionDragSession(input);

    selectedNodeIds.splice(0, selectedNodeIds.length, "target");
    input.frozenContext = { selectionRevision: 99 };

    expect(session.kind).toBe("selected-ready");
    if (session.kind !== "selected-ready") {
      throw new Error("Expected a ready selected drag.");
    }
    expect(session.prepared.nodeIds).toEqual(["first", "second"]);
    expect(Object.isFrozen(session.prepared.nodeIds)).toBe(true);
    expect(Object.isFrozen(session.frozenContext)).toBe(true);
    expect(
      projectOutlineSelectionDragSession(session, "target", 0)
    ).toEqual({
      kind: "selected-move",
      target: { parentId: null, afterId: "target" },
      frozenContext
    });
  });

  it("marks an active row outside the materialized range as ordinary", () => {
    const fixture = dragFixture([
      node({ id: "selected", sortKey: 1 }),
      node({ id: "active", sortKey: 2 })
    ]);

    expect(
      startOutlineSelectionDragSession({
        activeId: "active",
        selectedNodeIds: ["selected"],
        ...fixture,
        frozenContext: { selectionRevision: 12 }
      })
    ).toEqual({ kind: "ordinary", activeId: "active" });
  });
});
