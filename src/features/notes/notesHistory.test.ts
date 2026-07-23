import { describe, expect, it } from "vitest";
import type {
  NoteNode,
  NoteTagFilter,
  NotesHistoryState,
  NotesWorkspaceScope
} from "../../domain/notes";
import * as notesHistory from "./notesHistory";
import {
  createNotesExpansionSnapshotPool,
  createNotesHistoryOwnerRegistry,
  createNotesHistorySession,
  rememberAcceptedHistoryState,
  type NotesExpansionSnapshotPool,
  type NotesHistorySnapshot
} from "./notesHistory";

type ReplaySelectionNormalizer = (
  node: NoteNode,
  selection: { readonly anchorUtf16: number; readonly focusUtf16: number }
) => { readonly anchorUtf16: number; readonly focusUtf16: number };

function historyNode(overrides: Partial<NoteNode>): NoteNode {
  return {
    id: "history-node",
    nodeKind: "text",
    parentId: null,
    sortKey: 1,
    title: "A😀e\u0301",
    note: "",
    layoutMode: "bullets",
    isCollapsed: false,
    isStarred: false,
    completedAt: null,
    createdAt: "2026-07-18T00:00:00Z",
    updatedAt: "2026-07-18T00:00:00Z",
    deletedAt: null,
    archivedAt: null,
    archiveRootId: null,
    imageOffsetUtf16: 0,
    ...overrides,
    markerKind: overrides.markerKind ?? "bullet",
    markdownImageWidth: overrides.markdownImageWidth ?? null
  };
}

function idFactory(): () => string {
  let index = 0;
  return () => `10000000-0000-4000-8000-${String(index++).padStart(12, "0")}`;
}

function historyState(
  nextUndoEntryId: string | null = null,
  nextRedoEntryId: string | null = null,
  prunedEntryIds: string[] = [],
  historyEpoch = "epoch-a"
): NotesHistoryState {
  return {
    canUndo: nextUndoEntryId !== null,
    canRedo: nextRedoEntryId !== null,
    historyEpoch,
    nextUndoEntryId,
    nextRedoEntryId,
    prunedEntryIds
  };
}

function libraryState(scope: NotesWorkspaceScope): {
  libraryView: NotesHistorySnapshot["libraryView"];
  activeTagFilters: readonly NoteTagFilter[];
} {
  switch (scope.kind) {
    case "active":
      return { libraryView: "all", activeTagFilters: [] };
    case "starred":
    case "recent":
    case "archive":
    case "trash":
      return { libraryView: scope.kind, activeTagFilters: [] };
    case "tag":
      return { libraryView: "tags", activeTagFilters: [] };
    case "tags":
      return { libraryView: "tags", activeTagFilters: scope.tags };
  }
}

function snapshot(
  pool: NotesExpansionSnapshotPool,
  selectedId: string | null,
  options: {
    field?: "title" | "note";
    primarySelection?: { anchorUtf16: number; focusUtf16: number };
    scope?: NotesWorkspaceScope;
    expanded?: readonly string[];
  } = {}
): NotesHistorySnapshot {
  const scope = options.scope ?? { kind: "active" };
  return {
    scope,
    ...libraryState(scope),
    selectedId,
    zoomRootId: selectedId,
    expansion: pool.acquire(options.expanded ?? (selectedId ? [selectedId] : [])),
    focus: selectedId
      ? {
          nodeId: selectedId,
          field: options.field ?? "title",
          ...(options.primarySelection
            ? { primarySelection: options.primarySelection }
            : {})
        }
      : null
  };
}

function boundHistory(options: {
  maxEntries?: number;
  pool?: NotesExpansionSnapshotPool;
} = {}) {
  const expansionPool = options.pool ?? createNotesExpansionSnapshotPool();
  const history = createNotesHistorySession({
    createId: idFactory(),
    expansionPool,
    maxEntries: options.maxEntries
  });
  history.bindInitialization(historyState());
  return { history, expansionPool };
}

