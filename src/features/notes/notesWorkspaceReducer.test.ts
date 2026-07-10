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

  it("normalizes duplicate and prototype-like IDs into consistent safe indexes", () => {
    const state = normalizeWorkspace(
      workspace([
        node({ id: "duplicate", title: "discarded root", sortKey: 1 }),
        node({ id: "__proto__", sortKey: 2 }),
        node({ id: "child", parentId: "__proto__", sortKey: 3 }),
        node({
          id: "duplicate",
          parentId: "__proto__",
          title: "winning child",
          sortKey: 4
        })
      ])
    );

    expect(Object.getPrototypeOf(state.nodesById)).toBeNull();
    expect(Object.getPrototypeOf(state.childIdsByParent)).toBeNull();
    expect(Object.keys(state.nodesById)).toEqual([
      "duplicate",
      "__proto__",
      "child"
    ]);
    expect(state.nodesById.duplicate.title).toBe("winning child");
    expect(state.rootIds).toEqual(["__proto__"]);
    expect(state.childIdsByParent.__proto__).toEqual(["child", "duplicate"]);
  });

  it("atomically publishes a successful result and reconciles UI state", () => {
    let state = normalizeWorkspace(workspace([node({ id: "root" }), node({ id: "child", parentId: "root" })]));
    state = notesWorkspaceReducer(state, {
      type: "setUiState",
      selectedId: "child",
      zoomRootId: "root",
      editingNoteId: "child",
      pendingFocusId: "child"
    });

    const retained = notesWorkspaceReducer(state, {
      type: "settleQueueWork",
      result: {
        kind: "authoritative",
        workspace: workspace([
          node({ id: "root" }),
          node({ id: "child", parentId: "root" }),
          node({ id: "created", parentId: "root" })
        ]),
        uiUpdate: {
          selectedId: "created",
          editingNoteId: "created",
          pendingFocusId: "created"
        }
      },
      hasPendingWork: true
    });
    expect(retained).toMatchObject({
      selectedId: "created",
      zoomRootId: "root",
      editingNoteId: "created",
      pendingFocusId: "created",
      status: "loading",
      error: null
    });

    const cleared = notesWorkspaceReducer(retained, {
      type: "settleQueueWork",
      result: {
        kind: "authoritative",
        workspace: workspace([node({ id: "root" })])
      },
      hasPendingWork: false
    });
    expect(cleared).toMatchObject({
      selectedId: null,
      zoomRootId: "root",
      editingNoteId: null,
      pendingFocusId: null,
      status: "ready",
      error: null
    });
  });

  it("keeps the confirmed tree on failures and settles status from remaining work", () => {
    const initial = normalizeWorkspace(workspace([node({ id: "root" })]));
    const pending = notesWorkspaceReducer(initial, {
      type: "settleQueueWork",
      result: { kind: "failure", error: "first failed" },
      hasPendingWork: true
    });

    expect(pending).toMatchObject({
      status: "loading",
      error: "first failed"
    });
    expect(pending.nodesById.root).toBeDefined();

    const state = notesWorkspaceReducer(pending, {
      type: "settleQueueWork",
      result: { kind: "failure", error: "offline" },
      hasPendingWork: false
    });

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

  it("retains errors through loading and skipped dependent work", () => {
    const confirmed = normalizeWorkspace(workspace([node({ id: "root" })]));
    const failed = notesWorkspaceReducer(confirmed, {
      type: "settleQueueWork",
      result: { kind: "failure", error: "parent creation failed" },
      hasPendingWork: false
    });

    const loading = notesWorkspaceReducer(failed, { type: "setLoading" });
    expect(loading).toMatchObject({
      status: "loading",
      error: "parent creation failed"
    });
    expect(loading.nodesById.root).toBeDefined();

    const skipped = notesWorkspaceReducer(loading, {
      type: "settleQueueWork",
      result: { kind: "skipped" },
      hasPendingWork: false
    });
    expect(skipped).toMatchObject({
      status: "error",
      error: "parent creation failed"
    });
    expect(skipped.nodesById.root).toBeDefined();
  });

  it("reports ready after skipped work only when no failure remains", () => {
    const loading = notesWorkspaceReducer(
      normalizeWorkspace(workspace([node({ id: "root" })])),
      { type: "setLoading" }
    );

    const skipped = notesWorkspaceReducer(loading, {
      type: "settleQueueWork",
      result: { kind: "skipped" },
      hasPendingWork: false
    });

    expect(skipped).toMatchObject({ status: "ready", error: null });
    expect(skipped.nodesById.root).toBeDefined();
  });
});
