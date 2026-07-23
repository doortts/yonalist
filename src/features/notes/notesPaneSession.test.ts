import { describe, expect, it } from "vitest";
import type { NoteNode } from "../../domain/notes";
import { normalizeWorkspace } from "./notesWorkspaceReducer";
import {
  createInitialNotesPaneSession,
  notesPaneSessionReducer,
  reconcileNotesPaneSession
} from "./notesPaneSession";

function node(
  overrides: Partial<NoteNode> & Pick<NoteNode, "id">
): NoteNode {
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
    createdAt: "2026-07-24T00:00:00Z",
    updatedAt: "2026-07-24T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    imageOffsetUtf16: 0,
    markerKind: "bullet",
    markdownImageWidth: null,
    ...overrides
  };
}

describe("notes pane session", () => {
  it("keeps primary and secondary navigation independent", () => {
    const primary = createInitialNotesPaneSession("primary");
    const secondary = createInitialNotesPaneSession("secondary");

    const changedPrimary = notesPaneSessionReducer(primary, {
      type: "setNavigation",
      patch: { zoomRootId: "page-a", selectedId: "child-a" }
    });

    expect(changedPrimary).toMatchObject({
      paneId: "primary",
      zoomRootId: "page-a",
      selectedId: "child-a",
      navigationVersion: 1
    });
    expect(secondary).toMatchObject({
      paneId: "secondary",
      zoomRootId: null,
      selectedId: null,
      navigationVersion: 0
    });
  });

  it("changes selection revision only for an actual selection change", () => {
    const initial = createInitialNotesPaneSession("secondary");
    const selected = notesPaneSessionReducer(initial, {
      type: "setSelection",
      selection: { anchorId: "a", headId: "b" }
    });
    const repeated = notesPaneSessionReducer(selected, {
      type: "setSelection",
      selection: { anchorId: "a", headId: "b" }
    });

    expect(selected.selectionRevision).toBe(1);
    expect(repeated).toBe(selected);
  });

  it("allows navigation fields to be explicitly cleared", () => {
    const focused = notesPaneSessionReducer(
      createInitialNotesPaneSession("secondary"),
      {
        type: "setNavigation",
        patch: {
          selectedId: "node",
          zoomRootId: "node",
          editingNoteId: "node",
          pendingFocusId: "node",
          pendingFocusField: "note"
        }
      }
    );

    expect(
      notesPaneSessionReducer(focused, {
        type: "setNavigation",
        patch: {
          selectedId: null,
          zoomRootId: null,
          editingNoteId: null,
          pendingFocusId: null,
          pendingFocusField: null
        }
      })
    ).toMatchObject({
      selectedId: null,
      zoomRootId: null,
      editingNoteId: null,
      pendingFocusId: null,
      pendingFocusField: null
    });
  });

  it("reconciles only invalid navigation against authoritative nodes", () => {
    const workspace = normalizeWorkspace({
      nodes: [
        node({ id: "page" }),
        node({ id: "child", parentId: "page" }),
        node({ id: "other", sortKey: 2048 })
      ]
    });
    let pane = createInitialNotesPaneSession("secondary");
    pane = notesPaneSessionReducer(pane, {
      type: "setNavigation",
      patch: {
        zoomRootId: "page",
        selectedId: "missing",
        editingNoteId: "child",
        pendingFocusId: "missing",
        pendingFocusField: "title"
      }
    });
    pane = notesPaneSessionReducer(pane, {
      type: "setExpansion",
      nodeIds: new Set(["child", "missing"])
    });
    pane = notesPaneSessionReducer(pane, {
      type: "setScroll",
      anchorId: "missing",
      offset: 45
    });

    const reconciled = reconcileNotesPaneSession(pane, workspace);

    expect(reconciled.zoomRootId).toBe("page");
    expect(reconciled.selectedId).toBeNull();
    expect(reconciled.editingNoteId).toBe("child");
    expect(reconciled.pendingFocusId).toBeNull();
    expect(reconciled.pendingFocusField).toBeNull();
    expect([...reconciled.locallyExpandedNodeIds]).toEqual(["child"]);
    expect(reconciled.scrollAnchorId).toBeNull();
    expect(reconciled.scrollOffset).toBe(0);
  });

  it("falls back only the pane whose zoom page disappeared", () => {
    const workspace = normalizeWorkspace({
      nodes: [node({ id: "surviving-page" })]
    });
    const missing = notesPaneSessionReducer(
      createInitialNotesPaneSession("primary"),
      {
        type: "setNavigation",
        patch: { zoomRootId: "deleted-page" }
      }
    );
    const surviving = notesPaneSessionReducer(
      createInitialNotesPaneSession("secondary"),
      {
        type: "setNavigation",
        patch: { zoomRootId: "surviving-page" }
      }
    );

    expect(reconcileNotesPaneSession(missing, workspace).zoomRootId).toBeNull();
    expect(
      reconcileNotesPaneSession(surviving, workspace).zoomRootId
    ).toBe("surviving-page");
  });
});
