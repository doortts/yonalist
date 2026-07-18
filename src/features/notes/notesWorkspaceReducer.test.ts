import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NoteAttachment,
  NoteNode,
  NotesWorkspace
} from "../../domain/notes";
import {
  applyWorkspaceDelta,
  normalizeWorkspace,
  notesSelectionReducer,
  notesWorkspaceReducer,
  selectionRangeIds,
  setNotesDeltaVerificationEnabled,
  type NotesSelection,
  type NotesWorkspaceDelta
} from "./notesWorkspaceReducer";

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
    ...overrides
  };
}

function workspace(nodes: NoteNode[]): NotesWorkspace {
  return { nodes };
}

function attachment(
  overrides: Partial<NoteAttachment> & Pick<NoteAttachment, "id" | "nodeId">
): NoteAttachment {
  return {
    sortKey: 1024,
    relativePath: `assets/${overrides.id}.png`,
    contentHash: overrides.id,
    originalName: `${overrides.id}.png`,
    mimeType: "image/png",
    byteSize: 4,
    intrinsicWidth: 640,
    intrinsicHeight: 320,
    displayWidth: 320,
    createdAt: "2026-07-12T00:00:00Z",
    updatedAt: "2026-07-12T00:00:00Z",
    ...overrides
  };
}

describe("notesWorkspaceReducer", () => {
  it("preserves ordered attachment rows and normalizes legacy workspaces to an empty map", () => {
    const root = node({ id: "root" });
    const first = attachment({ id: "first", nodeId: root.id, sortKey: 100 });
    const second = attachment({ id: "second", nodeId: root.id, sortKey: 200 });

    const loaded = normalizeWorkspace({
      nodes: [root],
      attachmentsByNodeId: { [root.id]: [first, second] }
    });
    expect(loaded.attachmentsByNodeId[root.id]).toEqual([first, second]);

    const legacy = normalizeWorkspace({ nodes: [root] });
    expect(legacy.attachmentsByNodeId).toEqual({});

    const settled = notesWorkspaceReducer(legacy, {
      type: "settleQueueWork",
      result: {
        kind: "authoritative",
        workspace: {
          nodes: [root],
          attachmentsByNodeId: { [root.id]: [second, first] }
        }
      },
      hasPendingWork: false
    });
    expect(settled.attachmentsByNodeId[root.id]).toEqual([second, first]);
  });

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

  it("clears pending focus only for the matching acknowledgement", () => {
    const pending = notesWorkspaceReducer(
      normalizeWorkspace(
        workspace([
          node({ id: "root" }),
          node({ id: "child", parentId: "root" })
        ])
      ),
      {
        type: "setUiState",
        pendingFocusId: "child"
      }
    );

    const ignored = notesWorkspaceReducer(pending, {
      type: "acknowledgePendingFocus",
      nodeId: "root"
    });
    expect(ignored).toBeDefined();
    expect(ignored.pendingFocusId).toBe("child");

    const acknowledged = notesWorkspaceReducer(pending, {
      type: "acknowledgePendingFocus",
      nodeId: "child"
    });
    expect(acknowledged.pendingFocusId).toBeNull();
  });

  it("normalizes field-aware history focus with the focused node", () => {
    const initial = normalizeWorkspace(
      workspace([node({ id: "root" }), node({ id: "child", parentId: "root" })])
    );

    const noteFocus = notesWorkspaceReducer(initial, {
      type: "settleQueueWork",
      result: {
        kind: "authoritative",
        workspace: workspace([
          node({ id: "root" }),
          node({ id: "child", parentId: "root" })
        ]),
        uiUpdate: {
          selectedId: "child",
          editingNoteId: "child",
          pendingFocusId: "child",
          pendingFocusField: "note"
        }
      },
      hasPendingWork: false
    });
    expect(noteFocus).toMatchObject({
      pendingFocusId: "child",
      pendingFocusField: "note"
    });

    const removed = notesWorkspaceReducer(noteFocus, {
      type: "settleQueueWork",
      result: {
        kind: "authoritative",
        workspace: workspace([node({ id: "root" })])
      },
      hasPendingWork: false
    });
    expect(removed).toMatchObject({
      pendingFocusId: null,
      pendingFocusField: null
    });

    const legacyTitleFocus = notesWorkspaceReducer(initial, {
      type: "setUiState",
      pendingFocusId: "child"
    });
    expect(legacyTitleFocus.pendingFocusField).toBe("title");
  });

  it("publishes command-neutral focus only for an existing node", () => {
    const initial = normalizeWorkspace(
      workspace([node({ id: "root" }), node({ id: "child", parentId: "root" })])
    );

    const focused = notesWorkspaceReducer(initial, {
      type: "focusNode",
      nodeId: "child"
    });
    expect(focused).toMatchObject({
      selectedId: "child",
      editingNoteId: "child",
      pendingFocusId: "child"
    });

    expect(
      notesWorkspaceReducer(focused, {
        type: "focusNode",
        nodeId: "missing"
      })
    ).toBe(focused);
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

  it("publishes a partially authoritative failure without success-only focus", () => {
    const initial = normalizeWorkspace(
      workspace([
        node({ id: "root", title: "before" }),
        node({ id: "focus-target", sortKey: 2 })
      ])
    );

    const state = notesWorkspaceReducer(initial, {
      type: "settleQueueWork",
      result: {
        kind: "failure",
        error: "move failed",
        workspace: workspace([
          node({ id: "root", title: "saved draft" }),
          node({ id: "focus-target", sortKey: 2 })
        ])
      },
      hasPendingWork: false
    });

    expect(state.nodesById.root.title).toBe("saved draft");
    expect(state).toMatchObject({
      selectedId: null,
      editingNoteId: null,
      pendingFocusId: null,
      status: "error",
      error: "move failed"
    });
  });

  it("applies an owner-only UI update from a partially authoritative failure", () => {
    const initial = normalizeWorkspace(
      workspace([
        node({ id: "root" }),
        node({ id: "copy", sortKey: 2 })
      ])
    );

    const state = notesWorkspaceReducer(initial, {
      type: "settleQueueWork",
      result: {
        kind: "failure",
        error: "Projection reload failed",
        workspace: workspace([
          node({ id: "root" }),
          node({ id: "copy", sortKey: 2 })
        ]),
        uiUpdate: {
          selectedId: "copy",
          editingNoteId: "copy",
          pendingFocusId: "copy",
          pendingFocusField: "title"
        }
      },
      hasPendingWork: false
    });

    expect(state).toMatchObject({
      selectedId: "copy",
      editingNoteId: "copy",
      pendingFocusId: "copy",
      pendingFocusField: "title",
      status: "error",
      error: "Projection reload failed"
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

/**
 * Property-style parity: for each mutation family, settling with the delta must
 * produce the identical normalized store as settling the full workspace payload
 * with no delta. Verification is disabled so the incremental patch is compared
 * on its own merits (a fallback would mask a patch bug).
 */
describe("notesWorkspaceReducer incremental delta application", () => {
  beforeEach(() => {
    setNotesDeltaVerificationEnabled(false);
  });
  afterEach(() => {
    setNotesDeltaVerificationEnabled(false);
  });

  function bothPaths(
    priorNodes: NotesWorkspace,
    nextWorkspace: NotesWorkspace,
    delta: NotesWorkspaceDelta
  ): {
    incremental: ReturnType<typeof notesWorkspaceReducer>;
    full: ReturnType<typeof notesWorkspaceReducer>;
  } {
    const prior = normalizeWorkspace(priorNodes);
    const incremental = notesWorkspaceReducer(prior, {
      type: "settleQueueWork",
      result: { kind: "authoritative", workspace: nextWorkspace, delta },
      hasPendingWork: false
    });
    const full = notesWorkspaceReducer(prior, {
      type: "settleQueueWork",
      result: { kind: "authoritative", workspace: nextWorkspace },
      hasPendingWork: false
    });
    return { incremental, full };
  }

  it("create: upserts a new child in sorted position", () => {
    const root = node({ id: "root" });
    const a = node({ id: "a", parentId: "root", sortKey: 1024 });
    const b = node({ id: "b", parentId: "root", sortKey: 2048 });
    const { incremental, full } = bothPaths(
      workspace([root, a]),
      workspace([root, a, b]),
      { changedNodes: [b], removedNodeIds: [], changedAttachments: [] }
    );
    expect(incremental).toEqual(full);
    expect(incremental.childIdsByParent.root).toEqual(["a", "b"]);
  });

  it("update: replaces node values without touching structure", () => {
    const before = node({ id: "root", title: "before" });
    const after = node({ id: "root", title: "after" });
    const { incremental, full } = bothPaths(
      workspace([before]),
      workspace([after]),
      { changedNodes: [after], removedNodeIds: [], changedAttachments: [] }
    );
    expect(incremental).toEqual(full);
    expect(incremental.nodesById.root.title).toBe("after");
  });

  it("move: re-parents a node and updates both sibling lists", () => {
    const p1 = node({ id: "p1", sortKey: 1024 });
    const p2 = node({ id: "p2", sortKey: 2048 });
    const child = node({ id: "child", parentId: "p1", sortKey: 1024 });
    const moved = node({ id: "child", parentId: "p2", sortKey: 4096 });
    const { incremental, full } = bothPaths(
      workspace([p1, p2, child]),
      workspace([p1, p2, moved]),
      { changedNodes: [moved], removedNodeIds: [], changedAttachments: [] }
    );
    expect(incremental).toEqual(full);
    expect(incremental.childIdsByParent.p1).toBeUndefined();
    expect(incremental.childIdsByParent.p2).toEqual(["child"]);
  });

  it("move (reorder): repositions a sibling by its new sort key", () => {
    const p = node({ id: "p" });
    const x = node({ id: "x", parentId: "p", sortKey: 1024 });
    const y = node({ id: "y", parentId: "p", sortKey: 2048 });
    const z = node({ id: "z", parentId: "p", sortKey: 3072 });
    const zMoved = node({ id: "z", parentId: "p", sortKey: 1536 });
    const { incremental, full } = bothPaths(
      workspace([p, x, y, z]),
      workspace([p, x, y, zMoved]),
      { changedNodes: [zMoved], removedNodeIds: [], changedAttachments: [] }
    );
    expect(incremental).toEqual(full);
    expect(incremental.childIdsByParent.p).toEqual(["x", "z", "y"]);
  });

  it("outdent: promotes a nested child to a root position", () => {
    const root = node({ id: "root", sortKey: 1024 });
    const child = node({ id: "child", parentId: "root", sortKey: 1024 });
    const promoted = node({ id: "child", parentId: null, sortKey: 2048 });
    const { incremental, full } = bothPaths(
      workspace([root, child]),
      workspace([root, promoted]),
      { changedNodes: [promoted], removedNodeIds: [], changedAttachments: [] }
    );
    expect(incremental).toEqual(full);
    expect(incremental.rootIds).toEqual(["root", "child"]);
    expect(incremental.childIdsByParent.root).toBeUndefined();
  });

  it("toggle: publishes a completion flag change", () => {
    const before = node({ id: "root", completedAt: null });
    const after = node({ id: "root", completedAt: "2026-07-13T00:00:00Z" });
    const { incremental, full } = bothPaths(
      workspace([before]),
      workspace([after]),
      { changedNodes: [after], removedNodeIds: [], changedAttachments: [] }
    );
    expect(incremental).toEqual(full);
    expect(incremental.nodesById.root.completedAt).toBe("2026-07-13T00:00:00Z");
  });

  it("split: updates the source and inserts the new sibling", () => {
    const source = node({ id: "a", title: "hello world", sortKey: 1024 });
    const updated = node({ id: "a", title: "hello", sortKey: 1024 });
    const created = node({ id: "b", title: "world", sortKey: 2048 });
    const { incremental, full } = bothPaths(
      workspace([source]),
      workspace([updated, created]),
      { changedNodes: [updated, created], removedNodeIds: [], changedAttachments: [] }
    );
    expect(incremental).toEqual(full);
    expect(incremental.rootIds).toEqual(["a", "b"]);
    expect(incremental.nodesById.a.title).toBe("hello");
  });

  it("delete (soft): removes a node and its subtree that left the scope", () => {
    const root = node({ id: "root" });
    const child = node({ id: "child", parentId: "root" });
    const grand = node({ id: "grand", parentId: "child" });
    const { incremental, full } = bothPaths(
      workspace([root, child, grand]),
      workspace([root]),
      { changedNodes: [], removedNodeIds: ["child", "grand"], changedAttachments: [] }
    );
    expect(incremental).toEqual(full);
    expect(incremental.nodesById.child).toBeUndefined();
    expect(incremental.nodesById.grand).toBeUndefined();
    expect(incremental.childIdsByParent.root).toBeUndefined();
  });

  it("delete (hard): removes an emptied node's row", () => {
    const root = node({ id: "root" });
    const empty = node({ id: "empty", parentId: "root" });
    const { incremental, full } = bothPaths(
      workspace([root, empty]),
      workspace([root]),
      { changedNodes: [], removedNodeIds: ["empty"], changedAttachments: [] }
    );
    expect(incremental).toEqual(full);
    expect(incremental.childIdsByParent.root).toBeUndefined();
  });

  it("restore: re-adds a subtree that re-entered the scope", () => {
    const root = node({ id: "root" });
    const child = node({ id: "child", parentId: "root", sortKey: 1024 });
    const grand = node({ id: "grand", parentId: "child", sortKey: 1024 });
    const { incremental, full } = bothPaths(
      workspace([root]),
      workspace([root, child, grand]),
      { changedNodes: [child, grand], removedNodeIds: [], changedAttachments: [] }
    );
    expect(incremental).toEqual(full);
    expect(incremental.childIdsByParent.root).toEqual(["child"]);
    expect(incremental.childIdsByParent.child).toEqual(["grand"]);
  });

  it("attachment change: imports a new attachment into an empty list", () => {
    const root = node({ id: "root" });
    const imported = attachment({ id: "att-1", nodeId: "root", sortKey: 100 });
    const { incremental, full } = bothPaths(
      { nodes: [root] },
      { nodes: [root], attachmentsByNodeId: { root: [imported] } },
      { changedNodes: [], removedNodeIds: [], changedAttachments: [imported] }
    );
    expect(incremental).toEqual(full);
    expect(incremental.attachmentsByNodeId.root).toEqual([imported]);
  });

  it("attachment change: resizes an existing attachment in place", () => {
    const root = node({ id: "root" });
    const original = attachment({
      id: "att-1",
      nodeId: "root",
      sortKey: 100,
      displayWidth: 320
    });
    const resized = attachment({
      id: "att-1",
      nodeId: "root",
      sortKey: 100,
      displayWidth: 170
    });
    const { incremental, full } = bothPaths(
      { nodes: [root], attachmentsByNodeId: { root: [original] } },
      { nodes: [root], attachmentsByNodeId: { root: [resized] } },
      { changedNodes: [], removedNodeIds: [], changedAttachments: [resized] }
    );
    expect(incremental).toEqual(full);
    expect(incremental.attachmentsByNodeId.root[0].displayWidth).toBe(170);
  });

  it("attachment change: inserts a new attachment in sorted order", () => {
    const root = node({ id: "root" });
    const existing = attachment({ id: "att-2", nodeId: "root", sortKey: 200 });
    const inserted = attachment({ id: "att-1", nodeId: "root", sortKey: 100 });
    const { incremental, full } = bothPaths(
      { nodes: [root], attachmentsByNodeId: { root: [existing] } },
      { nodes: [root], attachmentsByNodeId: { root: [inserted, existing] } },
      { changedNodes: [], removedNodeIds: [], changedAttachments: [inserted] }
    );
    expect(incremental).toEqual(full);
    expect(incremental.attachmentsByNodeId.root.map((a) => a.id)).toEqual([
      "att-1",
      "att-2"
    ]);
  });

  it("applyWorkspaceDelta does not mutate the prior store", () => {
    const root = node({ id: "root" });
    const a = node({ id: "a", parentId: "root", sortKey: 1024 });
    const b = node({ id: "b", parentId: "root", sortKey: 2048 });
    const prior = normalizeWorkspace(workspace([root, a]));
    const priorChildrenBefore = [...prior.childIdsByParent.root];
    const patched = applyWorkspaceDelta(prior, {
      changedNodes: [b],
      removedNodeIds: [],
      changedAttachments: []
    });
    expect(prior.childIdsByParent.root).toEqual(priorChildrenBefore);
    expect(patched.childIdsByParent.root).toEqual(["a", "b"]);
    expect(Object.getPrototypeOf(patched.nodesById)).toBeNull();
    expect(Object.getPrototypeOf(patched.childIdsByParent)).toBeNull();
  });
});

describe("notesWorkspaceReducer delta transition safety", () => {
  afterEach(() => {
    setNotesDeltaVerificationEnabled(false);
    vi.restoreAllMocks();
  });

  it("full-normalizes a scope change that arrives without a delta", () => {
    const prior = normalizeWorkspace(
      workspace([
        node({ id: "a", sortKey: 1 }),
        node({ id: "b", sortKey: 2 }),
        node({ id: "c", sortKey: 3 })
      ])
    );
    const settled = notesWorkspaceReducer(prior, {
      type: "settleQueueWork",
      result: { kind: "authoritative", workspace: workspace([node({ id: "a" })]) },
      hasPendingWork: false
    });
    expect(Object.keys(settled.nodesById)).toEqual(["a"]);
    expect(settled.rootIds).toEqual(["a"]);
  });

  it("falls back to full normalization and reports a corrupt delta in dev", () => {
    setNotesDeltaVerificationEnabled(true);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const prior = normalizeWorkspace(workspace([node({ id: "root", title: "old" })]));
    const authoritativeNode = node({ id: "root", title: "RIGHT" });
    const corruptNode = node({ id: "root", title: "WRONG" });

    const settled = notesWorkspaceReducer(prior, {
      type: "settleQueueWork",
      result: {
        kind: "authoritative",
        workspace: workspace([authoritativeNode]),
        delta: {
          changedNodes: [corruptNode],
          removedNodeIds: [],
          changedAttachments: []
        }
      },
      hasPendingWork: false
    });

    expect(settled.nodesById.root.title).toBe("RIGHT");
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[1]).toMatchObject({
      nodesWithDifferentValues: ["root"]
    });
  });

  it("trusts the delta in production even when it diverges", () => {
    setNotesDeltaVerificationEnabled(false);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const prior = normalizeWorkspace(workspace([node({ id: "root", title: "old" })]));
    const settled = notesWorkspaceReducer(prior, {
      type: "settleQueueWork",
      result: {
        kind: "authoritative",
        workspace: workspace([node({ id: "root", title: "RIGHT" })]),
        delta: {
          changedNodes: [node({ id: "root", title: "WRONG" })],
          removedNodeIds: [],
          changedAttachments: []
        }
      },
      hasPendingWork: false
    });
    expect(settled.nodesById.root.title).toBe("WRONG");
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("notesSelectionReducer", () => {
  it("setSelectionAnchor starts a single-node selection", () => {
    expect(
      notesSelectionReducer(null, { type: "setSelectionAnchor", anchorId: "b" })
    ).toEqual({ anchorId: "b", headId: "b" });
  });

  it("extendSelectionTo pins the anchor and moves the head", () => {
    const anchored: NotesSelection = { anchorId: "b", headId: "b" };
    expect(
      notesSelectionReducer(anchored, { type: "extendSelectionTo", headId: "d" })
    ).toEqual({ anchorId: "b", headId: "d" });
  });

  it("extendSelectionTo with no live anchor degenerates to a single node", () => {
    expect(
      notesSelectionReducer(null, { type: "extendSelectionTo", headId: "d" })
    ).toEqual({ anchorId: "d", headId: "d" });
  });

  it("toggles visible rows into an explicit outline-ordered selection", () => {
    const visible = ["a", "b", "c", "d"];
    const anchored = notesSelectionReducer(null, {
      type: "setSelectionAnchor",
      anchorId: "b"
    });
    const added = notesSelectionReducer(anchored, {
      type: "toggleSelectionNode",
      nodeId: "d",
      visibleNodeIds: visible
    });

    expect(added).toEqual({
      anchorId: "d",
      headId: "d",
      explicitNodeIds: ["b", "d"]
    });
    expect(selectionRangeIds(added, visible)).toEqual(["b", "d"]);
  });

  it("removes a toggled row and clears the final selected row", () => {
    const visible = ["a", "b", "c"];
    const explicit: NotesSelection = {
      anchorId: "c",
      headId: "c",
      explicitNodeIds: ["a", "c"]
    };
    const removed = notesSelectionReducer(explicit, {
      type: "toggleSelectionNode",
      nodeId: "c",
      visibleNodeIds: visible
    });

    expect(selectionRangeIds(removed, visible)).toEqual(["a"]);
    expect(
      notesSelectionReducer(removed, {
        type: "toggleSelectionNode",
        nodeId: "a",
        visibleNodeIds: visible
      })
    ).toBeNull();
  });

  it("replaces an explicit selection with a Shift range", () => {
    const explicit: NotesSelection = {
      anchorId: "b",
      headId: "b",
      explicitNodeIds: ["b", "d"]
    };

    expect(
      notesSelectionReducer(explicit, {
        type: "extendSelectionTo",
        headId: "c"
      })
    ).toEqual({ anchorId: "b", headId: "c" });
  });

  it("replaceSelection atomically replaces both endpoints", () => {
    expect(
      notesSelectionReducer(
        { anchorId: "b", headId: "d" },
        {
          type: "replaceSelection",
          selection: { anchorId: "copy-1", headId: "copy-3" }
        }
      )
    ).toEqual({ anchorId: "copy-1", headId: "copy-3" });
  });

  it("replaceSelection owns an immutable copy of explicit node ids", () => {
    const explicitNodeIds = ["a", "c"];
    const replaced = notesSelectionReducer(null, {
      type: "replaceSelection",
      selection: {
        anchorId: "c",
        headId: "c",
        explicitNodeIds
      }
    });

    explicitNodeIds[0] = "mutated";
    expect(replaced).toEqual({
      anchorId: "c",
      headId: "c",
      explicitNodeIds: ["a", "c"]
    });
    expect(Object.isFrozen(replaced?.explicitNodeIds)).toBe(true);
  });

  it("replaceSelection normalizes an empty explicit selection to null", () => {
    expect(
      notesSelectionReducer(
        { anchorId: "a", headId: "b" },
        {
          type: "replaceSelection",
          selection: {
            anchorId: "c",
            headId: "c",
            explicitNodeIds: []
          }
        }
      )
    ).toBeNull();
  });

  it("replaceSelection atomically clears the range", () => {
    expect(
      notesSelectionReducer(
        { anchorId: "b", headId: "d" },
        { type: "replaceSelection", selection: null }
      )
    ).toBeNull();
  });

  it("clearSelection drops the selection", () => {
    expect(
      notesSelectionReducer({ anchorId: "b", headId: "d" }, {
        type: "clearSelection"
      })
    ).toBeNull();
  });

  it("returns the same null reference when clearing an empty selection (React bail-out)", () => {
    expect(notesSelectionReducer(null, { type: "clearSelection" })).toBeNull();
  });
});

describe("selectionRangeIds", () => {
  const visible = ["a", "b", "c", "d", "e"];

  it("returns the inclusive range when the anchor is above the head", () => {
    expect(selectionRangeIds({ anchorId: "b", headId: "d" }, visible)).toEqual([
      "b",
      "c",
      "d"
    ]);
  });

  it("returns the inclusive range when the anchor is below the head", () => {
    expect(selectionRangeIds({ anchorId: "d", headId: "b" }, visible)).toEqual([
      "b",
      "c",
      "d"
    ]);
  });

  it("returns a single id when anchor and head coincide", () => {
    expect(selectionRangeIds({ anchorId: "c", headId: "c" }, visible)).toEqual([
      "c"
    ]);
  });

  it("returns an empty range for no selection", () => {
    expect(selectionRangeIds(null, visible)).toEqual([]);
  });

  it("returns an empty range when an endpoint is not currently visible", () => {
    expect(
      selectionRangeIds({ anchorId: "b", headId: "gone" }, visible)
    ).toEqual([]);
  });
});
