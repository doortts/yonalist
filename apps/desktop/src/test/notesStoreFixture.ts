import type { BootSnapshot } from "../../../../packages/contracts/generated/BootSnapshot";
import type { NotesApi } from "../api";
import { NotesStore } from "../notesStore";

export async function readyRealStore(): Promise<NotesStore> {
  const boot: BootSnapshot = {
    sessionId: "session-1",
    revision: 1,
    activePageId: "page-1",
    pages: [{ id: "page-1", title: "Page", sortKey: 1_024 }],
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
    importImagePaths: vi.fn(),
    replaceImageBytes: vi.fn(),
    replaceImagePath: vi.fn(),
    readImage: vi.fn(),
    viewImageOriginal: vi.fn(),
    downloadImage: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    search: vi.fn(),
    exportNotes: vi.fn(),
    closeSession: vi.fn(),
    unusedAssets: vi.fn(),
    deleteAllData: vi.fn(),
    syncVaultGet: vi.fn().mockResolvedValue(null),
    syncVaultSet: vi.fn(),
    syncConflicts: vi.fn().mockResolvedValue([]),
    syncFlush: vi.fn(),
    syncRestoreConflict: vi.fn()
  };
  const store = new NotesStore(api);
  await store.bootstrap();
  return store;
}
