import type { BootSnapshot } from "../../../../packages/contracts/generated/BootSnapshot";
import type { NotesApi } from "../api";
import { NotesStore } from "../notesStore";
import { appApi } from "./appApiFixture";

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
    ...appApi(),
    bootstrap: vi.fn().mockResolvedValue(boot),
    queryForest: vi.fn().mockResolvedValue({
      revision: 1,
      nodes: [],
      complete: true
    }),
    execute: vi.fn(),
    search: vi.fn()
  };
  const store = new NotesStore(api);
  await store.bootstrap();
  return store;
}
