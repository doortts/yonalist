import { describe, expect, it } from "vitest";
import type { NoteNode, NotesWorkspace } from "../../domain/notes";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import { parentTrail, visibleNodeIds } from "./outlineTree";

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
