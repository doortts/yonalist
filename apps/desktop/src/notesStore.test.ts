import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "./api";
import type { ViewportPage } from "../../../packages/contracts/generated/ViewportPage";
import { NotesStore } from "./notesStore";

function bullet(id: string, sortKey: number): NoteView {
  return {
    id,
    parentId: "page-1",
    sortKey,
    kind: "bullet", image: null,
    text: id,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

const boot: BootSnapshot = {
  sessionId: "session-1",
  revision: 1,
  activePageId: "page-1",
  pages: [{ id: "page-1", title: "Today" }],
  viewport: {
    pageId: "page-1",
    anchorId: null,
    beforeCursor: null,
    afterCursor: "r:1:o:2",
    nodes: [bullet("one", 1024), bullet("two", 2048)]
  },
  history: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
};

function api(queryViewport: NotesApi["queryViewport"]): NotesApi {
  return {
    bootstrap: vi.fn().mockResolvedValue(boot),
    queryViewport,
    queryForest: vi.fn().mockResolvedValue({
      revision: boot.revision,
      nodes: [],
      complete: true
    }),
    execute: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    search: vi.fn(),
    closeSession: vi.fn()
  };
}

describe("NotesStore projection invalidation", () => {
  it("publishes a draft only to its owning node projection", async () => {
    const store = new NotesStore(api(vi.fn()));
    await store.bootstrap();
    const shellBefore = store.getShellSnapshot();
    const outlineBefore = store.getOutlineSnapshot();
    const shell = vi.fn();
    const outline = vi.fn();
    const changed = vi.fn();
    const adjacent = vi.fn();
    store.subscribeShell(shell);
    store.subscribeOutline(outline);
    store.subscribeNode("one", changed);
    store.subscribeNode("two", adjacent);

    store.setDraft("one", "Draft one");

    expect(store.getShellSnapshot()).toBe(shellBefore);
    expect(store.getOutlineSnapshot()).toBe(outlineBefore);
    expect(store.getNodeSnapshot("one").title).toBe("Draft one");
    expect(changed).toHaveBeenCalledOnce();
    expect(adjacent).not.toHaveBeenCalled();
    expect(shell).not.toHaveBeenCalled();
    expect(outline).not.toHaveBeenCalled();
  });

  it("keeps the outline projection stable for a text-only receipt", async () => {
    const notesApi = api(vi.fn());
    notesApi.execute = vi.fn().mockResolvedValue({
      revision: 2,
      changedNodes: [{ ...bullet("one", 1_024), text: "Committed one" }],
      deletedIds: [],
      history: {
        canUndo: true,
        canRedo: false,
        undoDepth: 1,
        redoDepth: 0
      }
    });
    const store = new NotesStore(notesApi);
    await store.bootstrap();
    const outlineBefore = store.getOutlineSnapshot();
    const outline = vi.fn();
    const changed = vi.fn();
    store.subscribeOutline(outline);
    store.subscribeNode("one", changed);

    store.setDraft("one", "Committed one");
    await store.flushDraft("one");

    expect(store.getOutlineSnapshot()).toBe(outlineBefore);
    expect(outline).not.toHaveBeenCalled();
    expect(store.getNodeSnapshot("one").title).toBe("Committed one");
    expect(changed).toHaveBeenCalled();
  });
});

describe("NotesStore viewport recovery", () => {
  it("coalesces one typing group and fences it after navigation", async () => {
    const notesApi = api(vi.fn());
    let call = 0;
    notesApi.execute = vi.fn().mockImplementation(async (envelope) => {
      call += 1;
      const text = envelope.command.kind === "updateText"
        ? envelope.command.text
        : "one";
      return {
        revision: call + 1,
        changedNodes: [{ ...bullet("one", 1024), text }],
        deletedIds: [],
        history: {
          canUndo: true,
          canRedo: false,
          undoDepth: call < 3 ? 1 : 2,
          redoDepth: 0
        }
      };
    });
    const store = new NotesStore(notesApi);
    const historyListener = vi.fn();
    store.subscribeHistory(historyListener);
    await store.bootstrap();

    store.setDraft("one", "First");
    await store.flushDraft("one");
    store.setDraft("one", "Second");
    await store.flushDraft("one");
    store.breakHistoryGroup();
    store.setDraft("one", "Third");
    await store.flushDraft("one");

    expect(historyListener).toHaveBeenCalledTimes(2);
    expect(vi.mocked(notesApi.execute).mock.calls.map(
      ([envelope]) => envelope.historyGroup
    )).toEqual(["text:one", "text:one", "text:one:1"]);
  });

  it("keeps every native deletion from one held Backspace gesture in one history group", async () => {
    const notesApi = api(vi.fn());
    let revision = 1;
    notesApi.execute = vi.fn().mockImplementation(async (envelope) => {
      revision += 1;
      if (envelope.command.kind !== "updateText") {
        throw new Error("expected updateText");
      }
      return {
        revision,
        changedNodes: [{
          ...bullet("one", 1_024),
          text: envelope.command.text
        }],
        deletedIds: [],
        history: {
          canUndo: true,
          canRedo: false,
          undoDepth: revision === 2 ? 1 : revision === 3 ? 1 : 2,
          redoDepth: 0
        }
      };
    });
    const store = new NotesStore(notesApi);
    await store.bootstrap();

    const firstGroup = store.beginBackspaceGesture(false);
    store.setDraft("one", "on");
    await store.flushDraft("one");
    const repeatGroup = store.beginBackspaceGesture(true);
    store.setDraft("one", "o");
    await store.flushDraft("one");
    store.endBackspaceGesture();

    const nextGroup = store.beginBackspaceGesture(false);
    store.setDraft("one", "");
    await store.flushDraft("one");
    store.endBackspaceGesture();

    expect(firstGroup).toBe(repeatGroup);
    expect(nextGroup).not.toBe(firstGroup);
    const submittedGroups = vi.mocked(notesApi.execute).mock.calls.map(
      ([envelope]) => envelope.historyGroup
    );
    expect(submittedGroups[0]).toBe(submittedGroups[1]);
    expect(submittedGroups[2]).not.toBe(submittedGroups[0]);
  });

  it("recovers a stale cursor around the last visible node and removes overlap", async () => {
    const queryViewport = vi.fn()
      .mockRejectedValueOnce({
        code: "revision_conflict",
        message: "viewport cursor revision is stale",
        retryable: true
      })
      .mockResolvedValueOnce({
        pageId: "page-1",
        anchorId: "two",
        beforeCursor: null,
        afterCursor: "r:2:o:3",
        nodes: [bullet("two", 2048), bullet("three", 3072)]
      });
    const store = new NotesStore(api(queryViewport));

    await store.bootstrap();
    await store.loadMore();

    expect(queryViewport).toHaveBeenNthCalledWith(2, {
      pageId: "page-1",
      anchorId: "two",
      beforeCursor: null,
      afterCursor: null,
      limit: 80
    });
    expect(store.getSnapshot().nodes.map((node) => node.id)).toEqual([
      "one",
      "two",
      "three"
    ]);
    expect(store.getSnapshot().afterCursor).toBe("r:2:o:3");
    expect(store.getSnapshot().error).toBeNull();
  });

  it("reorders the local outline from structural mutation patches", async () => {
    const notesApi = api(vi.fn());
    notesApi.execute = vi.fn().mockResolvedValue({
      revision: 2,
      changedNodes: [bullet("two", 512)],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });
    const store = new NotesStore(notesApi);

    await store.bootstrap();
    await store.moveNode("two", "page-1", "one");

    expect(store.getSnapshot().nodes.map((node) => node.id)).toEqual([
      "two",
      "one"
    ]);
  });

  it("applies confirmed collapse state through one semantic command", async () => {
    const notesApi = api(vi.fn());
    notesApi.execute = vi.fn().mockResolvedValue({
      revision: 2,
      changedNodes: [{ ...bullet("one", 1024), collapsed: true }],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });
    const store = new NotesStore(notesApi);

    await store.bootstrap();
    await store.setCollapsed("one", true);

    expect(notesApi.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: { kind: "setCollapsed", id: "one", collapsed: true }
    }));
    expect(store.getSnapshot().nodes[0].collapsed).toBe(true);
  });

  it("sends one command for batch completion and one command for batch deletion", async () => {
    const notesApi = api(vi.fn());
    notesApi.execute = vi.fn()
      .mockResolvedValueOnce({
        revision: 2,
        changedNodes: [
          { ...bullet("one", 1024), completed: true },
          { ...bullet("two", 2048), completed: true }
        ],
        deletedIds: [],
        history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
      })
      .mockResolvedValueOnce({
        revision: 3,
        changedNodes: [
          { ...bullet("one", 1024), deleted: true },
          { ...bullet("two", 2048), deleted: true }
        ],
        deletedIds: [],
        history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
      });
    const store = new NotesStore(notesApi);
    await store.bootstrap();

    await store.setCompletedMany(["one", "two"], true);
    await store.deleteSubtrees(["one", "two"]);

    expect(notesApi.execute).toHaveBeenNthCalledWith(1, expect.objectContaining({
      command: {
        kind: "setCompletedMany",
        ids: ["one", "two"],
        completed: true
      }
    }));
    expect(notesApi.execute).toHaveBeenNthCalledWith(2, expect.objectContaining({
      command: {
        kind: "deleteSubtrees",
        ids: ["one", "two"]
      }
    }));
    expect(store.getSnapshot().nodes).toHaveLength(0);
  });

  it("imports a parsed outline hierarchy with one semantic command", async () => {
    const notesApi = api(vi.fn());
    notesApi.execute = vi.fn().mockImplementation(async (envelope) => {
      if (envelope.command.kind !== "importNodes") {
        throw new Error("expected importNodes");
      }
      return {
        revision: 2,
        changedNodes: envelope.command.nodes.map((imported: {
          id: string;
          parentId: string;
          text: string;
        }, index: number) => ({
          ...bullet(imported.id, (index + 1) * 1024),
          parentId: imported.parentId,
          text: imported.text
        })),
        deletedIds: [],
        history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
      };
    });
    const store = new NotesStore(notesApi);
    await store.bootstrap();

    const firstRootId = await store.importOutline("one", null, [
      {
        title: "Parent",
        children: [{ title: "Child", children: [] }]
      },
      { title: "Sibling", children: [] }
    ]);

    const imported = vi.mocked(notesApi.execute).mock.calls[0][0].command;
    expect(imported.kind).toBe("importNodes");
    if (imported.kind !== "importNodes") throw new Error("expected importNodes");
    expect(imported.parent_id).toBe("one");
    expect(imported.before_id).toBeNull();
    expect(imported.nodes).toEqual([
      { id: firstRootId, parentId: "one", text: "Parent" },
      {
        id: expect.any(String),
        parentId: firstRootId,
        text: "Child"
      },
      {
        id: expect.any(String),
        parentId: "one",
        text: "Sibling"
      }
    ]);
    expect(notesApi.execute).toHaveBeenCalledOnce();
  });

  it("moves a selected block with one semantic command", async () => {
    const notesApi = api(vi.fn());
    notesApi.execute = vi.fn().mockResolvedValue({
      revision: 2,
      changedNodes: [
        { ...bullet("one", 1024), parentId: "parent" },
        { ...bullet("two", 2048), parentId: "parent" }
      ],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });
    const store = new NotesStore(notesApi);
    await store.bootstrap();

    await store.moveNodes([
      { id: "one", parentId: "parent", beforeId: null },
      { id: "two", parentId: "parent", beforeId: null }
    ]);

    expect(notesApi.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: {
        kind: "moveNodes",
        moves: [
          { id: "one", parentId: "parent", beforeId: null },
          { id: "two", parentId: "parent", beforeId: null }
        ]
      }
    }));
    expect(notesApi.execute).toHaveBeenCalledOnce();
  });

  it("duplicates a selected block with one semantic command", async () => {
    const notesApi = api(vi.fn());
    notesApi.execute = vi.fn().mockImplementation(async (envelope) => {
      if (envelope.command.kind !== "duplicateNodes") {
        throw new Error("expected duplicateNodes");
      }
      return {
        revision: 2,
        changedNodes: envelope.command.duplicates.map((
          duplicate: { newId: string; parentId: string },
          index: number
        ) => ({
          ...bullet(duplicate.newId, (index + 3) * 1_024),
          parentId: duplicate.parentId
        })),
        deletedIds: [],
        history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
      };
    });
    const store = new NotesStore(notesApi);
    await store.bootstrap();

    const copiedIds = await store.duplicateNodes(
      ["one", "two"],
      "page-1",
      null
    );

    expect(copiedIds).toHaveLength(2);
    expect(notesApi.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: {
        kind: "duplicateNodes",
        duplicates: [
          {
            id: "one",
            newId: copiedIds[0],
            parentId: "page-1",
            beforeId: null
          },
          {
            id: "two",
            newId: copiedIds[1],
            parentId: "page-1",
            beforeId: null
          }
        ]
      }
    }));
    expect(notesApi.execute).toHaveBeenCalledOnce();
  });

  it("returns the complete copied forest for selection restoration", async () => {
    const notesApi = api(vi.fn());
    notesApi.execute = vi.fn().mockImplementation(async (envelope) => {
      if (envelope.command.kind !== "duplicateNodes") {
        throw new Error("expected duplicateNodes");
      }
      const copiedRootId = envelope.command.duplicates[0].newId;
      return {
        revision: 2,
        changedNodes: [
          { ...bullet(copiedRootId, 3_072) },
          {
            ...bullet(`${copiedRootId}/1`, 1_024),
            parentId: copiedRootId
          }
        ],
        deletedIds: [],
        history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
      };
    });
    const store = new NotesStore(notesApi);
    await store.bootstrap();

    const copiedIds = await store.duplicateNodes(["one"], "page-1", null);

    expect(copiedIds).toHaveLength(2);
    expect(copiedIds[1]).toBe(`${copiedIds[0]}/1`);
  });

  it("flushes loaded descendant title and note drafts before duplicating", async () => {
    const notesApi = api(vi.fn());
    const child = { ...bullet("child", 1_024), parentId: "one" };
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...boot,
      viewport: {
        ...boot.viewport!,
        nodes: [bullet("one", 1_024), child, bullet("two", 2_048)]
      }
    });
    let revision = 1;
    notesApi.execute = vi.fn().mockImplementation(async (envelope) => {
      revision += 1;
      const command = envelope.command;
      const changedNodes = command.kind === "updateText"
        ? [{ ...child, text: command.text }]
        : command.kind === "updateNote"
          ? [{ ...child, note: command.note }]
          : command.kind === "duplicateNodes"
            ? [{
                ...bullet(command.duplicates[0].newId, 3_072),
                parentId: "page-1"
              }]
            : [];
      return {
        revision,
        changedNodes,
        deletedIds: [],
        history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
      };
    });
    const store = new NotesStore(notesApi);
    await store.bootstrap();
    store.setDraft("child", "Draft child");
    store.setNoteDraft("child", "Draft context");

    await store.duplicateNodes(["one"], "page-1", null);

    expect(vi.mocked(notesApi.execute).mock.calls.map(
      ([envelope]) => envelope.command.kind
    )).toEqual(["updateText", "updateNote", "duplicateNodes"]);
  });

  it("opens the next page after the active page moves to Trash", async () => {
    const queryViewport = vi.fn().mockResolvedValue({
      pageId: "page-2",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: [bullet("next", 1024)]
    });
    const notesApi = api(queryViewport);
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...boot,
      pages: [...boot.pages, { id: "page-2", title: "Next page" }]
    });
    notesApi.execute = vi.fn().mockResolvedValue({
      revision: 2,
      changedNodes: [],
      deletedIds: ["page-1", "one", "two"],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });
    const store = new NotesStore(notesApi);

    await store.bootstrap();
    await store.deleteSubtree("page-1");

    expect(queryViewport).toHaveBeenCalledWith({
      pageId: "page-2",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      limit: 80
    });
    expect(store.getSnapshot().activePageId).toBe("page-2");
    expect(store.getSnapshot().nodes.map((node) => node.id)).toEqual(["next"]);
  });

  it("keeps the latest page when viewport responses arrive out of order", async () => {
    let resolvePage2: (viewport: ViewportPage) => void = () => undefined;
    const page2Response = new Promise<ViewportPage>((resolve) => {
      resolvePage2 = resolve;
    });
    const page3Response: ViewportPage = {
      pageId: "page-3",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: []
    };
    const queryViewport = vi.fn().mockImplementation((request) =>
      request.pageId === "page-2" ? page2Response : Promise.resolve(page3Response)
    );
    const notesApi = api(queryViewport);
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...boot,
      pages: [
        ...boot.pages,
        { id: "page-2", title: "Second page" },
        { id: "page-3", title: "Third page" }
      ]
    });
    const store = new NotesStore(notesApi);
    await store.bootstrap();

    const openingPage2 = store.openPage("page-2");
    await store.openPage("page-3");
    resolvePage2({ ...page3Response, pageId: "page-2" });
    await openingPage2;

    expect(store.getSnapshot().activePageId).toBe("page-3");
  });

  it("sends one atomic split command and preserves a newer source draft", async () => {
    let releaseReceipt: (() => void) | undefined;
    const receiptGate = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    const notesApi = api(vi.fn());
    notesApi.execute = vi.fn(async (envelope) => {
      const command = envelope.command;
      if (command.kind !== "splitNode") throw new Error("expected splitNode");
      await receiptGate;
      return {
        revision: 2,
        changedNodes: [
          { ...bullet("one", 1024), text: command.prefix },
          {
            ...bullet(command.new_id, 1536),
            text: command.suffix
          }
        ],
        deletedIds: [],
        history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
      };
    });
    const store = new NotesStore(notesApi);
    await store.bootstrap();
    store.setDraft("one", "alphaXYZomega");

    const split = store.beginSplitNode({
      id: "one",
      parentId: "page-1",
      beforeId: "two",
      prefix: "alpha",
      suffix: "omega"
    });
    await vi.waitFor(() => expect(notesApi.execute).toHaveBeenCalledOnce());
    expect(store.getSnapshot().drafts.one).toBe("alpha");
    expect(store.getSnapshot().nodes.map((node) => node.id)).toEqual([
      "one",
      split.id,
      "two"
    ]);
    expect(store.getSnapshot().nodes.find((node) => node.id === split.id)?.text)
      .toBe("omega");

    store.setDraft("one", "newer");
    releaseReceipt?.();
    await split.committed;

    expect(notesApi.execute).toHaveBeenCalledWith(expect.objectContaining({
      baseRevision: 1,
      command: {
        kind: "splitNode",
        id: "one",
        new_id: split.id,
        parent_id: "page-1",
        before_id: "two",
        prefix: "alpha",
        suffix: "omega"
      }
    }));
    expect(store.getSnapshot().drafts.one).toBe("newer");
    expect(store.getSnapshot().nodes.map((node) => node.id)).toEqual([
      "one",
      split.id,
      "two"
    ]);
  });

  it("applies lifted children and the removed empty row from one receipt", async () => {
    const before = bullet("before", 1024);
    const empty = { ...bullet("empty", 2048), text: " " };
    const child = { ...bullet("child", 1024), parentId: "empty" };
    const after = bullet("after", 3072);
    const notesApi = api(vi.fn());
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...boot,
      viewport: {
        ...boot.viewport!,
        nodes: [before, empty, child, after]
      }
    });
    notesApi.execute = vi.fn().mockResolvedValue({
      revision: 2,
      changedNodes: [{ ...child, parentId: "page-1", sortKey: 2048 }],
      deletedIds: ["empty"],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });
    const store = new NotesStore(notesApi);
    await store.bootstrap();
    store.setDraft("empty", " ");

    const removal = store.beginRemoveEmptyNode("empty");
    expect(store.getSnapshot().nodes.map((node) => node.id)).toEqual([
      "before",
      "child",
      "after"
    ]);
    await removal.committed;

    expect(notesApi.execute).toHaveBeenCalledWith(expect.objectContaining({
      baseRevision: 1,
      command: { kind: "removeEmptyNode", id: "empty" }
    }));
    expect(store.getSnapshot().drafts.empty).toBeUndefined();
    expect(store.getSnapshot().nodes.map((node) => node.id)).toEqual([
      "before",
      "child",
      "after"
    ]);
  });

  it("optimistically merges into the current row before SQLite confirms", async () => {
    let releaseReceipt: (() => void) | undefined;
    const receiptGate = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    const notesApi = api(vi.fn());
    notesApi.execute = vi.fn(async (envelope) => {
      if (envelope.command.kind !== "mergeNodeBackward") {
        throw new Error("expected mergeNodeBackward");
      }
      await receiptGate;
      return {
        revision: 2,
        changedNodes: [{
          ...bullet("two", 1_024),
          text: envelope.command.previous_text + envelope.command.current_text
        }],
        deletedIds: ["one"],
        history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
      };
    });
    const store = new NotesStore(notesApi);
    await store.bootstrap();

    const merge = store.beginMergeNodeBackward({
      id: "two",
      previousId: "one",
      previousText: "alpha",
      currentText: "beta"
    });

    expect(store.getSnapshot().nodes.map((node) => node.id)).toEqual(["two"]);
    expect(store.getSnapshot().drafts.two).toBe("alphabeta");
    await vi.waitFor(() => expect(notesApi.execute).toHaveBeenCalledOnce());
    expect(notesApi.execute).toHaveBeenCalledWith(expect.objectContaining({
      baseRevision: 1,
      command: {
        kind: "mergeNodeBackward",
        id: "two",
        previous_id: "one",
        previous_text: "alpha",
        current_text: "beta"
      }
    }));

    releaseReceipt?.();
    await merge.committed;
    expect(store.getSnapshot().drafts.two).toBeUndefined();
    expect(store.getSnapshot().nodes[0].text).toBe("alphabeta");
  });

  it("keeps supporting-note drafts separate and flushes one semantic command", async () => {
    const notesApi = api(vi.fn());
    notesApi.execute = vi.fn().mockImplementation(async (envelope) => {
      if (envelope.command.kind !== "updateNote") {
        throw new Error("expected updateNote");
      }
      return {
        revision: 2,
        changedNodes: [{
          ...bullet("one", 1024),
          note: envelope.command.note
        }],
        deletedIds: [],
        history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
      };
    });
    const store = new NotesStore(notesApi);
    await store.bootstrap();

    store.setNoteDraft("one", "Supporting context");
    expect(store.getSnapshot().noteDrafts.one).toBe("Supporting context");
    expect(store.getSnapshot().drafts.one).toBeUndefined();
    await store.flushNoteDraft("one");

    expect(notesApi.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: {
        kind: "updateNote",
        id: "one",
        note: "Supporting context"
      }
    }));
    expect(store.getSnapshot().noteDrafts.one).toBeUndefined();
    expect(store.getSnapshot().nodes[0].note).toBe("Supporting context");
  });
});
