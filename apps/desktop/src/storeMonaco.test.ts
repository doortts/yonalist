import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { ViewportPage } from "../../../packages/contracts/generated/ViewportPage";
import type { NotesApi } from "./api";
import {
  MonacoPageUnsupportedError,
  NotesStore
} from "./notesStore";

function bullet(id: string, sortKey: number): NoteView {
  return {
    id,
    parentId: "page-1",
    sortKey,
    kind: "bullet",
    image: null,
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
  viewport: null,
  history: {
    canUndo: false,
    canRedo: false,
    undoDepth: 0,
    redoDepth: 0
  }
};

function api(queryViewport: NotesApi["queryViewport"]): NotesApi {
  return {
    bootstrap: vi.fn().mockResolvedValue(boot),
    queryViewport,
    queryForest: vi.fn(),
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
    deleteAllData: vi.fn()
  };
}

describe("NotesStore Monaco page bridge", () => {
  it("loads a complete text-only page at the settled store revision", async () => {
    const viewport: ViewportPage = {
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: [bullet("one", 1_024), bullet("two", 2_048)]
    };
    const queryViewport = vi.fn().mockResolvedValue(viewport);
    const store = new NotesStore(api(queryViewport));
    await store.bootstrap();

    const page = await store.loadMonacoPage("page-1");

    expect(queryViewport).toHaveBeenCalledWith({
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      limit: 50_000
    });
    expect(page).toEqual({ revision: 1, viewport });
  });

  it("rejects pages that need unsupported rich node rendering", async () => {
    const viewport: ViewportPage = {
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: [{ ...bullet("one", 1_024), note: "supporting note" }]
    };
    const store = new NotesStore(api(vi.fn().mockResolvedValue(viewport)));
    await store.bootstrap();

    await expect(store.loadMonacoPage("page-1"))
      .rejects.toBeInstanceOf(MonacoPageUnsupportedError);
  });
});
