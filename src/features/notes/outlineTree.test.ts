import { describe, expect, it } from "vitest";
import type { NoteNode, NotesWorkspace } from "../../domain/notes";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import {
  flattenVisibleOutlineRows,
  parentTrail,
  visibleNodeIds
} from "./outlineTree";

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

describe("outlineTree", () => {
  it("walks roots and descendants in deterministic sibling order", () => {
    const state = normalizeWorkspace(
      workspace([
        node({ id: "root-b", sortKey: 20 }),
        node({ id: "child-b", parentId: "root-a", sortKey: 10 }),
        node({ id: "root-a", sortKey: 10 }),
        node({ id: "child-a", parentId: "root-a", sortKey: 10 }),
        node({ id: "root-c", sortKey: 20 })
      ])
    );

    expect(state.rootIds).toEqual(["root-a", "root-b", "root-c"]);
    expect(state.childIdsByParent["root-a"]).toEqual(["child-a", "child-b"]);
    expect(visibleNodeIds(state, null)).toEqual([
      "root-a",
      "child-a",
      "child-b",
      "root-b",
      "root-c"
    ]);
  });

  it("hides collapsed descendants while retaining their normalized records", () => {
    const state = normalizeWorkspace(
      workspace([
        node({ id: "root", isCollapsed: true }),
        node({ id: "child", parentId: "root" }),
        node({ id: "grandchild", parentId: "child" }),
        node({ id: "sibling", sortKey: 2048 })
      ])
    );

    expect(visibleNodeIds(state, null)).toEqual(["root", "sibling"]);
    expect(state.nodesById.child).toBeDefined();
    expect(state.nodesById.grandchild).toBeDefined();
  });

  it("shows a zoom root and its visible subtree while excluding outside branches", () => {
    const state = normalizeWorkspace(
      workspace([
        node({ id: "outside" }),
        node({ id: "project", sortKey: 2048 }),
        node({ id: "task", parentId: "project" }),
        node({ id: "detail", parentId: "task" })
      ])
    );

    expect(visibleNodeIds(state, "project")).toEqual([
      "project",
      "task",
      "detail"
    ]);
    expect(visibleNodeIds(state, "missing")).toEqual([]);
  });

  it("flattens deterministic visible rows with collapse-aware ancestry", () => {
    const state = normalizeWorkspace(
      workspace([
        node({ id: "root-b", sortKey: 20 }),
        node({ id: "hidden", parentId: "child-b" }),
        node({
          id: "child-b",
          parentId: "root-a",
          sortKey: 20,
          isCollapsed: true
        }),
        node({ id: "root-a", sortKey: 10 }),
        node({ id: "grandchild", parentId: "child-a" }),
        node({ id: "child-a", parentId: "root-a", sortKey: 10 })
      ])
    );

    expect(flattenVisibleOutlineRows(state, null)).toEqual([
      {
        id: "root-a",
        parentId: null,
        depth: 0,
        isCollapsed: false,
        ancestorIds: [],
        ancestorGuideDepths: [],
        visibleDescendantEndId: "child-b"
      },
      {
        id: "child-a",
        parentId: "root-a",
        depth: 1,
        isCollapsed: false,
        ancestorIds: ["root-a"],
        ancestorGuideDepths: [0],
        visibleDescendantEndId: "grandchild"
      },
      {
        id: "grandchild",
        parentId: "child-a",
        depth: 2,
        isCollapsed: false,
        ancestorIds: ["root-a", "child-a"],
        ancestorGuideDepths: [0, 1],
        visibleDescendantEndId: null
      },
      {
        id: "child-b",
        parentId: "root-a",
        depth: 1,
        isCollapsed: true,
        ancestorIds: ["root-a"],
        ancestorGuideDepths: [0],
        visibleDescendantEndId: null
      },
      {
        id: "root-b",
        parentId: null,
        depth: 0,
        isCollapsed: false,
        ancestorIds: [],
        ancestorGuideDepths: [],
        visibleDescendantEndId: null
      }
    ]);
  });

  it("resets visible depth and ancestry at the zoom root boundary", () => {
    const state = normalizeWorkspace(
      workspace([
        node({ id: "outside" }),
        node({ id: "project", sortKey: 20 }),
        node({ id: "task", parentId: "project" }),
        node({ id: "detail", parentId: "task" })
      ])
    );

    expect(flattenVisibleOutlineRows(state, "task")).toEqual([
      {
        id: "task",
        parentId: "project",
        depth: 0,
        isCollapsed: false,
        ancestorIds: [],
        ancestorGuideDepths: [],
        visibleDescendantEndId: "detail"
      },
      {
        id: "detail",
        parentId: "task",
        depth: 1,
        isCollapsed: false,
        ancestorIds: ["task"],
        ancestorGuideDepths: [0],
        visibleDescendantEndId: null
      }
    ]);
    expect(flattenVisibleOutlineRows(state, "missing")).toEqual([]);
  });

  it("marks guide ancestry and the final visible descendant for expanded branches", () => {
    const state = normalizeWorkspace(
      workspace([
        node({ id: "project", sortKey: 1 }),
        node({ id: "plan", parentId: "project", sortKey: 1 }),
        node({ id: "milestone", parentId: "plan" }),
        node({ id: "reference", parentId: "project", sortKey: 2 }),
        node({ id: "collapsed", sortKey: 2, isCollapsed: true }),
        node({ id: "hidden", parentId: "collapsed" })
      ])
    );

    const guideMetadata = flattenVisibleOutlineRows(state, null).map((row) =>
      ({
        id: row.id,
        ancestorGuideDepths: row.ancestorGuideDepths,
        visibleDescendantEndId: row.visibleDescendantEndId
      })
    );

    expect(guideMetadata).toEqual([
      {
        id: "project",
        ancestorGuideDepths: [],
        visibleDescendantEndId: "reference"
      },
      {
        id: "plan",
        ancestorGuideDepths: [0],
        visibleDescendantEndId: "milestone"
      },
      {
        id: "milestone",
        ancestorGuideDepths: [0, 1],
        visibleDescendantEndId: null
      },
      {
        id: "reference",
        ancestorGuideDepths: [0],
        visibleDescendantEndId: null
      },
      {
        id: "collapsed",
        ancestorGuideDepths: [],
        visibleDescendantEndId: null
      }
    ]);
  });

  it("builds an ordered parent trail and safely stops at missing parents", () => {
    const state = normalizeWorkspace(
      workspace([
        node({ id: "root" }),
        node({ id: "parent", parentId: "root" }),
        node({ id: "child", parentId: "parent" }),
        node({ id: "orphan", parentId: "missing" })
      ])
    );

    expect(parentTrail(state, "child")).toEqual(["root", "parent", "child"]);
    expect(parentTrail(state, "root")).toEqual(["root"]);
    expect(parentTrail(state, "orphan")).toEqual(["orphan"]);
    expect(parentTrail(state, "missing")).toEqual([]);
  });
});
