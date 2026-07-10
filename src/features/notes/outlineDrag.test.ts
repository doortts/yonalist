import { describe, expect, it } from "vitest";
import type { NoteId, NoteNode, NotesWorkspace } from "../../domain/notes";
import {
  OUTLINE_INDENT_PX,
  projectOutlineDrop,
  type OutlineSiblingOrder
} from "./outlineDrag";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import {
  flattenVisibleOutlineRows,
  type FlattenedOutlineRow
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

function row(
  overrides: Partial<FlattenedOutlineRow> & Pick<FlattenedOutlineRow, "id">
): FlattenedOutlineRow {
  return {
    parentId: null,
    depth: 0,
    isCollapsed: false,
    ancestorIds: [],
    ...overrides
  };
}

function siblingOrder(
  rootIds: NoteId[],
  childIdsByParent: Readonly<Record<NoteId, readonly NoteId[]>> = {}
): OutlineSiblingOrder {
  return { rootIds, childIdsByParent, zoomRootId: null };
}

function project(
  nodes: NoteNode[],
  activeId: NoteId,
  overId: NoteId,
  horizontalOffset = 0,
  zoomRootId: NoteId | null = null
) {
  const state = normalizeWorkspace({ nodes } satisfies NotesWorkspace);
  const result = projectOutlineDrop(
    activeId,
    overId,
    horizontalOffset,
    flattenVisibleOutlineRows(state, zoomRootId),
    {
      rootIds: state.rootIds,
      childIdsByParent: state.childIdsByParent,
      zoomRootId
    }
  );
  if (result) {
    const anchors = [result.afterId, result.beforeId].filter(
      (anchor): anchor is NoteId => anchor != null
    );
    expect(anchors.length).toBeLessThanOrEqual(1);
    const siblings =
      result.parentId === null
        ? state.rootIds
        : (state.childIdsByParent[result.parentId] ?? []);
    for (const anchor of anchors) {
      expect(siblings).toContain(anchor);
      expect(state.nodesById[anchor]?.parentId).toBe(result.parentId);
    }
  }
  return result;
}

describe("projectOutlineDrop", () => {
  it("exports and uses a 36px horizontal depth step", () => {
    const nodes = [
      node({ id: "active", sortKey: 1 }),
      node({ id: "parent", sortKey: 2 })
    ];

    expect(OUTLINE_INDENT_PX).toBe(36);
    expect(project(nodes, "active", "parent", OUTLINE_INDENT_PX / 2 - 1)).toEqual({
      parentId: null,
      afterId: "parent"
    });
    expect(project(nodes, "active", "parent", OUTLINE_INDENT_PX)).toEqual({
      parentId: "parent",
      afterId: null
    });
  });

  it("orders same-parent rows upward with beforeId and downward with afterId", () => {
    const roots = [
      node({ id: "a", sortKey: 1 }),
      node({ id: "b", sortKey: 2 }),
      node({ id: "c", sortKey: 3 })
    ];

    expect(project(roots, "c", "a")).toEqual({
      parentId: null,
      afterId: null,
      beforeId: "a"
    });
    expect(project(roots, "a", "c")).toEqual({
      parentId: null,
      afterId: "c"
    });
  });

  it("indents right as the last actual child of the preceding row", () => {
    expect(
      project(
        [
          node({ id: "active", sortKey: 1 }),
          node({ id: "parent", sortKey: 2 }),
          node({ id: "first-child", parentId: "parent", sortKey: 1 }),
          node({ id: "last-child", parentId: "parent", sortKey: 2 }),
          node({ id: "grandchild", parentId: "last-child" })
        ],
        "active",
        "parent",
        OUTLINE_INDENT_PX
      )
    ).toEqual({
      parentId: "parent",
      afterId: "last-child"
    });
  });

  it("uses append semantics when right-indenting under an empty row", () => {
    expect(
      project(
        [
          node({ id: "active", sortKey: 1 }),
          node({ id: "parent", sortKey: 2 })
        ],
        "active",
        "parent",
        OUTLINE_INDENT_PX
      )
    ).toEqual({
      parentId: "parent",
      afterId: null
    });
  });

  it("indents in place over itself under the preceding row", () => {
    expect(
      project(
        [
          node({ id: "previous", sortKey: 1 }),
          node({ id: "previous-child", parentId: "previous" }),
          node({ id: "previous-grandchild", parentId: "previous-child" }),
          node({ id: "active", sortKey: 2 }),
          node({ id: "active-child", parentId: "active" }),
          node({ id: "tail", sortKey: 3 })
        ],
        "active",
        "active",
        OUTLINE_INDENT_PX
      )
    ).toEqual({
      parentId: "previous",
      afterId: "previous-child"
    });
  });

  it("outdents left without escaping the valid visible boundary", () => {
    expect(
      project(
        [
          node({ id: "parent", sortKey: 1 }),
          node({ id: "active", parentId: "parent" }),
          node({ id: "tail", sortKey: 2 })
        ],
        "active",
        "tail",
        -OUTLINE_INDENT_PX
      )
    ).toEqual({
      parentId: null,
      afterId: "tail"
    });
  });

  it("outdents in place over itself after its former parent", () => {
    expect(
      project(
        [
          node({ id: "parent", sortKey: 1 }),
          node({ id: "earlier", parentId: "parent", sortKey: 1 }),
          node({ id: "active", parentId: "parent", sortKey: 2 }),
          node({ id: "active-child", parentId: "active" }),
          node({ id: "tail", sortKey: 2 })
        ],
        "active",
        "active",
        -OUTLINE_INDENT_PX
      )
    ).toEqual({
      parentId: null,
      afterId: "parent"
    });
  });

  it("uses beforeId for before-first placement", () => {
    expect(
      project(
        [
          node({ id: "first", sortKey: 1 }),
          node({ id: "middle", sortKey: 2 }),
          node({ id: "active", sortKey: 3 })
        ],
        "active",
        "first"
      )
    ).toEqual({
      parentId: null,
      afterId: null,
      beforeId: "first"
    });
  });

  it("appends after the last hidden child and expands a collapsed parent", () => {
    expect(
      project(
        [
          node({ id: "active", sortKey: 1 }),
          node({ id: "parent", sortKey: 2, isCollapsed: true }),
          node({ id: "hidden-a", parentId: "parent", sortKey: 1 }),
          node({ id: "hidden-b", parentId: "parent", sortKey: 2 })
        ],
        "active",
        "parent",
        OUTLINE_INDENT_PX
      )
    ).toEqual({
      parentId: "parent",
      afterId: "hidden-b",
      expandNodeId: "parent"
    });
  });

  it("returns null for self, no-op, and missing-row drops", () => {
    const roots = [
      node({ id: "a", sortKey: 1 }),
      node({ id: "b", sortKey: 2 })
    ];

    expect(project(roots, "a", "a")).toBeNull();
    expect(project(roots, "missing", "a")).toBeNull();
    expect(project(roots, "a", "missing")).toBeNull();
  });

  it.each([
    {
      name: "a deferred ancestor before its parent",
      rows: [
        row({
          id: "active",
          parentId: "parent",
          depth: 1,
          ancestorIds: ["parent"]
        }),
        row({ id: "parent" }),
        row({ id: "target" })
      ],
      order: siblingOrder(["parent", "target"], { parent: ["active"] })
    },
    {
      name: "an ancestor path resumed after a later root",
      rows: [
        row({ id: "parent" }),
        row({ id: "active" }),
        row({
          id: "child",
          parentId: "parent",
          depth: 1,
          ancestorIds: ["parent"]
        }),
        row({ id: "target" })
      ],
      order: siblingOrder(["parent", "active", "target"], {
        parent: ["child"]
      })
    },
    {
      name: "a duplicate row id",
      rows: [row({ id: "active" }), row({ id: "active" }), row({ id: "target" })],
      order: siblingOrder(["active", "target"])
    },
    {
      name: "a depth jump",
      rows: [
        row({ id: "active" }),
        row({
          id: "jumped",
          parentId: "missing",
          depth: 2,
          ancestorIds: ["active", "missing"]
        }),
        row({ id: "target" })
      ],
      order: siblingOrder(["active", "target"])
    },
    {
      name: "root-level parent linkage",
      rows: [
        row({ id: "active", parentId: "parent" }),
        row({ id: "parent" }),
        row({ id: "target" })
      ],
      order: siblingOrder(["parent", "target"], { parent: ["active"] })
    }
  ])("rejects malformed preorder rows with $name", ({ rows, order }) => {
    expect(projectOutlineDrop("active", "target", 0, rows, order)).toBeNull();
  });

  it("rejects drops over descendants", () => {
    expect(
      project(
        [
          node({ id: "parent" }),
          node({ id: "child", parentId: "parent" }),
          node({ id: "grandchild", parentId: "child" })
        ],
        "parent",
        "grandchild",
        OUTLINE_INDENT_PX
      )
    ).toBeNull();
  });

  it("rejects moving the zoom root and keeps descendants inside the zoom root", () => {
    const nodes = [
      node({ id: "outside", sortKey: 2 }),
      node({ id: "project" }),
      node({ id: "first", parentId: "project", sortKey: 1 }),
      node({ id: "second", parentId: "project", sortKey: 2 })
    ];

    expect(project(nodes, "project", "first", 0, "project")).toBeNull();
    expect(project(nodes, "first", "outside", 0, "project")).toBeNull();
    expect(
      project(nodes, "first", "second", -4 * OUTLINE_INDENT_PX, "project")
    ).toEqual({
      parentId: "project",
      afterId: "second"
    });
  });

  it("reorders descendants inside a nested zoom root", () => {
    expect(
      project(
        [
          node({ id: "project" }),
          node({ id: "zoom", parentId: "project" }),
          node({ id: "first", parentId: "zoom", sortKey: 1 }),
          node({ id: "second", parentId: "zoom", sortKey: 2 })
        ],
        "second",
        "first",
        0,
        "zoom"
      )
    ).toEqual({
      parentId: "zoom",
      afterId: null,
      beforeId: "first"
    });
  });

  it("keeps both subtree blocks contiguous on same-depth downward moves", () => {
    expect(
      project(
        [
          node({ id: "active", sortKey: 1 }),
          node({ id: "active-child", parentId: "active" }),
          node({ id: "target", sortKey: 2 }),
          node({ id: "target-child", parentId: "target" })
        ],
        "active",
        "target"
      )
    ).toEqual({
      parentId: null,
      afterId: "target"
    });
  });

  it("emits at most one direct-sibling anchor for every projected parent", () => {
    const cases = [
      {
        nodes: [
          node({ id: "first", sortKey: 1 }),
          node({ id: "active", sortKey: 2 })
        ],
        activeId: "active",
        overId: "first",
        offset: 0
      },
      {
        nodes: [
          node({ id: "active", sortKey: 1 }),
          node({ id: "parent", sortKey: 2 }),
          node({ id: "child", parentId: "parent" })
        ],
        activeId: "active",
        overId: "parent",
        offset: OUTLINE_INDENT_PX
      },
      {
        nodes: [
          node({ id: "active", sortKey: 1 }),
          node({ id: "parent", sortKey: 2, isCollapsed: true }),
          node({ id: "hidden", parentId: "parent" })
        ],
        activeId: "active",
        overId: "parent",
        offset: OUTLINE_INDENT_PX
      }
    ];

    for (const current of cases) {
      const result = project(
        current.nodes,
        current.activeId,
        current.overId,
        current.offset
      );
      expect(result).not.toBeNull();
      const anchors = [result?.afterId, result?.beforeId].filter(
        (anchor): anchor is NoteId => anchor != null
      );
      expect(anchors).toHaveLength(1);
      const anchor = current.nodes.find((item) => item.id === anchors[0]);
      expect(anchor?.parentId).toBe(result?.parentId);
    }
  });
});
