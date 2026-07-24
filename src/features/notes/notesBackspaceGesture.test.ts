import { describe, expect, it } from "vitest";
import type {
  NoteId,
  NoteNode,
  NotesBackspaceTitleUpdate
} from "../../domain/notes";
import type { FlattenedOutlineRow } from "./outlineTree";
import { deriveOutlineGuideMetadata } from "./outlineTree";
import {
  appendBackspaceRemoval,
  projectOptimisticBackspaceGesture,
  type OptimisticBackspaceGesture
} from "./notesBackspaceGesture";

function row(
  id: NoteId,
  overrides: Partial<FlattenedOutlineRow> = {}
): FlattenedOutlineRow {
  return {
    id,
    parentId: null,
    depth: 0,
    isCollapsed: false,
    ancestorIds: [],
    ancestorGuideDepths: [],
    visibleDescendantEndId: null,
    ...overrides
  };
}

function note(
  id: NoteId,
  title: string,
  overrides: Partial<NoteNode> = {}
): NoteNode {
  return {
    id,
    nodeKind: "text",
    markerKind: "bullet",
    parentId: null,
    sortKey: 1024,
    title,
    note: "",
    imageOffsetUtf16: 0,
    markdownImageWidth: null,
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    ...overrides
  };
}

function gesture(
  overrides: Partial<OptimisticBackspaceGesture> = {}
): OptimisticBackspaceGesture {
  return {
    token: 7,
    ownerPaneId: "primary",
    startingNodeId: "removed-a",
    startingSelection: { anchorUtf16: 0, focusUtf16: 0 },
    removedNodeIds: ["removed-a", "removed-b", "removed-a"],
    titleUpdate: { id: "root", title: "Final survivor" },
    focusNodeId: "root",
    status: "queued",
    ...overrides
  };
}

describe("optimistic Backspace gesture projection", () => {
  it("appends one immutable removal while keeping the latest focus and title", () => {
    const initial = gesture({
      removedNodeIds: ["removed-a"],
      focusNodeId: "removed-a",
      titleUpdate: null
    });
    const titleUpdate: NotesBackspaceTitleUpdate = {
      id: "root",
      title: "Final survivor"
    };

    const next = appendBackspaceRemoval(initial, {
      nodeId: "removed-b",
      focusNodeId: "root",
      titleUpdate
    });

    expect(next).toEqual({
      ...initial,
      removedNodeIds: ["removed-a", "removed-b"],
      focusNodeId: "root",
      titleUpdate
    });
    expect(next).not.toBe(initial);
    expect(next.removedNodeIds).not.toBe(initial.removedNodeIds);
  });

  it("removes truly adjacent rows once and updates the final survivor", () => {
    const survivor = row("survivor");
    const emptyA = row("empty-a");
    const emptyB = row("empty-b");
    const projection = projectOptimisticBackspaceGesture(
      [survivor, emptyA, emptyB],
      {
        survivor: note("survivor", "Before"),
        "empty-a": note("empty-a", ""),
        "empty-b": note("empty-b", "")
      },
      gesture({
        startingNodeId: "empty-a",
        removedNodeIds: ["empty-a", "empty-b", "empty-a"],
        titleUpdate: { id: "survivor", title: "After" },
        focusNodeId: "survivor"
      })
    );

    expect(projection.rows).toEqual([survivor]);
    expect(projection.rows[0]).toBe(survivor);
    expect(projection.nodeOverrides.get("survivor")?.title).toBe("After");
  });

  it("removes adjacent rows once, lifts descendants, and leaves inputs untouched", () => {
    const root = row("root", {
      visibleDescendantEndId: "nested-child"
    });
    const removedA = row("removed-a", {
      parentId: "root",
      depth: 1,
      ancestorIds: ["root"],
      ancestorGuideDepths: [0],
      visibleDescendantEndId: "lifted-a"
    });
    const liftedA = row("lifted-a", {
      parentId: "removed-a",
      depth: 2,
      ancestorIds: ["root", "removed-a"],
      ancestorGuideDepths: [0, 1]
    });
    const removedB = row("removed-b", {
      parentId: "root",
      depth: 1,
      ancestorIds: ["root"],
      ancestorGuideDepths: [0],
      visibleDescendantEndId: "nested-child"
    });
    const liftedB = row("lifted-b", {
      parentId: "removed-b",
      depth: 2,
      ancestorIds: ["root", "removed-b"],
      ancestorGuideDepths: [0, 1],
      visibleDescendantEndId: "nested-child"
    });
    const nestedChild = row("nested-child", {
      parentId: "lifted-b",
      depth: 3,
      ancestorIds: ["root", "removed-b", "lifted-b"],
      ancestorGuideDepths: [0, 1, 2]
    });
    const rows = [root, removedA, liftedA, removedB, liftedB, nestedChild];
    const nodesById: Record<NoteId, NoteNode> = {
      root: note("root", "Original root"),
      "removed-a": note("removed-a", ""),
      "lifted-a": note("lifted-a", "Lifted A", { parentId: "removed-a" }),
      "removed-b": note("removed-b", ""),
      "lifted-b": note("lifted-b", "Lifted B", { parentId: "removed-b" }),
      "nested-child": note("nested-child", "Nested", { parentId: "lifted-b" })
    };
    const originalRows = rows.map((entry) => ({ ...entry, ancestorIds: [...entry.ancestorIds], ancestorGuideDepths: [...entry.ancestorGuideDepths] }));
    const originalNodes = { ...nodesById };

    const projection = projectOptimisticBackspaceGesture(
      rows,
      nodesById,
      gesture()
    );

    expect(projection.rows.map((entry) => entry.id)).toEqual([
      "root",
      "lifted-a",
      "lifted-b",
      "nested-child"
    ]);
    expect(projection.rows[1]).toMatchObject({
      parentId: "root",
      depth: 1,
      ancestorIds: ["root"]
    });
    expect(projection.rows[2]).toMatchObject({
      parentId: "root",
      depth: 1,
      ancestorIds: ["root"]
    });
    expect(projection.rows[3]).toMatchObject({
      parentId: "lifted-b",
      depth: 2,
      ancestorIds: ["root", "lifted-b"]
    });
    expect(projection.nodeOverrides.get("root")).toMatchObject({
      id: "root",
      title: "Final survivor"
    });
    expect(projection.rows.map(({ ancestorGuideDepths, visibleDescendantEndId }) => ({ ancestorGuideDepths, visibleDescendantEndId }))).toEqual(
      deriveOutlineGuideMetadata(projection.rows)
    );
    expect(rows).toEqual(originalRows);
    for (const entry of rows) {
      expect(rows.find((candidate) => candidate.id === entry.id)).toBe(entry);
    }
    for (const [id, node] of Object.entries(originalNodes)) {
      expect(nodesById[id]).toBe(node);
    }
    expect(nodesById.root.title).toBe("Original root");
  });
});
