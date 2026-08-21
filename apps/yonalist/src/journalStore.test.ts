import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { CommandEnvelope } from "../../../packages/contracts/generated/CommandEnvelope";
import type { NotesApi } from "./api";
import { NotesStore } from "./notesStore";
import { JOURNALS_ID } from "./store/storeSupport";
import { appApi } from "./test/appApiFixture";

function boot(pages: BootSnapshot["pages"]): BootSnapshot {
  return {
    sessionId: "session-1",
    revision: 1,
    activePageId: "page-1",
    pages,
    viewport: {
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: []
    },
    history: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
  };
}

async function readyStore(pages: BootSnapshot["pages"]): Promise<{
  readonly store: NotesStore;
  readonly api: NotesApi;
}> {
  const api: NotesApi = {
    ...appApi(),
    bootstrap: vi.fn().mockResolvedValue(boot(pages)),
    queryViewport: vi.fn().mockImplementation(async (request) => ({
      pageId: request.pageId,
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: []
    }))
  };
  const store = new NotesStore(api);
  await store.bootstrap();
  return { store, api };
}

function commands(api: NotesApi): readonly CommandEnvelope["command"][] {
  return vi.mocked(api.execute).mock.calls.map(([envelope]) => envelope.command);
}

describe("openJournal", () => {
  it("opens a day that already has a page, and writes nothing", async () => {
    const { store, api } = await readyStore([
      { id: "page-1", title: "Page", sortKey: 1_024 },
      { id: "journal-1", title: "2026-08-21", sortKey: 2_048 }
    ]);

    const id = await store.openJournal("2026-08-21");

    expect(id).toBe("journal-1");
    expect(store.getSnapshot().activePageId).toBe("journal-1");
    expect(api.execute).not.toHaveBeenCalled();
  });

  it("leaves nothing behind for a day nobody has written in", async () => {
    const { store, api } = await readyStore([
      { id: "page-1", title: "Page", sortKey: 1_024 }
    ]);

    const id = await store.openJournal("2026-08-21");

    expect(store.getSnapshot().activePageId).toBe(id);
    expect(store.getSnapshot().provisionalPageId).toBe(id);
    expect(api.execute).not.toHaveBeenCalled();
  });

  it("carries the date into the page the first write creates", async () => {
    const { store, api } = await readyStore([
      { id: "page-1", title: "Page", sortKey: 1_024 },
      { id: JOURNALS_ID, title: "Journals", sortKey: 2_048 }
    ]);

    const id = await store.openJournal("2026-08-21");
    await store.createNode(id, "first line");

    expect(commands(api)[0]).toEqual({
      kind: "createNode",
      id,
      parent_id: JOURNALS_ID,
      before_id: null,
      text: "2026-08-21"
    });
  });

  it("creates the day when rows are carried into it", async () => {
    const { store, api } = await readyStore([
      { id: "page-1", title: "Page", sortKey: 1_024 },
      { id: JOURNALS_ID, title: "Journals", sortKey: 2_048 }
    ]);

    const id = await store.openJournal("2026-08-21");
    await store.moveNodes([
      { id: "row-1", parentId: id, beforeId: null }
    ]);

    // Without the page, the move has nowhere to land: a carry-over into a day
    // nobody has written in yet is the first write that day gets.
    expect(commands(api)[0]).toEqual({
      kind: "createNode",
      id,
      parent_id: JOURNALS_ID,
      before_id: null,
      text: "2026-08-21"
    });
  });

  it("makes the Journals node before the first day hangs from it", async () => {
    const { store, api } = await readyStore([
      { id: "page-1", title: "Page", sortKey: 1_024 }
    ]);

    const id = await store.openJournal("2026-08-21");
    await store.createNode(id, "first line");

    // The node comes first: a day sent ahead of it names a parent the backend
    // has never heard of.
    expect(commands(api).slice(0, 2)).toEqual([
      {
        kind: "createNode",
        id: JOURNALS_ID,
        parent_id: "root",
        before_id: null,
        text: "Journals"
      },
      {
        kind: "createNode",
        id,
        parent_id: JOURNALS_ID,
        before_id: null,
        text: "2026-08-21"
      }
    ]);
  });

  it("writes the Journals node once, however many days arrive", async () => {
    const { store, api } = await readyStore([
      { id: "page-1", title: "Page", sortKey: 1_024 },
      { id: JOURNALS_ID, title: "Journals", sortKey: 2_048 }
    ]);

    const id = await store.openJournal("2026-08-21");
    await store.createNode(id, "first line");

    expect(
      commands(api).filter((command) =>
        command.kind === "createNode" && command.id === JOURNALS_ID)
    ).toEqual([]);
  });

  it("finds the day again once its receipt has landed", async () => {
    const { store, api } = await readyStore([
      { id: "page-1", title: "Page", sortKey: 1_024 },
      { id: JOURNALS_ID, title: "Journals", sortKey: 2_048 }
    ]);
    // The receipt states what landed, and the page list it leaves behind is
    // what the next Today press reads.
    let revision = 1;
    vi.mocked(api.execute).mockImplementation(async (envelope) => {
      const command = envelope.command;
      revision += 1;
      return {
        revision,
        changedNodes: command.kind === "createNode"
          ? [{
            id: command.id,
            parentId: command.parent_id,
            sortKey: 4_096,
            kind: "bullet",
            image: null,
            text: command.text,
            note: "",
            marker: "bullet",
            collapsed: false,
            completed: false,
            starred: false,
            deleted: false
          }]
          : [],
        deletedIds: [],
        history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
      };
    });

    const first = await store.openJournal("2026-08-21");
    await store.createNode(first, "first line");
    const again = await store.openJournal("2026-08-21");

    expect(again).toBe(first);
    expect(commands(api).filter((command) =>
      command.kind === "createNode" && command.text === "2026-08-21"))
      .toHaveLength(1);
  });

  it("shows the date as the open page's title before anything is written", async () => {
    const { store } = await readyStore([
      { id: "page-1", title: "Page", sortKey: 1_024 }
    ]);

    const id = await store.openJournal("2026-08-21");

    expect(store.getSnapshot().pageNode).toMatchObject({
      id,
      text: "2026-08-21"
    });
  });
});
