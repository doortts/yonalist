import { describe, expect, it } from "vitest";
import type { NoteNode, NotesWorkspace } from "../../domain/notes";
import {
  normalizeWorkspace,
  notesWorkspaceReducer
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
    ...overrides
  };
}

function workspace(nodes: NoteNode[]): NotesWorkspace {
  return { nodes };
}

describe("notesWorkspaceReducer", () => {
  it("normalizes every record with deterministic root and child ordering", () => {
    const state = normalizeWorkspace(
      workspace([
        node({ id: "z", sortKey: 1 }),
        node({ id: "a", sortKey: 1 }),
        node({ id: "child-z", parentId: "a", sortKey: 1 }),
        node({ id: "child-a", parentId: "a", sortKey: 1 }),
        node({ id: "hidden", parentId: "child-a", isCollapsed: true })
      ])
    );

    expect(state.rootIds).toEqual(["a", "z"]);
    expect(state.childIdsByParent.a).toEqual(["child-a", "child-z"]);
    expect(Object.keys(state.nodesById)).toHaveLength(5);
    expect(state.nodesById.hidden).toMatchObject({ id: "hidden" });
  });

  it("retains compatible UI state on authoritative replacement and clears stale IDs", () => {
    let state = normalizeWorkspace(workspace([node({ id: "root" }), node({ id: "child", parentId: "root" })]));
    state = notesWorkspaceReducer(state, {
      type: "setUiState",
      selectedId: "child",
      zoomRootId: "root",
      editingNoteId: "child",
      pendingFocusId: "child"
    });

    const retained = notesWorkspaceReducer(state, {
      type: "replaceWorkspace",
      workspace: workspace([node({ id: "root" }), node({ id: "child", parentId: "root" })])
    });
    expect(retained).toMatchObject({
      selectedId: "child",
      zoomRootId: "root",
      editingNoteId: "child",
      pendingFocusId: "child",
      status: "ready",
      error: null
    });

    const cleared = notesWorkspaceReducer(retained, {
      type: "replaceWorkspace",
      workspace: workspace([node({ id: "root" })])
    });
    expect(cleared).toMatchObject({
      selectedId: null,
      zoomRootId: "root",
      editingNoteId: null,
      pendingFocusId: null
    });
  });

  it("keeps confirmed nodes when load errors and ignores invalid UI IDs", () => {
    const state = notesWorkspaceReducer(
      normalizeWorkspace(workspace([node({ id: "root" })])),
      { type: "setError", error: "offline" }
    );

    expect(state.status).toBe("error");
    expect(state.error).toBe("offline");
    expect(state.nodesById.root).toBeDefined();
    expect(
      notesWorkspaceReducer(state, {
        type: "setUiState",
        selectedId: "missing",
        zoomRootId: "missing",
        editingNoteId: "missing",
        pendingFocusId: "missing"
      })
    ).toMatchObject({
      selectedId: null,
      zoomRootId: null,
      editingNoteId: null,
      pendingFocusId: null
    });
  });
});
