import { describe, expect, it } from "vitest";
import type { NoteId, NoteNode, NotesWorkspace } from "../../domain/notes";
import { OUTLINE_INDENT_PX, type OutlineSiblingOrder } from "./outlineDrag";
import {
  projectOutlineSelectionDragSession,
  startOutlineSelectionDragSession
} from "./outlineSelectionDragSession";
import type { NotesSelectionActionSnapshot } from "./notesSelectionActions";
import {
  normalizeWorkspace,
  type NormalizedNotesWorkspace
} from "./notesWorkspaceReducer";
import { flattenVisibleOutlineRows } from "./outlineTree";
import type { NotesPreparedSelectionAuthority } from "./useNotesWorkspace";

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
    createdAt: "2026-07-15T00:00:00Z",
    updatedAt: "2026-07-15T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    imageOffsetUtf16: 0,
    ...overrides
  };
}

function dragFixture(nodes: readonly NoteNode[]) {
  const workspace = normalizeWorkspace({
    nodes: [...nodes]
  } satisfies NotesWorkspace);
  return {
    workspace,
    rows: flattenVisibleOutlineRows(workspace, null),
    order: {
      rootIds: workspace.rootIds,
      childIdsByParent: workspace.childIdsByParent,
      zoomRootId: null
    } satisfies OutlineSiblingOrder
  };
}

function actionSnapshot(
  structuralRootIds: readonly NoteId[]
): NotesSelectionActionSnapshot {
  const frozenIds = Object.freeze([...structuralRootIds]);
  const unavailable = Object.freeze({
    eligible: false as const,
    reason: "Not needed by this drag-session test."
  });
  return Object.freeze({
    selection: Object.freeze({
      anchorId: frozenIds[0],
      headId: frozenIds.at(-1)!
    }),
    selectedNodeIds: frozenIds,
    structuralRootIds: frozenIds,
    completion: "none",
    deleteFocusNodeId: null,
    eligibility: Object.freeze({
      copy: unavailable,
      cut: unavailable,
      delete: unavailable,
      duplicate: unavailable,
      indent: unavailable,
      outdent: unavailable,
      moveUp: unavailable,
      moveDown: unavailable,
      moveTo: unavailable
    })
  });
}

function preparedAuthority(
  workspace: NormalizedNotesWorkspace,
  selectedNodeIds: readonly NoteId[],
  selectionRevision: number
): NotesPreparedSelectionAuthority {
  return Object.freeze({
    token: 1,
    vaultRoot: "/test-vault",
    scope: Object.freeze({ kind: "active" as const }),
    generation: 1,
    session: Object.freeze(
      {}
    ) as NotesPreparedSelectionAuthority["session"],
    selectionRevision,
    selectedNodeIds: Object.freeze([...selectedNodeIds]),
    workspace
  });
}

function dragContext(
  workspace: NormalizedNotesWorkspace,
  structuralRootIds: readonly NoteId[],
  selectionRevision: number,
  overrides: {
    contextNodeIds?: readonly NoteId[];
    authorityNodeIds?: readonly NoteId[];
    snapshotNodeIds?: readonly NoteId[];
  } = {}
) {
  const contextNodeIds = [
    ...(overrides.contextNodeIds ?? structuralRootIds)
  ];
  const authority = preparedAuthority(
    workspace,
    overrides.authorityNodeIds ?? structuralRootIds,
    selectionRevision
  );
  const snapshot = actionSnapshot(
    overrides.snapshotNodeIds ?? structuralRootIds
  );
  const ownership = { actionSnapshot: snapshot, authority };
  const frozenContext = { nodeIds: contextNodeIds, ownership };
  return {
    actionSnapshot: snapshot,
    authority,
    contextNodeIds,
    frozenContext,
    ownership
  };
}

