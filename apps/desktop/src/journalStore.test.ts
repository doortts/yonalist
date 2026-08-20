import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { CommandEnvelope } from "../../../packages/contracts/generated/CommandEnvelope";
import type { NotesApi } from "./api";
import { NotesStore } from "./notesStore";
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
      { id: "page-1", title: "Page", sortKey: 1_024 }
    ]);

    const id = await store.openJournal("2026-08-21");
    await store.createNode(id, "first line");

    expect(commands(api)[0]).toEqual({
      kind: "createNode",
      id,
      parent_id: "root",
      before_id: null,
      text: "2026-08-21"
    });
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
