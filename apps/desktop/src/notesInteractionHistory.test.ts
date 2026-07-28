import {
  NotesInteractionHistory,
  type InteractionHistoryStore
} from "./notesInteractionHistory";

interface Location {
  readonly pageId: string;
  readonly zoomRootId: string | null;
}

function store() {
  const listeners = new Set<
    Parameters<InteractionHistoryStore["subscribeHistory"]>[0]
  >();
  const value: InteractionHistoryStore & {
    readonly emitMutation: () => void;
  } = {
    flushAllDrafts: vi.fn().mockResolvedValue(undefined),
    undo: vi.fn().mockResolvedValue(undefined),
    redo: vi.fn().mockResolvedValue(undefined),
    breakHistoryGroup: vi.fn(),
    subscribeHistory(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => ({
      canUndo: true,
      canRedo: true
    }),
    emitMutation: () => listeners.forEach((listener) => listener({
      kind: "recordMutation",
      undoDepth: 1,
      redoDepth: 0
    }))
  };
  return value;
}

describe("notes interaction history", () => {
  it("restores a navigation location locally without replaying SQLite", async () => {
    const notesStore = store();
    const apply = vi.fn().mockResolvedValue(undefined);
    const history = new NotesInteractionHistory<Location>(notesStore, apply);
    const before = { pageId: "page", zoomRootId: null };
    const after = { pageId: "page", zoomRootId: "child" };

    history.recordNavigation(before, after);
    await history.undo();
    await history.redo();

    expect(apply).toHaveBeenNthCalledWith(1, before);
    expect(apply).toHaveBeenNthCalledWith(2, after);
    expect(notesStore.undo).not.toHaveBeenCalled();
    expect(notesStore.redo).not.toHaveBeenCalled();
    expect(notesStore.breakHistoryGroup).toHaveBeenCalledOnce();
  });

  it("interleaves navigation and mutation entries in user order", async () => {
    const notesStore = store();
    const apply = vi.fn().mockResolvedValue(undefined);
    const history = new NotesInteractionHistory<Location>(notesStore, apply);
    const before = { pageId: "page", zoomRootId: null };
    const after = { pageId: "page", zoomRootId: "child" };
    notesStore.emitMutation();
    history.recordNavigation(before, after);
    notesStore.emitMutation();

    await history.undo();
    await history.undo();
    await history.undo();
    await history.redo();
    await history.redo();
    await history.redo();

    expect(notesStore.undo).toHaveBeenCalledTimes(2);
    expect(notesStore.redo).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenNthCalledWith(1, before);
    expect(apply).toHaveBeenNthCalledWith(2, after);
  });

  it("records a draft flushed immediately before Undo as the newest entry", async () => {
    const notesStore = store();
    notesStore.flushAllDrafts = vi.fn(async () => notesStore.emitMutation());
    const history = new NotesInteractionHistory<Location>(
      notesStore,
      vi.fn().mockResolvedValue(undefined)
    );
    history.recordNavigation(
      { pageId: "page", zoomRootId: null },
      { pageId: "page", zoomRootId: "child" }
    );

    await history.undo();

    expect(notesStore.undo).toHaveBeenCalledOnce();
  });
});
