import { describe, expect, it } from "vitest";
import type { NoteNode } from "../../domain/notes";
import { buildNotesMoveDestinations } from "./notesMoveTargets";

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

describe("buildNotesMoveDestinations", () => {
  it("excludes every selected root and each complete selected subtree", () => {
    const nodes = [
      node({ id: "moving-a", sortKey: 1 }),
      node({ id: "moving-a-child", parentId: "moving-a", sortKey: 1 }),
      node({
        id: "moving-a-grandchild",
        parentId: "moving-a-child",
        sortKey: 1
      }),
      node({ id: "moving-b", sortKey: 2 }),
      node({ id: "moving-b-child", parentId: "moving-b", sortKey: 1 }),
      node({ id: "available", sortKey: 3, title: "Available" }),
      node({
        id: "available-child",
        parentId: "available",
        sortKey: 1,
        title: "Available child"
      })
    ];
    const nodesById = Object.fromEntries(nodes.map((item) => [item.id, item]));

    expect(
      buildNotesMoveDestinations(nodesById, ["moving-a", "moving-b"])
    ).toEqual([
      { id: null, label: "Top level", depth: 0 },
      { id: "available", label: "Available", depth: 0 },
      { id: "available-child", label: "Available child", depth: 1 }
    ]);
  });

  it("preserves the existing single-root call shape", () => {
    const nodes = [
      node({ id: "moving", sortKey: 1 }),
      node({ id: "moving-child", parentId: "moving", sortKey: 1 }),
      node({ id: "available", sortKey: 2, title: "Available" })
    ];
    const nodesById = Object.fromEntries(nodes.map((item) => [item.id, item]));

    expect(buildNotesMoveDestinations(nodesById, "moving")).toEqual([
      { id: null, label: "Top level", depth: 0 },
      { id: "available", label: "Available", depth: 0 }
    ]);
  });
});
