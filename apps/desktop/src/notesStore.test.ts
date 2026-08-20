import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";
import type { CommandEnvelope } from "../../../packages/contracts/generated/CommandEnvelope";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "./api";
import type { ViewportRequest } from "../../../packages/contracts/generated/ViewportRequest";
import type { ViewportPage } from "../../../packages/contracts/generated/ViewportPage";
import { NotesStore } from "./notesStore";
import { parseSingleTag, planTagEdits } from "./outline/outlineTagEdits";
import { DRAFT_DEBOUNCE_MS } from "./store/storeSupport";
import { appApi } from "./test/appApiFixture";

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
  pages: [{ id: "page-1", title: "Today", sortKey: 1_024 }],
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
    ...appApi(),
    bootstrap: vi.fn().mockResolvedValue(boot),
    queryViewport,
    queryForest: vi.fn().mockResolvedValue({
      revision: boot.revision,
      nodes: [],
      complete: true
    }),
    search: vi.fn()
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

  it("flushes an awaited draft against the fixture's own execute", async () => {
    const notesApi = api(vi.fn());
    const store = new NotesStore(notesApi);
    await store.bootstrap();

    store.setDraft("one", "typed");
    await store.flushDraft("one");

    expect(store.getSnapshot().error).toBeNull();
    expect(notesApi.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: { kind: "updateText", id: "one", text: "typed" }
    }));
    expect(store.getSnapshot().drafts.one).toBeUndefined();
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

    // The debounce rather than flushDraft: an explicit flush is a blur, which
    // closes the typing run the two bursts are here to share.
    vi.useFakeTimers();
    store.setDraft("one", "First");
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    store.setDraft("one", "Second");
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    store.breakHistoryGroup();
    store.setDraft("one", "Third");
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    vi.useRealTimers();

    expect(historyListener).toHaveBeenCalledTimes(2);
    expect(vi.mocked(notesApi.execute).mock.calls.map(
      ([envelope]) => envelope.historyGroup
    )).toEqual(["text:one:1", "text:one:1", "text:one:2"]);
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

  it("sends one row and leaves the Todo chain to the server", async () => {
    const parent = { ...bullet("one", 1024), marker: "todo" as const };
    const child = {
      ...bullet("child", 2048), parentId: "one", marker: "todo" as const
    };
    const notesApi = api(vi.fn());
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...boot,
      viewport: { ...boot.viewport!, nodes: [parent, child] }
    });
    notesApi.execute = vi.fn().mockResolvedValue({
      revision: 2,
      changedNodes: [{ ...parent, completed: true }, { ...child, completed: true }],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });
    const store = new NotesStore(notesApi);

    await store.bootstrap();
    await store.setCompleted("one", true);

    // The loaded rows are only a window of the page, so the client never
    // decides which rows the tick reaches.
    expect(notesApi.execute).toHaveBeenCalledTimes(1);
    expect(notesApi.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: { kind: "setCompleted", id: "one", completed: true }
    }));
    expect(store.getSnapshot().nodes.map((node) => node.completed))
      .toEqual([true, true]);
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

  it("imports a rich outline with its marker, note, tick and image", async () => {
    const notesApi = api(vi.fn());
    notesApi.execute = vi.fn().mockResolvedValue({
      revision: 2,
      changedNodes: [],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });
    const image = {
      contentHash: "a".repeat(64),
      originalName: "photo.png",
      mimeType: "image/png",
      byteLength: 3,
      pixelWidth: 1,
      pixelHeight: 1,
      displayWidth: 320
    };
    const store = new NotesStore(notesApi);
    await store.bootstrap();

    const rootId = await store.importOutline("one", "two", [{
      title: "Buy milk",
      note: "Two litres",
      marker: "todo",
      completed: true,
      collapsed: true,
      starred: true,
      children: [{ title: "photo.png", image, children: [] }]
    }]);

    const imported = vi.mocked(notesApi.execute).mock.calls[0][0].command;
    if (imported.kind !== "importNodes") throw new Error("expected importNodes");
    expect(imported.before_id).toBe("two");
    expect(imported.nodes).toEqual([
      {
        id: rootId,
        parentId: "one",
        text: "Buy milk",
        note: "Two litres",
        marker: "todo",
        completed: true,
        collapsed: true,
        starred: true,
        image: undefined
      },
      {
        id: expect.any(String),
        parentId: rootId,
        text: "photo.png",
        note: undefined,
        marker: undefined,
        completed: undefined,
        collapsed: undefined,
        starred: undefined,
        image
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

  /** A page the user asked for: open, empty, and not written anywhere yet. */
  async function openedNewPage(): Promise<{
    readonly store: NotesStore;
    readonly notesApi: NotesApi;
    readonly pageId: string;
  }> {
    const notesApi = api(vi.fn().mockResolvedValue({
      pageId: "root",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: []
    }));
    notesApi.execute = vi.fn().mockImplementation(async (envelope) => ({
      revision: 2,
      // The backend answers with the row the command named. Every command
      // these tests send is about a page or a row directly inside one, so a
      // command that names no parent is about a page: the root's own child,
      // which is all a page is.
      changedNodes: [{
        ...bullet(envelope.command.id, 4_096),
        parentId: envelope.command.parent_id ?? "root",
        text: envelope.command.text ?? ""
      }],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    }));
    const store = new NotesStore(notesApi);
    await store.bootstrap();
    const pageId = await store.createPage();
    return { store, notesApi, pageId };
  }

  it("opens a new page without writing anything", async () => {
    const { store, notesApi, pageId } = await openedNewPage();

    expect(notesApi.execute).not.toHaveBeenCalled();
    expect(notesApi.queryViewport).not.toHaveBeenCalled();
    expect(store.getSnapshot().activePageId).toBe(pageId);
    expect(store.getNodeSnapshot(pageId).title).toBe("");
    expect(store.getSnapshot().pages).toEqual(boot.pages);
  });

  it("leaves nothing behind when the new page is never written in", async () => {
    const { store, notesApi } = await openedNewPage();

    await store.openPage("root");

    expect(notesApi.execute).not.toHaveBeenCalled();
    expect(store.getSnapshot().pages).toEqual(boot.pages);
  });

  it("creates the page the moment its title is typed into", async () => {
    const { store, notesApi, pageId } = await openedNewPage();

    store.setDraft(pageId, "Groceries");
    await store.flushDraft(pageId);

    // The page is created empty and the typing lands right behind it: an
    // `updateText` sent first would name a row the backend has never seen.
    expect(vi.mocked(notesApi.execute).mock.calls.map(
      ([envelope]) => envelope.command
    )).toEqual([
      {
        kind: "createNode",
        id: pageId,
        parent_id: "root",
        before_id: null,
        text: ""
      },
      { kind: "updateText", id: pageId, text: "Groceries" }
    ]);
    expect(store.getSnapshot().pages).toContainEqual({
      id: pageId,
      title: "Groceries",
      sortKey: 4_096
    });
  });

  it("creates the page before the first row written into it", async () => {
    const { store, notesApi, pageId } = await openedNewPage();

    expect(notesApi.execute).not.toHaveBeenCalled();
    await store.createNode(pageId);

    expect(vi.mocked(notesApi.execute).mock.calls.map(
      ([envelope]) => [
        envelope.command.kind,
        "parent_id" in envelope.command ? envelope.command.parent_id : null
      ]
    )).toEqual([["createNode", "root"], ["createNode", pageId]]);
  });

  it("stays unwritten while a command about another page goes out", async () => {
    const { store, notesApi } = await openedNewPage();

    await store.deleteSubtree("page-1");

    expect(vi.mocked(notesApi.execute).mock.calls.map(
      ([envelope]) => envelope.command.kind
    )).toEqual(["deleteSubtree"]);
  });

  it("holds the page open across its own creation", async () => {
    const { store, notesApi, pageId } = await openedNewPage();
    let release!: (receipt: MutationReceipt) => void;
    vi.mocked(notesApi.execute).mockReturnValueOnce(
      new Promise<MutationReceipt>((resolve) => {
        release = resolve;
      })
    );

    const created = store.createNode(pageId);

    // Until the row exists nothing else knows this page, so the window has to
    // keep saying it holds one -- the pane reads this to decide whether it has
    // a page to draw at all.
    expect(store.getSnapshot().provisionalPageId).toBe(pageId);
    release({
      revision: 2,
      changedNodes: [{ ...bullet(pageId, 4_096), parentId: "root", text: "" }],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });
    await created;
    expect(store.getSnapshot().provisionalPageId).toBeNull();
    expect(store.getSnapshot().pages).toContainEqual({
      id: pageId,
      title: "",
      sortKey: 4_096
    });
  });

  it("writes a second new page once, with the first still in flight", async () => {
    const { store, notesApi, pageId } = await openedNewPage();
    // Every page creation waits to be let through by hand, so the second one
    // is still in flight when the first one finishes.
    const held = new Map<string, () => void>();
    const answered = vi.mocked(notesApi.execute).getMockImplementation()!;
    vi.mocked(notesApi.execute).mockImplementation(async (envelope) => {
      const { command } = envelope;
      const first = command.kind === "createNode" &&
        command.parent_id === "root" && !held.has(command.id);
      if (first) {
        await new Promise<void>((resolve) => held.set(command.id, resolve));
      }
      return answered(envelope);
    });
    void store.setCompleted(pageId, true);
    const secondId = await store.createPage();
    void store.setCompleted(secondId, true);

    await vi.waitFor(() => expect(held.has(pageId)).toBe(true));
    held.get(pageId)!();
    await vi.waitFor(() => expect(held.has(secondId)).toBe(true));
    const lastWrite = store.setCompleted(secondId, false);
    held.get(secondId)!();
    await lastWrite;

    // One creation per page. The first one finishing must not hand the second
    // page's creation back to be sent again -- the backend refuses an id it
    // already has, and the write that asked for it dies with the refusal.
    expect(vi.mocked(notesApi.execute).mock.calls.filter(
      ([envelope]) => envelope.command.kind === "createNode"
    ).map(([envelope]) => "id" in envelope.command ? envelope.command.id : null))
      .toEqual([pageId, secondId]);
  });

  it("keeps the new page when the answer for the page it left lands late", async () => {
    let release!: (viewport: ViewportPage) => void;
    const notesApi = api(vi.fn().mockReturnValue(
      new Promise<ViewportPage>((resolve) => {
        release = resolve;
      })
    ));
    const store = new NotesStore(notesApi);
    await store.bootstrap();

    const opening = store.openPage("page-2");
    const pageId = await store.createPage();
    release({
      pageId: "page-2",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: []
    });
    await opening;

    expect(store.getSnapshot().activePageId).toBe(pageId);
    expect(store.getSnapshot().provisionalPageId).toBe(pageId);
  });

  it("tries the page's creation again after it fails", async () => {
    const { store, notesApi, pageId } = await openedNewPage();
    vi.mocked(notesApi.execute).mockRejectedValueOnce(new Error("Offline."));

    await expect(store.createNode(pageId)).rejects.toThrow("Offline.");
    await store.createNode(pageId);

    // The failed creation, the one that worked, and only then the row that
    // asked for it. A page left uncreated would swallow every later write.
    expect(vi.mocked(notesApi.execute).mock.calls.map(
      ([envelope]) => [
        envelope.command.kind,
        "parent_id" in envelope.command ? envelope.command.parent_id : null
      ]
    )).toEqual([
      ["createNode", "root"],
      ["createNode", "root"],
      ["createNode", pageId]
    ]);
  });

  it("opens Home after the active page moves to Trash", async () => {
    const queryViewport = vi.fn().mockResolvedValue({
      pageId: "root",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: [bullet("next", 1024)]
    });
    const notesApi = api(queryViewport);
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...boot,
      pages: [...boot.pages, { id: "page-2", title: "Next page", sortKey: 1_024 }]
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
      pageId: "root",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      limit: 80
    });
    expect(store.getSnapshot().activePageId).toBe("root");
    expect(store.getSnapshot().nodes.map((node) => node.id)).toEqual(["next"]);
  });

  it("stays put when the trashed page is not the one on screen", async () => {
    const queryViewport = vi.fn();
    const notesApi = api(queryViewport);
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...boot,
      pages: [
        { id: "page-0", title: "First page", sortKey: 512 },
        ...boot.pages,
        { id: "page-2", title: "Next page", sortKey: 2_048 }
      ]
    });
    notesApi.execute = vi.fn().mockResolvedValue({
      revision: 2,
      changedNodes: [],
      deletedIds: ["page-2"],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });
    const store = new NotesStore(notesApi);

    await store.bootstrap();
    await store.deleteSubtree("page-2");

    expect(queryViewport).not.toHaveBeenCalled();
    expect(store.getSnapshot().activePageId).toBe("page-1");
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
        { id: "page-2", title: "Second page", sortKey: 1_024 },
        { id: "page-3", title: "Third page", sortKey: 1_024 }
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

/**
 * A fake backend that behaves the way notes-application does about history:
 * commands sharing one group fold into a single undo entry, and `undo`
 * restores the tree as it stood before that whole entry.
 */
function backend(options: {
  readonly rejectRemoval?: boolean;
  readonly seed?: readonly NoteView[];
} = {}) {
  const seed = options.seed ?? [bullet("one", 1_024), bullet("two", 2_048)];
  const nodes = new Map<string, NoteView>(
    seed.map((node) => [node.id, node])
  );
  const envelopes: CommandEnvelope[] = [];
  // notes-application undoes one history group at a time
  const undoStack: Map<string, NoteView>[] = [];
  let revision = boot.revision;
  let undoDepth = 0;
  let lastGroup: string | null = null;
  const notesApi = api(vi.fn());
  notesApi.bootstrap = vi.fn().mockResolvedValue({
    ...boot,
    viewport: { ...boot.viewport!, nodes: seed.map((node) => ({ ...node })) }
  });
  notesApi.undo = vi.fn(async () => {
    const restored = undoStack.pop() ?? new Map(nodes);
    const deletedIds = [...nodes.keys()].filter((id) => !restored.has(id));
    nodes.clear();
    restored.forEach((node, id) => nodes.set(id, node));
    revision += 1;
    undoDepth = Math.max(0, undoDepth - 1);
    lastGroup = null;
    return {
      revision,
      changedNodes: [...nodes.values()],
      deletedIds,
      history: {
        canUndo: undoDepth > 0,
        canRedo: true,
        undoDepth,
        redoDepth: 1
      }
    };
  });
  notesApi.execute = vi.fn(async (envelope) => {
    envelopes.push(envelope);
    const command = envelope.command;
    const changedNodes: NoteView[] = [];
    const deletedIds: string[] = [];
    const target = "id" in command ? nodes.get(command.id) : undefined;
    if (!target) throw new Error(`node not found: ${JSON.stringify(command)}`);
    if (envelope.historyGroup === null || envelope.historyGroup !== lastGroup) {
      undoStack.push(new Map(nodes));
    }
    if (command.kind === "updateText") {
      const node = { ...target, text: command.text };
      nodes.set(node.id, node);
      changedNodes.push(node);
    } else if (command.kind === "updateNote") {
      const node = { ...target, note: command.note };
      nodes.set(node.id, node);
      changedNodes.push(node);
    } else if (command.kind === "removeEmptyNode") {
      // mirrors notes-core remove_empty_node
      if (
        options.rejectRemoval ||
        target.text.trim().length > 0 ||
        target.note.trim().length > 0
      ) {
        throw new Error(`node is not empty: ${command.id}`);
      }
      [...nodes.values()]
        .filter((node) => node.parentId === command.id)
        .forEach((child, index) => {
          const promoted = {
            ...child,
            parentId: target.parentId,
            sortKey: target.sortKey + index + 1
          };
          nodes.set(child.id, promoted);
          changedNodes.push(promoted);
        });
      nodes.delete(command.id);
      deletedIds.push(command.id);
    } else if (command.kind === "mergeNodeIntoParent") {
      // mirrors notes-core merge_node_into_parent
      const parent = nodes.get(command.parent_id);
      if (!parent) throw new Error(`node not found: ${command.parent_id}`);
      const merged = {
        ...parent,
        text: command.parent_text + command.current_text
      };
      nodes.set(merged.id, merged);
      changedNodes.push(merged);
      [...nodes.values()]
        .filter((node) => node.parentId === command.id)
        .forEach((child, index) => {
          const promoted = {
            ...child,
            parentId: target.parentId,
            sortKey: target.sortKey + index + 1
          };
          nodes.set(child.id, promoted);
          changedNodes.push(promoted);
        });
      nodes.delete(command.id);
      deletedIds.push(command.id);
    } else if (command.kind === "setCollapsed") {
      const node = { ...target, collapsed: command.collapsed };
      nodes.set(node.id, node);
      changedNodes.push(node);
    } else {
      throw new Error(`unexpected command: ${command.kind}`);
    }
    revision += 1;
    // notes-application folds same-group mutations into one undo entry
    if (envelope.historyGroup === null || envelope.historyGroup !== lastGroup) {
      undoDepth += 1;
    }
    lastGroup = envelope.historyGroup;
    return {
      revision,
      changedNodes,
      deletedIds,
      history: { canUndo: true, canRedo: false, undoDepth, redoDepth: 0 }
    };
  });
  return {
    notesApi,
    commands: () => envelopes.map((envelope) => envelope.command),
    groups: () => envelopes.map((envelope) => envelope.historyGroup)
  };
}

describe("NotesStore empty-row removal", () => {

  it("commits the blanking edit before removing the row it emptied", async () => {
    const backspace = backend();
    const store = new NotesStore(backspace.notesApi);
    await store.bootstrap();
    const history = vi.fn();
    store.subscribeHistory(history);

    // the 300ms title debounce has not fired: SQLite still holds "two"
    store.setDraft("two", "");
    await store.beginRemoveEmptyNode("two", "backspace:1").committed;

    expect(backspace.commands()).toEqual([
      { kind: "updateText", id: "two", text: "" },
      { kind: "removeEmptyNode", id: "two" }
    ]);
    const [group] = backspace.groups();
    expect(group).toMatch(/^backspace:1(:\d+)?$/);
    expect(backspace.groups()).toEqual([group, group]);
    expect(history).toHaveBeenCalledOnce();
    expect(store.getSnapshot().nodes.map((node) => node.id)).toEqual(["one"]);
    expect(store.getSnapshot().error).toBeNull();
  });

  it("restores a row whose text matches what it renders when removal fails", async () => {
    const backspace = backend({ rejectRemoval: true });
    const store = new NotesStore(backspace.notesApi);
    await store.bootstrap();

    store.setDraft("two", "");
    await expect(
      store.beginRemoveEmptyNode("two", "backspace:1").committed
    ).rejects.toThrow(/node is not empty/);

    const restored = store.getSnapshot().nodes.find((node) => node.id === "two");
    expect(restored).toBeDefined();
    expect(store.getNodeSnapshot("two").title).toBe(restored?.text);
  });

  it("sends only the removal when the row is already committed empty", async () => {
    const backspace = backend();
    const store = new NotesStore(backspace.notesApi);
    await store.bootstrap();
    store.setDraft("two", "");
    await store.flushDraft("two");
    expect(backspace.commands()).toHaveLength(1);

    await store.beginRemoveEmptyNode("two", "backspace:1").committed;

    expect(backspace.commands().slice(1)).toEqual([
      { kind: "removeEmptyNode", id: "two" }
    ]);
  });

  it("merges a first child into its parent as one undoable step", async () => {
    const backspace = backend({
      seed: [
        { ...bullet("parent", 1_024), text: "뭔가" },
        { ...bullet("current", 1_024), parentId: "parent", text: "하지만" },
        { ...bullet("child-a", 1_024), parentId: "current", text: "첫째" },
        { ...bullet("child-b", 2_048), parentId: "current", text: "둘째" },
        { ...bullet("sibling", 2_048), parentId: "parent", text: "이런것이" }
      ]
    });
    const store = new NotesStore(backspace.notesApi);
    await store.bootstrap();
    const outline = () => store.getSnapshot().nodes
      .map((node) => [node.id, node.text, node.parentId]);

    const merge = store.beginMergeNodeIntoParent({
      id: "current",
      parentId: "parent",
      parentText: "뭔가",
      currentText: "하지만",
      historyGroup: "backspace:1"
    });
    // the row is gone before the first command settles
    expect(outline()).toEqual([
      ["parent", "뭔가하지만", "page-1"],
      ["child-a", "첫째", "parent"],
      ["child-b", "둘째", "parent"],
      ["sibling", "이런것이", "parent"]
    ]);
    await merge.committed;

    // One keystroke, one command: spelled as three, a write landing between
    // them tore the gesture out of its history entry.
    expect(backspace.commands()).toEqual([
      {
        kind: "mergeNodeIntoParent",
        id: "current",
        parent_id: "parent",
        parent_text: "뭔가",
        current_text: "하지만"
      }
    ]);
    expect(backspace.groups()).toEqual(["backspace:1"]);
    expect(store.getSnapshot().undoDepth).toBe(1);
    expect(store.getSnapshot().drafts.parent).toBeUndefined();
    expect(outline()).toEqual([
      ["parent", "뭔가하지만", "page-1"],
      ["child-a", "첫째", "parent"],
      ["child-b", "둘째", "parent"],
      ["sibling", "이런것이", "parent"]
    ]);

    await store.undo();

    expect(outline()).toEqual([
      ["parent", "뭔가", "page-1"],
      ["current", "하지만", "parent"],
      ["child-a", "첫째", "current"],
      ["child-b", "둘째", "current"],
      ["sibling", "이런것이", "parent"]
    ]);
  });
});

describe("NotesStore tag edits", () => {
  const errand = parseSingleTag("#errand")!;
  const seed = [
    { ...bullet("one", 1_024), text: "buy milk" },
    { ...bullet("two", 2_048), text: "call mum" },
    { ...bullet("three", 3_072), text: "pay rent" }
  ];

  function titles(store: NotesStore): readonly string[] {
    return store.getSnapshot().nodes.map((node) => node.text);
  }

  it("tags three rows under one history group that one undo reverts", async () => {
    const tagging = backend({ seed });
    const store = new NotesStore(tagging.notesApi);
    await store.bootstrap();
    const history = vi.fn();
    store.subscribeHistory(history);

    await store.applyTextEdits(planTagEdits(
      store.getSnapshot().nodes, {}, {},
      ["one", "two", "three"],
      errand,
      "add"
    ));

    expect(tagging.commands()).toEqual([
      { kind: "updateText", id: "one", text: "buy milk #errand" },
      { kind: "updateText", id: "two", text: "call mum #errand" },
      { kind: "updateText", id: "three", text: "pay rent #errand" }
    ]);
    expect(new Set(tagging.groups()).size).toBe(1);
    // Three writes, one entry: the coalescer folded them, so the toolbar sees
    // one new undo step rather than three.
    expect(history).toHaveBeenCalledOnce();

    await store.undo();

    expect(titles(store)).toEqual(["buy milk", "call mum", "pay rent"]);
  });

  it("keeps a later tag operation out of the previous undo entry", async () => {
    const tagging = backend({ seed });
    const store = new NotesStore(tagging.notesApi);
    await store.bootstrap();

    const plan = (mode: "add" | "remove") => planTagEdits(
      store.getSnapshot().nodes, {}, {}, ["one"], errand, mode
    );
    await store.applyTextEdits(plan("add"));
    await store.applyTextEdits(plan("remove"));

    expect(new Set(tagging.groups()).size).toBe(2);
    expect(titles(store)).toEqual(["buy milk", "call mum", "pay rent"]);
  });
});

// A command that lands while the 300 ms draft debounce is still holding the
// user's typing used to commit first, so the typing committed second and the
// first undo wiped the typing instead of reversing the action. Every command
// that does not carry its own text now waits behind the pending drafts.
describe("NotesStore draft flushing before commands", () => {
  function recording(nodes: readonly NoteView[] = boot.viewport!.nodes) {
    const notesApi = api(vi.fn());
    notesApi.bootstrap = vi.fn().mockResolvedValue({
      ...boot,
      viewport: { ...boot.viewport!, nodes: [...nodes] }
    });
    let revision = 1;
    notesApi.execute = vi.fn().mockImplementation(async (envelope) => {
      revision += 1;
      const command = envelope.command;
      const target = nodes.find((node) => node.id === command.id);
      const changedNodes = !target
        ? []
        : command.kind === "updateText"
          ? [{ ...target, text: command.text }]
          : command.kind === "updateNote"
            ? [{ ...target, note: command.note }]
            : [];
      return {
        revision,
        changedNodes,
        deletedIds: [],
        history: {
          canUndo: true,
          canRedo: false,
          undoDepth: revision - 1,
          redoDepth: 0
        }
      };
    });
    return notesApi;
  }

  function sent(notesApi: NotesApi) {
    return vi.mocked(notesApi.execute).mock.calls
      .map(([envelope]) => envelope.command);
  }

  it.each([
    ["setCompleted", (store: NotesStore) => store.setCompleted("one", true)],
    ["setStarred", (store: NotesStore) => store.setStarred("one", true)],
    ["setCollapsed", (store: NotesStore) => store.setCollapsed("one", true)],
    ["setMarker", (store: NotesStore) => store.setMarker("one", "todo")],
    ["restoreSubtree", (store: NotesStore) => store.restoreSubtree("one")],
    ["deleteSubtree", (store: NotesStore) => store.deleteSubtree("one")],
    [
      "createNode",
      (store: NotesStore) => store.beginCreateNode("one", "", null).committed
    ]
  ])("commits pending typing before %s", async (kind, run) => {
    const notesApi = recording();
    const store = new NotesStore(notesApi);
    await store.bootstrap();
    store.setDraft("one", "typed");

    await run(store);

    expect(sent(notesApi).map((command) => command.kind))
      .toEqual(["updateText", kind]);
    // The delete path used to discard this instead of sending it, so undo
    // brought the row back carrying the pre-typing text.
    expect(sent(notesApi)[0])
      .toEqual({ kind: "updateText", id: "one", text: "typed" });
  });

  it("copies the current text of an unflushed descendant and note", async () => {
    const child = { ...bullet("child", 1_024), parentId: "one" };
    const notesApi = recording([bullet("one", 1_024), child, bullet("two", 2_048)]);
    const store = new NotesStore(notesApi);
    await store.bootstrap();
    store.setDraft("child", "Draft child");
    store.setNoteDraft("child", "Draft context");

    await store.duplicate("one", "page-1", null);

    expect(sent(notesApi).map((command) => command.kind))
      .toEqual(["updateText", "updateNote", "duplicate"]);
  });

  it("flushes a pending note draft before indenting", async () => {
    const notesApi = recording();
    const store = new NotesStore(notesApi);
    await store.bootstrap();
    store.setNoteDraft("two", "Draft context");

    await store.indent("two", "one");

    expect(sent(notesApi).map((command) => command.kind))
      .toEqual(["updateNote", "indent"]);
  });

  it("leaves a split as the only command the keystroke sends", async () => {
    const notesApi = recording();
    const store = new NotesStore(notesApi);
    await store.bootstrap();
    store.setDraft("one", "AAABBB");

    await store.beginSplitNode({
      id: "one",
      parentId: "page-1",
      beforeId: "two",
      prefix: "AAA",
      suffix: "BBB"
    }).committed;

    expect(sent(notesApi).map((command) => command.kind)).toEqual(["splitNode"]);
  });

  it("keeps the blanking edit first and alone under the removal group", async () => {
    const notesApi = recording();
    const store = new NotesStore(notesApi);
    await store.bootstrap();
    store.setDraft("one", "");

    await store.beginRemoveEmptyNode("one", "backspace:1").committed;

    const calls = vi.mocked(notesApi.execute).mock.calls;
    const group = calls[0][0].historyGroup;
    expect(group).toMatch(/^backspace:1(:\d+)?$/);
    expect(calls.map(([envelope]) => [
      envelope.command.kind,
      envelope.historyGroup
    ])).toEqual([
      ["updateText", group],
      ["removeEmptyNode", group]
    ]);
  });
});

describe("NotesStore 재부트스트랩", () => {
  it("가이드를 쓰거나 다시 만든 뒤 새 스냅샷을 받아들인다", async () => {
    // `writeGuide`와 `rebuildFromVault`가 하는 일이 이것뿐이다: 백엔드가
    // 창 뒤에서 행을 바꿔 놓았으니 다시 읽어야 한다. 첫 부트스트랩에서
    // 돌아오지 않으면 창은 아무도 알려주지 않은 리비전을 들고 있고, 다음
    // 키 입력이 거부된다.
    const notes = api(async () => boot.viewport as ViewportPage);
    const store = new NotesStore(notes);
    await store.bootstrap();

    notes.bootstrap = vi.fn().mockResolvedValue({
      ...boot,
      revision: 13,
      viewport: {
        ...(boot.viewport as ViewportPage),
        nodes: [bullet("guide", 1024)]
      }
    });
    await store.bootstrap();

    expect(store.getSnapshot().revision).toBe(13);
    expect(store.getSnapshot().nodes.map((row) => row.id)).toEqual(["guide"]);
  });

  it("이미 읽는 중이면 두 번 읽지 않는다", async () => {
    const notes = api(async () => boot.viewport as ViewportPage);
    const store = new NotesStore(notes);

    await Promise.all([store.bootstrap(), store.bootstrap()]);

    expect(notes.bootstrap).toHaveBeenCalledTimes(1);
  });
});

describe("다른 기기의 변경 흡수", () => {
  it("보고 있는 페이지와 페이지 목록을 다시 읽는다", async () => {
    // Home now holds a page this window has never heard of, and the page it
    // is looking at gained a row.
    const notes = api(async () => ({
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: [bullet("three", 3072)]
    }));
    notes.pages = vi.fn().mockResolvedValue([
      { id: "page-1", title: "Today", sortKey: 1_024 },
      { id: "page-2", title: "Made there", sortKey: 2_048 }
    ]);
    const store = new NotesStore(notes);
    await store.bootstrap();

    await store.absorbVaultChange();

    expect(store.getSnapshot().pages.map((entry) => entry.id)).toEqual([
      "page-1",
      "page-2"
    ]);
    expect(store.getSnapshot().nodes.map((row) => row.id)).toEqual(["three"]);
  });

  it("페이지 목록은 루트 뷰포트를 읽지 않는다", async () => {
    // 루트 창은 하위 트리 전체를 행 수 제한까지만 실어 오고, 읽는 김에
    // 마지막으로 연 페이지까지 루트로 바꿔 놓는다. 목록은 자기 질의로 읽어야
    // 페이지가 잘리지도, 재시작 위치가 밀리지도 않는다.
    const queryViewport = vi.fn(async (request: ViewportRequest) => ({
      pageId: request.pageId,
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: [bullet("three", 3072)]
    }));
    const notes = api(queryViewport);
    const store = new NotesStore(notes);
    await store.bootstrap();

    // 이름이 너무 많아 한 줄씩 고쳐 넣기를 포기하는 폭이라 다시 읽는다.
    await store.absorbVaultChange({
      revision: 9,
      changedNodeIds: Array.from({ length: 200 }, (_, index) => `node-${index}`),
      deletedNodeIds: []
    });

    expect(notes.pages).toHaveBeenCalled();
    expect(queryViewport.mock.calls.map(([request]) => request.pageId))
      .not.toContain("root");
  });
});

describe("다른 기기의 변경 흡수 — 이름이 온 경우", () => {
  it("바뀐 노드만 가져와 반영하고 페이지를 다시 읽지 않는다", async () => {
    const queryViewport = vi.fn(async () => boot.viewport as ViewportPage);
    const notes = api(queryViewport);
    notes.queryForest = vi.fn(async () => ({
      revision: 9,
      nodes: [{ ...bullet("one", 1024), text: "그쪽에서 고친 것" }],
      complete: true
    }));
    const store = new NotesStore(notes);
    await store.bootstrap();
    queryViewport.mockClear();

    await store.absorbVaultChange({
      revision: 9,
      changedNodeIds: ["one"],
      deletedNodeIds: []
    });

    expect(store.getSnapshot().nodes.map((row) => row.text)).toEqual([
      "그쪽에서 고친 것",
      "two"
    ]);
    expect(queryViewport).not.toHaveBeenCalled();
    expect(store.getSnapshot().revision).toBe(9);
  });

  it("삭제된 줄은 사라지고 나머지는 그대로다", async () => {
    const notes = api(async () => boot.viewport as ViewportPage);
    notes.queryForest = vi.fn(async () => ({
      revision: 9,
      nodes: [],
      complete: true
    }));
    const store = new NotesStore(notes);
    await store.bootstrap();

    await store.absorbVaultChange({
      revision: 9,
      changedNodeIds: [],
      deletedNodeIds: ["one"]
    });

    expect(store.getSnapshot().nodes.map((row) => row.id)).toEqual(["two"]);
  });

  it("한 화면보다 넓게 바뀌면 페이지를 다시 읽는다", async () => {
    const queryViewport = vi.fn(async () => boot.viewport as ViewportPage);
    const notes = api(queryViewport);
    notes.queryForest = vi.fn();
    const store = new NotesStore(notes);
    await store.bootstrap();
    queryViewport.mockClear();

    await store.absorbVaultChange({
      revision: 9,
      changedNodeIds: Array.from({ length: 200 }, (_, index) => `node-${index}`),
      deletedNodeIds: []
    });

    expect(notes.queryForest).not.toHaveBeenCalled();
    expect(queryViewport).toHaveBeenCalled();
  });

  it("한 화면보다 넓은 변경도 그 리비전을 창에 남긴다", async () => {
    // 페이지를 통째로 다시 읽은 답에는 리비전이 없다. 그래도 창이 보고
    // 있는 행은 그 리비전의 것이니, 창의 번호도 거기로 가야 한다 --
    // 그러지 않으면 다음 키 입력이 revision conflict로 거부된다.
    const queryViewport = vi.fn(async () => boot.viewport as ViewportPage);
    const notes = api(queryViewport);
    notes.queryForest = vi.fn();
    const store = new NotesStore(notes);
    await store.bootstrap();

    await store.absorbVaultChange({
      revision: 9,
      changedNodeIds: Array.from({ length: 200 }, (_, index) => `node-${index}`),
      deletedNodeIds: []
    });

    expect(store.getSnapshot().revision).toBe(9);
  });

  it("페이지를 다시 읽지 못했으면 리비전도 옮기지 않는다", async () => {
    // 못 본 행 위에서 편집을 받아 주면 다른 기기가 쓴 것을 덮는다. 거부되는
    // 키 입력이 정직한 답이다.
    const queryViewport = vi.fn(async () => {
      throw new Error("페이지를 읽을 수 없다");
    });
    const notes = api(queryViewport);
    notes.queryForest = vi.fn();
    const store = new NotesStore(notes);
    await store.bootstrap();

    await store.absorbVaultChange({
      revision: 9,
      changedNodeIds: Array.from({ length: 200 }, (_, index) => `node-${index}`),
      deletedNodeIds: []
    });

    expect(store.getSnapshot().revision).toBe(boot.revision);
  });

  it("느린 다시 읽기가 그 뒤에 온 리비전을 뒤로 끌지 않는다", async () => {
    // 넓은 변경의 다시 읽기가 아직 오지 않은 사이에 좁은 변경이 도착해
    // 리비전을 더 올려 놓는다. 뒤늦게 도착한 답이 창의 번호를 되돌리면
    // 다음 키 입력이 거부되고, 이번에는 다른 변경이 오지 않는 한 아무도
    // 고쳐 주지 않는다.
    const releases: Array<(page: ViewportPage) => void> = [];
    const notes = api(async (request) =>
      request.pageId === "root"
        ? {
            pageId: "root",
            anchorId: null,
            beforeCursor: null,
            afterCursor: null,
            nodes: [page("page-1", "Today")]
          }
        : new Promise<ViewportPage>((resolve) => { releases.push(resolve); })
    );
    notes.queryForest = vi.fn(async () => ({
      revision: 16,
      nodes: [{ ...bullet("one", 1024), text: "그쪽에서 고친 것" }],
      complete: true
    }));
    const store = new NotesStore(notes);
    await store.bootstrap();

    const wide = store.absorbVaultChange({
      revision: 14,
      changedNodeIds: Array.from({ length: 200 }, (_, index) => `node-${index}`),
      deletedNodeIds: []
    });
    await store.absorbVaultChange({
      revision: 16,
      changedNodeIds: ["one"],
      deletedNodeIds: []
    });
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases[0](boot.viewport as ViewportPage);
    await wide;

    expect(store.getSnapshot().revision).toBe(16);
  });

  it("스크롤이 다시 읽기를 앞질러도 못 본 행 위로 리비전을 옮기지 않는다", async () => {
    // 다음 화면을 더 읽어 오는 것은 페이지를 넘겨받는 것이 아니다. 머리쪽
    // 행은 병합 전 그대로인데 리비전만 옮겨 주면, 그 행에 친 편집이 통과해서
    // 다른 기기가 쓴 것을 덮는다.
    const releases: Array<(page: ViewportPage) => void> = [];
    const notes = api(async (request) => {
      if (request.pageId === "root") {
        return {
          pageId: "root",
          anchorId: null,
          beforeCursor: null,
          afterCursor: null,
          nodes: [page("page-1", "Today")]
        };
      }
      if (request.afterCursor) {
        return {
          pageId: "page-1",
          anchorId: null,
          beforeCursor: null,
          afterCursor: null,
          nodes: [bullet("three", 3072)]
        };
      }
      return new Promise<ViewportPage>((resolve) => { releases.push(resolve); });
    });
    notes.queryForest = vi.fn();
    const store = new NotesStore(notes);
    await store.bootstrap();

    const wide = store.absorbVaultChange({
      revision: 9,
      changedNodeIds: Array.from({ length: 200 }, (_, index) => `node-${index}`),
      deletedNodeIds: []
    });
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    await store.loadMore();
    releases[0](boot.viewport as ViewportPage);
    await wide;

    expect(store.getSnapshot().revision).toBe(boot.revision);
  });

  it("열린 페이지가 없으면 리비전만 옮긴다", async () => {
    // 화면에 행이 없으니 낡을 것도 없다. 여기서 번호를 붙들면 페이지를 여는
    // 첫 편집이 거부된다.
    const notes = api(async () => boot.viewport as ViewportPage);
    notes.bootstrap = vi.fn().mockResolvedValue({
      ...boot,
      activePageId: null,
      viewport: null
    });
    notes.queryForest = vi.fn();
    const store = new NotesStore(notes);
    await store.bootstrap();

    await store.absorbVaultChange({
      revision: 9,
      changedNodeIds: Array.from({ length: 200 }, (_, index) => `node-${index}`),
      deletedNodeIds: []
    });

    expect(store.getSnapshot().revision).toBe(9);
  });

  /**
   * The row the caret sits in is gone when the page comes back, which is the
   * state the two tests below are about: `confirmedText` finds nothing for
   * `"one"`, so a draft left behind reads as text still to be written.
   */
  function afterDeletingOne(): NotesApi {
    const notes = api(async (request) =>
      request.pageId === "root"
        ? {
            pageId: "root",
            anchorId: null,
            beforeCursor: null,
            afterCursor: null,
            nodes: [page("page-1", "Today")]
          }
        : {
            pageId: "page-1",
            anchorId: null,
            beforeCursor: null,
            afterCursor: null,
            nodes: [bullet("two", 2048)]
          }
    );
    notes.execute = vi.fn().mockResolvedValue({
      revision: 10,
      changedNodes: [],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });
    return notes;
  }

  /** Wide enough to decline the row-by-row patch, so the page is re-read. */
  const wideChangeDeletingOne = {
    revision: 9,
    changedNodeIds: Array.from({ length: 200 }, (_, index) => `node-${index}`),
    deletedNodeIds: ["one"]
  };

  it("페이지를 다시 읽을 때도 지워진 줄에 치던 글은 보내지 않는다", async () => {
    const notes = afterDeletingOne();
    const store = new NotesStore(notes);
    await store.bootstrap();

    // Fake timers before the drafts: the debounce these arm is the thing under
    // test, so it has to be one this test can advance.
    vi.useFakeTimers();
    store.setDraft("one", "치던 글");
    store.setNoteDraft("one", "치던 메모");
    await store.absorbVaultChange(wideChangeDeletingOne);
    await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
    vi.useRealTimers();

    expect(notes.queryForest).not.toHaveBeenCalled();
    expect(store.getSnapshot().nodes.map((row) => row.id)).toEqual(["two"]);
    expect(vi.mocked(notes.execute).mock.calls).toEqual([]);
  });

  it("다시 읽은 다음 다른 명령이 와도 지워진 줄에 치던 글은 나가지 않는다", async () => {
    const notes = afterDeletingOne();
    const store = new NotesStore(notes);
    await store.bootstrap();

    // Fake timers with nothing to advance: this one is about the flush every
    // command runs, not the debounce, so the debounce must not get to fire.
    vi.useFakeTimers();
    store.setDraft("one", "치던 글");
    await store.absorbVaultChange(wideChangeDeletingOne);
    await store.setStarred("two", true);
    vi.useRealTimers();

    expect(notes.queryForest).not.toHaveBeenCalled();
    expect(store.getSnapshot().nodes.map((row) => row.id)).toEqual(["two"]);
    expect(vi.mocked(notes.execute).mock.calls.map(
      ([envelope]) => envelope.command.kind
    )).toEqual(["setStarred"]);
  });

  it("돌아온 답이 잘렸으면 페이지를 다시 읽는다", async () => {
    const queryViewport = vi.fn(async () => boot.viewport as ViewportPage);
    const notes = api(queryViewport);
    notes.queryForest = vi.fn(async () => ({
      revision: 9,
      nodes: [bullet("one", 1024)],
      complete: false
    }));
    const store = new NotesStore(notes);
    await store.bootstrap();
    queryViewport.mockClear();

    await store.absorbVaultChange({
      revision: 9,
      changedNodeIds: ["one"],
      deletedNodeIds: []
    });

    expect(queryViewport).toHaveBeenCalled();
  });
});

function page(id: string, title: string): NoteView {
  return { ...bullet(id, 1_024), parentId: "root", text: title };
}

describe("NotesStore collapse batches", () => {
  it("folds a range collapse into one undo entry", async () => {
    const collapsing = backend();
    const store = new NotesStore(collapsing.notesApi);
    await store.bootstrap();
    const history = vi.fn();
    store.subscribeHistory(history);

    await store.setCollapsedMany([
      { id: "one", collapsed: true },
      { id: "two", collapsed: true }
    ]);

    expect(collapsing.commands()).toEqual([
      { kind: "setCollapsed", id: "one", collapsed: true },
      { kind: "setCollapsed", id: "two", collapsed: true }
    ]);
    expect(new Set(collapsing.groups()).size).toBe(1);
    // A guide click closes a whole range, and one undo owes the user all of it
    // back rather than one row per press.
    expect(history).toHaveBeenCalledOnce();
  });

  it("stays off the wire when the range needs no change", async () => {
    const quiet = backend();
    const store = new NotesStore(quiet.notesApi);
    await store.bootstrap();

    await store.setCollapsedMany([]);

    expect(quiet.commands()).toEqual([]);
  });
});