describe("outline selection drag session", () => {
  it("takes the selected path for a one-row materialized range", () => {
    const fixture = dragFixture([
      node({ id: "target", sortKey: 1 }),
      node({ id: "active", sortKey: 2 })
    ]);
    const context = dragContext(fixture.workspace, ["active"], 7).frozenContext;

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

  it("binds a materialized ancestor range to its normalized structural roots", () => {
    const fixture = dragFixture([
      node({ id: "parent", sortKey: 1 }),
      node({ id: "active-child", parentId: "parent" }),
      node({ id: "target", sortKey: 2 })
    ]);
    const context = dragContext(fixture.workspace, ["parent"], 7)
      .frozenContext;

    const session = startOutlineSelectionDragSession({
      activeId: "active-child",
      selectedNodeIds: ["parent", "active-child"],
      ...fixture,
      frozenContext: context
    });

    expect(session.kind).toBe("selected-ready");
    if (session.kind !== "selected-ready") {
      throw new Error("Expected normalized structural-root ownership.");
    }
    expect(session.prepared.nodeIds).toEqual(["parent"]);
    expect(session.frozenContext.nodeIds).toEqual(["parent"]);
    expect(
      projectOutlineSelectionDragSession(session, "target", 0)
    ).toEqual({
      kind: "selected-move",
      target: { parentId: null, afterId: "target" },
      frozenContext: session.frozenContext
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
      frozenContext: dragContext(fixture.workspace, ["active"], 8).frozenContext
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

  it.each([
    {
      name: "frozen context node order",
      overrides: { contextNodeIds: ["second", "first"] }
    },
    {
      name: "prepared authority node order",
      overrides: { authorityNodeIds: ["second", "first"] }
    },
    {
      name: "action snapshot structural-root order",
      overrides: { snapshotNodeIds: ["second", "first"] }
    }
  ])("rejects a mismatched $name", ({ overrides }) => {
    const fixture = dragFixture([
      node({ id: "first", sortKey: 1 }),
      node({ id: "second", sortKey: 2 }),
      node({ id: "target", sortKey: 3 })
    ]);
    const session = startOutlineSelectionDragSession({
      activeId: "second",
      selectedNodeIds: ["second", "first"],
      ...fixture,
      frozenContext: dragContext(
        fixture.workspace,
        ["first", "second"],
        8,
        overrides
      ).frozenContext
    });

    expect(session).toEqual({
      kind: "selected-invalid",
      reason: "selection-authority-mismatch"
    });
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
      frozenContext: dragContext(fixture.workspace, ["selected"], 9)
        .frozenContext
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
    const frozenContext = dragContext(fixture.workspace, ["active"], 10)
      .frozenContext;
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
    const contextFixture = dragContext(
      fixture.workspace,
      ["first", "second"],
      11
    );
    const { frozenContext } = contextFixture;
    const input = {
      activeId: "second" as NoteId,
      selectedNodeIds,
      ...fixture,
      frozenContext
    };
    const session = startOutlineSelectionDragSession(input);

    expect(Object.isFrozen(frozenContext)).toBe(false);
    expect(Object.isFrozen(contextFixture.contextNodeIds)).toBe(false);
    expect(Object.isFrozen(contextFixture.ownership)).toBe(false);
    selectedNodeIds.splice(0, selectedNodeIds.length, "target");
    const replacement = dragContext(fixture.workspace, ["target"], 99);
    contextFixture.contextNodeIds.splice(
      0,
      contextFixture.contextNodeIds.length,
      "target"
    );
    contextFixture.ownership.actionSnapshot = replacement.actionSnapshot;
    contextFixture.ownership.authority = replacement.authority;
    input.frozenContext = replacement.frozenContext;

    expect(session.kind).toBe("selected-ready");
    if (session.kind !== "selected-ready") {
      throw new Error("Expected a ready selected drag.");
    }
    expect(session.prepared.nodeIds).toEqual(["first", "second"]);
    expect(Object.isFrozen(session.prepared.nodeIds)).toBe(true);
    expect(Object.isFrozen(session.frozenContext)).toBe(true);
    expect(session.frozenContext).not.toBe(frozenContext);
    expect(session.frozenContext.nodeIds).toEqual(["first", "second"]);
    expect(session.frozenContext.nodeIds).not.toBe(
      contextFixture.contextNodeIds
    );
    expect(Object.isFrozen(session.frozenContext.nodeIds)).toBe(true);
    expect(session.frozenContext.ownership).not.toBe(contextFixture.ownership);
    expect(Object.isFrozen(session.frozenContext.ownership)).toBe(true);
    expect(session.frozenContext.ownership.actionSnapshot).toBe(
      contextFixture.actionSnapshot
    );
    expect(session.frozenContext.ownership.authority).toBe(
      contextFixture.authority
    );
    expect(
      projectOutlineSelectionDragSession(session, "target", 0)
    ).toEqual({
      kind: "selected-move",
      target: { parentId: null, afterId: "target" },
      frozenContext: session.frozenContext
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
        frozenContext: dragContext(fixture.workspace, ["selected"], 12)
          .frozenContext
      })
    ).toEqual({ kind: "ordinary", activeId: "active" });
  });
});
