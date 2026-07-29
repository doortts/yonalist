import type { BootSnapshot } from "../../../../packages/contracts/generated/BootSnapshot";
import type { NotesApi } from "../api";
import { NotesStore } from "../notesStore";

export async function readyRealStore(): Promise<NotesStore> {
  const boot: BootSnapshot = {
    sessionId: "session-1",
    revision: 1,
    activePageId: "page-1",
    pages: [{ id: "page-1", title: "Page" }],
    viewport: {
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: ["one", "two"].map((id, index) => ({
        id,
        parentId: "page-1",
        sortKey: (index + 1) * 1_024,
        kind: "bullet" as const, image: null,
        text: id,
        note: "",
        marker: "bullet" as const,
        collapsed: false,
        completed: false,
        starred: false,
        deleted: false
      }))
    },
    history: {
      canUndo: false,
      canRedo: false,
      undoDepth: 0,
      redoDepth: 0
    }
  };
  const api: NotesApi = {
    bootstrap: vi.fn().mockResolvedValue(boot),
    queryViewport: vi.fn(),
    queryForest: vi.fn().mockResolvedValue({
      revision: 1,
      nodes: [],
      complete: true
    }),
    execute: vi.fn(),
    importImageBytes: vi.fn(),
    readImage: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    search: vi.fn(),
    closeSession: vi.fn()
  };
  const store = new NotesStore(api);
  await store.bootstrap();
  return store;
}
