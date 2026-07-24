import { describe, expect, it } from "vitest";
import type { NoteNode, NotesWorkspace } from "../../domain/notes";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import { flattenVisibleOutlineRows } from "./outlineTree";
import { projectCrossPaneOrdinaryDrop } from "./notesCrossPaneDrag";

function node(overrides: Partial<NoteNode> & Pick<NoteNode, "id">): NoteNode {
  return {
    nodeKind: "text",
    markerKind: "bullet",
    parentId: null,
    sortKey: 1024,
    title: overrides.id,
    note: "",
    imageOffsetUtf16: 0,
    markdownImageWidth: null,
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-24T00:00:00Z",
    updatedAt: "2026-07-24T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    ...overrides
  };
}

function projection(
  nodes: NoteNode[],
  activeId: string,
  zoomRootId: string | null,
  beforeId: string | null,
  horizontalOffset = 0,
  sourceRootIds?: readonly string[]
) {
  const workspace = normalizeWorkspace({
    nodes
  } satisfies NotesWorkspace);
  return projectCrossPaneOrdinaryDrop({
    activeId,
    sourceRootIds,
    beforeId,
    horizontalOffset,
    rows: flattenVisibleOutlineRows(workspace, zoomRootId),
    workspace,
    zoomRootId,
    indentPx: 36
  });
}

describe("cross-pane ordinary drop projection", () => {
  const nodes = [
    node({ id: "source", sortKey: 1 }),
    node({ id: "page", sortKey: 2 }),
    node({ id: "a", parentId: "page", sortKey: 1 }),
    node({ id: "b", parentId: "page", sortKey: 2 })
  ];

  it("projects a zoomed tail as the page's final child", () => {
    expect(projection(nodes, "source", "page", null)).toMatchObject({
      input: { parentId: "page", afterId: "b" },
      preview: { parentId: "page", beforeId: null, depth: 1 }
    });
  });

  it("projects the boundary before the first destination child", () => {
    expect(projection(nodes, "source", "page", "a")).toMatchObject({
      input: { parentId: "page", afterId: null, beforeId: "a" },
      preview: { parentId: "page", beforeId: "a", depth: 1 }
    });
  });

  it("rejects a destination page inside the dragged subtree", () => {
    expect(
      projection(
        [
          node({ id: "source", sortKey: 1 }),
          node({ id: "child", parentId: "source", sortKey: 1 })
        ],
        "source",
        "child",
        null
      )
    ).toBeNull();
  });

  it("does not save a drop at the existing destination boundary", () => {
    expect(projection(nodes, "a", "page", "b")).toBeNull();
  });

  it("projects selected structural roots without targeting the selection", () => {
    expect(
      projection(
        [
          node({ id: "first", sortKey: 1 }),
          node({ id: "second", sortKey: 2 }),
          node({ id: "page", sortKey: 3 }),
          node({ id: "tail", parentId: "page", sortKey: 1 })
        ],
        "first",
        "page",
        "tail",
        0,
        ["first", "second"]
      )
    ).toMatchObject({
      input: { parentId: "page", beforeId: "tail", afterId: null }
    });
  });

  it("uses a selected structural root when the grabbed row is its child", () => {
    expect(
      projection(
        [
          node({ id: "selected", sortKey: 1 }),
          node({ id: "grabbed", parentId: "selected", sortKey: 1 }),
          node({ id: "page", sortKey: 2 })
        ],
        "grabbed",
        "page",
        null,
        0,
        ["selected"]
      )
    ).toMatchObject({
      input: { parentId: "page", afterId: null }
    });
  });
});