describe("notes history session", () => {
  it("normalizes replay selections without changing valid UTF-16 direction", () => {
    const normalize = (
      notesHistory as typeof notesHistory & {
        normalizeHistoryPrimarySelection?: ReplaySelectionNormalizer;
      }
    ).normalizeHistoryPrimarySelection;
    expect(normalize).toEqual(expect.any(Function));
    if (!normalize) return;

    const text = historyNode({ title: "A😀e\u0301" });
    const image = historyNode({
      nodeKind: "image",
      title: "A😀B",
      imageOffsetUtf16: 3
    });
    const reverse = { anchorUtf16: 4, focusUtf16: 1 };
    const staleFocus = { anchorUtf16: 4, focusUtf16: 2 };
    const outOfRange = { anchorUtf16: -1, focusUtf16: 99 };

    expect(normalize(text, reverse)).toEqual(reverse);
    expect(normalize(image, { anchorUtf16: 3, focusUtf16: 4 })).toEqual({
      anchorUtf16: 3,
      focusUtf16: 4
    });
    expect(normalize(text, staleFocus)).toEqual({
      anchorUtf16: 1,
      focusUtf16: 1
    });
    expect(normalize(text, outOfRange)).toEqual({
      anchorUtf16: 5,
      focusUtf16: 5
    });
    expect(normalize(text, { anchorUtf16: 3, focusUtf16: 4 })).toEqual({
      anchorUtf16: 3,
      focusUtf16: 4
    });
    expect(normalize(text, { anchorUtf16: 4, focusUtf16: Number.NEGATIVE_INFINITY })).toEqual({
      anchorUtf16: 0,
      focusUtf16: 0
    });
    expect(normalize(text, { anchorUtf16: 4, focusUtf16: Number.NaN })).toEqual({
      anchorUtf16: 0,
      focusUtf16: 0
    });
    expect(normalize(text, { anchorUtf16: 4, focusUtf16: 2.5 })).toEqual({
      anchorUtf16: 3,
      focusUtf16: 3
    });
    expect(normalize(image, { anchorUtf16: 4, focusUtf16: Number.NEGATIVE_INFINITY })).toEqual({
      anchorUtf16: 0,
      focusUtf16: 0
    });
    expect(normalize(image, { anchorUtf16: 4, focusUtf16: Number.NaN })).toEqual({
      anchorUtf16: 0,
      focusUtf16: 0
    });
    expect(normalize(image, { anchorUtf16: 4, focusUtf16: 2.5 })).toEqual({
      anchorUtf16: 3,
      focusUtf16: 3
    });
    expect(staleFocus).toEqual({ anchorUtf16: 4, focusUtf16: 2 });
    expect(outOfRange).toEqual({ anchorUtf16: -1, focusUtf16: 99 });
  });

  it("deep-clones structural primary selections for replay", () => {
    const { history, expansionPool } = boundHistory();
    const primarySelection = { anchorUtf16: 2, focusUtf16: 5 };
    const before = snapshot(expansionPool, "image", { primarySelection });
    const entry = history.beginStructuralEntry("remove-image", before);

    primarySelection.anchorUtf16 = 99;
    expect(
      history.acceptMutationResult(
        entry.entryId,
        snapshot(expansionPool, "image", {
          primarySelection: { anchorUtf16: 1, focusUtf16: 1 }
        }),
        historyState(entry.entryId)
      ).accepted
    ).toBe(true);

    expect(history.snapshotForReplay(entry.entryId, "undo")?.focus).toEqual({
      nodeId: "image",
      field: "title",
      primarySelection: { anchorUtf16: 2, focusUtf16: 5 }
    });
  });

  it("does not add primary selections to ordinary text bursts", () => {
    const { history, expansionPool } = boundHistory();
    const entry = history.beginTextBurst("text", snapshot(expansionPool, "text"));
    history.acceptMutationResult(
      entry.entryId,
      snapshot(expansionPool, "text"),
      historyState(entry.entryId)
    );

    expect(history.snapshotForReplay(entry.entryId, "undo")?.focus).toEqual({
      nodeId: "text",
      field: "title"
    });
  });

  it("keeps structural replay selections isolated from ordinary text bursts", () => {
    const { history, expansionPool } = boundHistory();
    const structural = history.beginStructuralEntry(
      "imageAtomEdit",
      snapshot(expansionPool, "image", {
        primarySelection: { anchorUtf16: 4, focusUtf16: 1 }
      })
    );
    history.acceptMutationResult(
      structural.entryId,
      snapshot(expansionPool, "image", {
        primarySelection: { anchorUtf16: 2, focusUtf16: 2 }
      }),
      historyState(structural.entryId)
    );

    const text = history.beginTextBurst(
      "text",
      snapshot(expansionPool, "text")
    );
    history.acceptMutationResult(
      text.entryId,
      snapshot(expansionPool, "text"),
      historyState(text.entryId)
    );

    expect(history.snapshotForReplay(structural.entryId, "undo")?.focus)
      .toMatchObject({
        primarySelection: { anchorUtf16: 4, focusUtf16: 1 }
      });
    expect(history.snapshotForReplay(text.entryId, "undo")?.focus).toEqual({
      nodeId: "text",
      field: "title"
    });
  });

  it("rejects public history access until initialization binds an epoch", () => {
    const history = createNotesHistorySession({ createId: idFactory() });
    const pool = createNotesExpansionSnapshotPool();

    expect(() => history.historyEpoch).toThrow("not initialized");
    expect(() => history.beginTextBurst("node-a", snapshot(pool, "node-a"))).toThrow(
      "not initialized"
    );
  });

  it("binds and resets the epoch used by every new history context", () => {
    const pool = createNotesExpansionSnapshotPool();
    const history = createNotesHistorySession({
      createId: idFactory(),
      expansionPool: pool
    });
    history.bindInitialization(historyState(null, null, [], "epoch-a"));

    const first = history.beginTextBurst("node-a", snapshot(pool, "node-a"));
    expect(first.historyEpoch).toBe("epoch-a");

    history.reset("epoch-b");
    expect(history.canUndo()).toBe(false);
    expect(history.beginStructuralEntry("move", snapshot(pool, "node-a"))).toMatchObject({
      sessionId: history.sessionId,
      historyEpoch: "epoch-b",
      commandKind: "move"
    });
  });

  it("undoes edit, navigation, edit in reverse chronological order", () => {
    const { history, expansionPool } = boundHistory();
    const firstMutation = history.beginStructuralEntry(
      "edit",
      snapshot(expansionPool, "a")
    );
    expect(
      history.acceptMutationResult(
        firstMutation.entryId,
        snapshot(expansionPool, "a"),
        historyState(firstMutation.entryId)
      ).accepted
    ).toBe(true);
    history.appendNavigation(
      snapshot(expansionPool, "a"),
      snapshot(expansionPool, "b")
    );
    const secondMutation = history.beginStructuralEntry(
      "edit",
      snapshot(expansionPool, "b")
    );
    expect(
      history.acceptMutationResult(
        secondMutation.entryId,
        snapshot(expansionPool, "b"),
        historyState(secondMutation.entryId)
      ).accepted
    ).toBe(true);

    expect(history.next("undo")).toMatchObject({
      kind: "mutation",
      entryId: secondMutation.entryId
    });
    expect(
      history.acceptReplayResult(
        historyState(firstMutation.entryId, secondMutation.entryId),
        "undo",
        secondMutation.entryId
      )
    ).toBe(true);
    expect(history.next("undo")?.kind).toBe("navigation");
    history.commitReplay("undo");
    expect(history.next("undo")).toMatchObject({
      kind: "mutation",
      entryId: firstMutation.entryId
    });
  });

  it("coalesces one field burst and closes it across navigation", () => {
    const { history, expansionPool } = boundHistory();
    const first = history.beginTextBurst("a", snapshot(expansionPool, "a"));
    expect(
      history.acceptMutationResult(
        first.entryId,
        snapshot(expansionPool, "a", { field: "note" }),
        historyState(first.entryId)
      ).accepted
    ).toBe(true);
    const continued = history.beginTextBurst("a", snapshot(expansionPool, "a"));
    history.acceptMutationResult(
      continued.entryId,
      snapshot(expansionPool, "a", { scope: { kind: "starred" } }),
      historyState(first.entryId)
    );

    expect(continued.entryId).toBe(first.entryId);
    expect(history.next("undo")).toMatchObject({
      kind: "mutation",
      entryId: first.entryId,
      after: { scope: { kind: "starred" } }
    });

    history.appendNavigation(
      snapshot(expansionPool, "a"),
      snapshot(expansionPool, "b")
    );
    const next = history.beginTextBurst("a", snapshot(expansionPool, "a"));
    expect(next.entryId).not.toBe(first.entryId);
  });

  it("releases committed text-burst metadata on close without losing a pre-close result", () => {
    const { history, expansionPool } = boundHistory();
    const committed = history.beginTextBurst("a", snapshot(expansionPool, "a"));
    expect(
      history.acceptMutationResult(
        committed.entryId,
        snapshot(expansionPool, "a"),
        historyState(committed.entryId)
      ).accepted
    ).toBe(true);
    history.closeTextBurst(committed.entryId);

    expect(
      history.acceptMutationResult(
        committed.entryId,
        snapshot(expansionPool, "a"),
        historyState(committed.entryId)
      ).accepted
    ).toBe(false);

    const inFlight = history.beginTextBurst("b", snapshot(expansionPool, "b"));
    history.closeTextBurst(inFlight.entryId);
    expect(
      history.acceptMutationResult(
        inFlight.entryId,
        snapshot(expansionPool, "b"),
        historyState(inFlight.entryId)
      ).accepted
    ).toBe(true);
  });

  it("trims the oldest mixed action at entry 101 and returns only its mutation id", () => {
    const { history, expansionPool } = boundHistory({ maxEntries: 100 });
    const first = history.beginStructuralEntry(
      "edit",
      snapshot(expansionPool, "first")
    );
    history.acceptMutationResult(
      first.entryId,
      snapshot(expansionPool, "first"),
      historyState(first.entryId)
    );

    let unreachable: readonly string[] = [];
    for (let index = 0; index < 100; index += 1) {
      unreachable = history.appendNavigation(
        snapshot(expansionPool, `before-${index}`),
        snapshot(expansionPool, `after-${index}`)
      );
    }

    expect(unreachable).toEqual([first.entryId]);
    for (let index = 0; index < 100; index += 1) {
      expect(history.next("undo")?.kind).toBe("navigation");
      history.commitReplay("undo");
    }
    expect(history.next("undo")).toBeNull();
  });

  it("projects a mutation append before validating backend neighbors", () => {
    const { history, expansionPool } = boundHistory();
    const mutation = history.beginStructuralEntry(
      "edit",
      snapshot(expansionPool, "a")
    );

    const accepted = history.acceptMutationResult(
      mutation.entryId,
      snapshot(expansionPool, "b"),
      historyState(mutation.entryId)
    );

    expect(accepted).toEqual({ accepted: true, unreachableEntryIds: [] });
    expect(history.next("undo")).toMatchObject({ entryId: mutation.entryId });
  });

  it("leaves the timeline unchanged when either projected backend neighbor mismatches", () => {
    const { history, expansionPool } = boundHistory();
    const first = history.beginStructuralEntry(
      "edit",
      snapshot(expansionPool, "a")
    );
    history.acceptMutationResult(
      first.entryId,
      snapshot(expansionPool, "a"),
      historyState(first.entryId)
    );
    const second = history.beginStructuralEntry(
      "edit",
      snapshot(expansionPool, "b")
    );

    expect(
      history.acceptMutationResult(
        second.entryId,
        snapshot(expansionPool, "b"),
        historyState(second.entryId, "unexpected-redo")
      ).accepted
    ).toBe(false);
    expect(history.next("undo")).toMatchObject({ entryId: first.entryId });
  });

  it("projects the replay cursor move before validating backend neighbors", () => {
    const { history, expansionPool } = boundHistory();
    const first = history.beginStructuralEntry(
      "edit",
      snapshot(expansionPool, "a")
    );
    history.acceptMutationResult(
      first.entryId,
      snapshot(expansionPool, "a"),
      historyState(first.entryId)
    );
    const second = history.beginStructuralEntry(
      "edit",
      snapshot(expansionPool, "b")
    );
    history.acceptMutationResult(
      second.entryId,
      snapshot(expansionPool, "b"),
      historyState(second.entryId)
    );

    expect(
      history.acceptReplayResult(
        historyState(first.entryId, second.entryId),
        "undo",
        second.entryId
      )
    ).toBe(true);
    expect(history.next("redo")).toMatchObject({ entryId: second.entryId });
  });

  it("clamps applied-side pruning without exposing actions before the removed mutation", () => {
    const { history, expansionPool } = boundHistory();
    const first = history.beginStructuralEntry(
      "edit",
      snapshot(expansionPool, "a")
    );
    history.acceptMutationResult(
      first.entryId,
      snapshot(expansionPool, "a"),
      historyState(first.entryId)
    );
    history.appendNavigation(
      snapshot(expansionPool, "a"),
      snapshot(expansionPool, "b")
    );
    const second = history.beginStructuralEntry(
      "edit",
      snapshot(expansionPool, "b")
    );
    history.acceptMutationResult(
      second.entryId,
      snapshot(expansionPool, "b"),
      historyState(second.entryId)
    );

    expect(
      history.acceptReplayResult(
        historyState(null, second.entryId, [first.entryId]),
        "undo",
        second.entryId
      )
    ).toBe(true);
    expect(history.next("undo")?.kind).toBe("navigation");
    history.commitReplay("undo");
    expect(history.next("undo")).toBeNull();
  });

  it("excludes the already-pruned redo suffix from later cleanup", () => {
    const { history, expansionPool } = boundHistory();
    const first = history.beginStructuralEntry(
      "edit",
      snapshot(expansionPool, "a")
    );
    history.acceptMutationResult(
      first.entryId,
      snapshot(expansionPool, "a"),
      historyState(first.entryId)
    );
    const second = history.beginStructuralEntry(
      "edit",
      snapshot(expansionPool, "b")
    );
    history.acceptMutationResult(
      second.entryId,
      snapshot(expansionPool, "b"),
      historyState(second.entryId)
    );
    history.acceptReplayResult(
      historyState(first.entryId, second.entryId),
      "undo",
      second.entryId
    );
    const replacement = history.beginStructuralEntry(
      "edit",
      snapshot(expansionPool, "c")
    );

    expect(
      history.acceptMutationResult(
        replacement.entryId,
        snapshot(expansionPool, "c"),
        historyState(replacement.entryId, null, [second.entryId])
      )
    ).toEqual({ accepted: true, unreachableEntryIds: [] });
    expect(history.next("undo")).toMatchObject({ entryId: replacement.entryId });
    expect(history.canRedo()).toBe(false);
  });

  it("validates prepared navigation against the complete redo suffix", () => {
    const { history, expansionPool } = boundHistory();
    const first = history.beginStructuralEntry(
      "edit",
      snapshot(expansionPool, "a")
    );
    history.acceptMutationResult(
      first.entryId,
      snapshot(expansionPool, "a"),
      historyState(first.entryId)
    );
    const second = history.beginStructuralEntry(
      "edit",
      snapshot(expansionPool, "b")
    );
    history.acceptMutationResult(
      second.entryId,
      snapshot(expansionPool, "b"),
      historyState(second.entryId)
    );
    history.acceptReplayResult(
      historyState(first.entryId, second.entryId),
      "undo",
      second.entryId
    );

    expect(history.unreachableRedoMutationIds()).toEqual([second.entryId]);
    expect(
      history.acceptPreparedNavigation(
        historyState(first.entryId, null, [second.entryId]),
        [second.entryId]
      )
    ).toBe(true);
    expect(
      history.appendNavigation(
        snapshot(expansionPool, "a"),
        snapshot(expansionPool, "elsewhere")
      )
    ).toEqual([]);
    expect(history.canRedo()).toBe(false);
  });

  it("keeps invalidated redo local until navigation append while committing backend floor pruning", () => {
    const { history, expansionPool } = boundHistory();
    const first = history.beginStructuralEntry(
      "edit",
      snapshot(expansionPool, "first")
    );
    history.acceptMutationResult(
      first.entryId,
      snapshot(expansionPool, "first"),
      historyState(first.entryId)
    );
    history.appendNavigation(
      snapshot(expansionPool, "first"),
      snapshot(expansionPool, "between")
    );
    const second = history.beginStructuralEntry(
      "edit",
      snapshot(expansionPool, "second")
    );
    history.acceptMutationResult(
      second.entryId,
      snapshot(expansionPool, "second"),
      historyState(second.entryId)
    );
    history.acceptReplayResult(
      historyState(first.entryId, second.entryId),
      "undo",
      second.entryId
    );
    history.commitReplay("undo");

    expect(history.unreachableRedoMutationIds()).toEqual([second.entryId]);
    expect(
      history.acceptPreparedNavigation(
        historyState(null, null, [
          first.entryId,
          second.entryId
        ]),
        [second.entryId]
      )
    ).toBe(true);
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);
    expect(history.unreachableRedoMutationIds()).toEqual([second.entryId]);
    expect(
      history.appendNavigation(
        snapshot(expansionPool, "before"),
        snapshot(expansionPool, "after")
      )
    ).toEqual([]);
    expect(history.canRedo()).toBe(false);
  });

  it("bounds compatibility rememberAfter history and releases evicted snapshots", () => {
    const { history, expansionPool } = boundHistory({ maxEntries: 2 });
    const beforeSnapshots: NotesHistorySnapshot[] = [];
    const entryIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const before = snapshot(expansionPool, `before-${index}`);
      beforeSnapshots.push(before);
      const entry = history.beginStructuralEntry("legacy", before);
      entryIds.push(entry.entryId);
      history.rememberAfter(
        entry.entryId,
        snapshot(expansionPool, `after-${index}`)
      );
    }

    expect(history.snapshotCount()).toBe(2);
    expect(history.snapshotForReplay(entryIds[0]!, "undo")).toBeNull();
    const reclaimed = expansionPool.acquire(["before-0"]);
    expect(reclaimed).not.toBe(beforeSnapshots[0]!.expansion);
    expansionPool.release(reclaimed);

    history.clearSnapshots();
    expect(expansionPool.size()).toBe(0);
  });

  it("keeps a legacy text entry before snapshot alive when replacing its after snapshot", () => {
    const { history, expansionPool } = boundHistory();
    const before = snapshot(expansionPool, "before", {
      expanded: ["before-expansion"]
    });
    const entry = history.beginTextBurst("node", before);
    const firstAfter = snapshot(expansionPool, "first", {
      expanded: ["first-after-expansion"]
    });
    history.rememberAfter(entry.entryId, firstAfter);
    const secondAfter = snapshot(expansionPool, "second", {
      expanded: ["second-after-expansion"]
    });
    history.rememberAfter(entry.entryId, secondAfter);

    expect(history.snapshotForReplay(entry.entryId, "undo")?.expansion).toBe(
      before.expansion
    );
    const liveBefore = expansionPool.acquire(["before-expansion"]);
    expect(liveBefore).toBe(before.expansion);
    expansionPool.release(liveBefore);
    const releasedFirstAfter = expansionPool.acquire(["first-after-expansion"]);
    expect(releasedFirstAfter).not.toBe(firstAfter.expansion);
    expansionPool.release(releasedFirstAfter);
    const liveSecondAfter = expansionPool.acquire(["second-after-expansion"]);
    expect(liveSecondAfter).toBe(secondAfter.expansion);
    expansionPool.release(liveSecondAfter);

    history.reset("epoch-b");
    const releasedBefore = expansionPool.acquire(["before-expansion"]);
    expect(releasedBefore).not.toBe(before.expansion);
    expansionPool.release(releasedBefore);
    const releasedSecondAfter = expansionPool.acquire(["second-after-expansion"]);
    expect(releasedSecondAfter).not.toBe(secondAfter.expansion);
    expansionPool.release(releasedSecondAfter);
    expect(expansionPool.size()).toBe(0);
  });

  it("reuses semantic expansion revisions and releases timeline ownership", () => {
    const expansionPool = createNotesExpansionSnapshotPool();
    const { history } = boundHistory({ pool: expansionPool });
    const first = snapshot(expansionPool, "a", { expanded: ["b", "a", "a"] });
    const second = snapshot(expansionPool, "b", { expanded: ["a", "b"] });

    expect(first.expansion).toBe(second.expansion);
    expect(first.expansion.nodeIds).toEqual(["a", "b"]);
    history.appendNavigation(first, second);
    expect(expansionPool.size()).toBe(1);

    history.reset("epoch-b");
    expect(expansionPool.size()).toBe(0);
  });

  it("retains main and tag-origin revisions as independent snapshot owners", () => {
    const expansionPool = createNotesExpansionSnapshotPool();
    const { history } = boundHistory({ pool: expansionPool });
    const before = snapshot(expansionPool, "a", { expanded: ["shared"] });
    before.tagFilterOrigin = {
      ...snapshot(expansionPool, "origin", { expanded: ["shared"] }),
      libraryView: "all",
      activeTagFilters: []
    };
    const after = snapshot(expansionPool, "b", { expanded: ["shared"] });

    history.appendNavigation(before, after);
    expect(expansionPool.size()).toBe(1);
    history.reset("epoch-b");
    expect(expansionPool.size()).toBe(0);
  });

  it("keeps accepted backend states isolated by live session context and drains them", () => {
    const firstPool = createNotesExpansionSnapshotPool();
    const secondPool = createNotesExpansionSnapshotPool();
    const firstIds = ["session-a", "shared-entry"];
    const secondIds = ["session-b", "shared-entry"];
    const first = createNotesHistorySession({
      createId: () => firstIds.shift() ?? "unexpected",
      expansionPool: firstPool
    });
    const second = createNotesHistorySession({
      createId: () => secondIds.shift() ?? "unexpected",
      expansionPool: secondPool
    });
    first.bindInitialization(historyState());
    second.bindInitialization(historyState());
    const firstContext = first.beginStructuralEntry(
      "edit",
      snapshot(firstPool, "first")
    );
    const secondContext = second.beginStructuralEntry(
      "edit",
      snapshot(secondPool, "second")
    );

    expect(firstContext.entryId).toBe(secondContext.entryId);
    rememberAcceptedHistoryState(
      firstContext,
      historyState(firstContext.entryId)
    );
    rememberAcceptedHistoryState(
      secondContext,
      historyState(null, secondContext.entryId, [], "epoch-a")
    );

    expect(first.takeAcceptedMutationState(firstContext.entryId)).toEqual(
      historyState(firstContext.entryId)
    );
    expect(second.takeAcceptedMutationState(secondContext.entryId)).toEqual(
      historyState(null, secondContext.entryId)
    );
    expect(first.takeAcceptedMutationState(firstContext.entryId)).toBeUndefined();

    rememberAcceptedHistoryState(
      firstContext,
      historyState(firstContext.entryId)
    );
    first.discard(firstContext.entryId);
    expect(first.takeAcceptedMutationState(firstContext.entryId)).toBeUndefined();
  });

  it("bounds completed owners without evicting in-flight metadata", () => {
    const owners = createNotesHistoryOwnerRegistry<string>(2);
    owners.begin("one", "owner");
    owners.begin("two", "owner");
    owners.begin("three", "owner");

    owners.complete("one");
    owners.complete("two");
    owners.complete("three");
    expect(owners.size()).toBe(2);
    expect(owners.owner("one")).toBeUndefined();

    for (let index = 0; index < 300; index += 1) {
      const entryId = `failed-${index}`;
      owners.begin(entryId, "owner");
      owners.discard(entryId);
    }
    expect(owners.size()).toBe(2);
  });
});
