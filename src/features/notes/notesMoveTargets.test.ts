import { describe, expect, it } from "vitest";
import type { NoteNode } from "../../domain/notes";
import {
  buildNotesMoveDestinations,
  hasValidNotesMoveDestination
} from "./notesMoveTargets";

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
    ...overrides,
    markerKind: overrides.markerKind ?? "bullet"
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

describe("hasValidNotesMoveDestination", () => {
  it("rejects the no-op top-level destination for the sole selected subtree", () => {
    const nodes = [
      node({ id: "only", sortKey: 1 }),
      node({ id: "child", parentId: "only", sortKey: 1 })
    ];
    const nodesById = Object.fromEntries(nodes.map((item) => [item.id, item]));

    expect(hasValidNotesMoveDestination(nodesById, "only")).toBe(false);
    expect(hasValidNotesMoveDestination(nodesById, ["only"])).toBe(false);
  });

  it("treats an already-last contiguous top-level block as a no-op", () => {
    const nodes = [
      node({ id: "a", sortKey: 1 }),
      node({ id: "b", sortKey: 2 })
    ];
    const nodesById = Object.fromEntries(nodes.map((item) => [item.id, item]));

    expect(hasValidNotesMoveDestination(nodesById, ["a", "b"])).toBe(false);
  });

  it("accepts selections whose roots currently have mixed parents", () => {
    const nodes = [
      node({ id: "left-parent", sortKey: 1 }),
      node({ id: "left", parentId: "left-parent" }),
      node({ id: "right-parent", sortKey: 2 }),
      node({ id: "right", parentId: "right-parent" })
    ];
    const nodesById = Object.fromEntries(nodes.map((item) => [item.id, item]));

    expect(hasValidNotesMoveDestination(nodesById, ["left", "right"])).toBe(
      true
    );
  });
});
