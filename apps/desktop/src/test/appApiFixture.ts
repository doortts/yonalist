import type { BootSnapshot } from "../../../../packages/contracts/generated/BootSnapshot";
import type { MutationReceipt } from "../../../../packages/contracts/generated/MutationReceipt";
import type { NotesApi } from "../api";

export const snapshot: BootSnapshot = {
  sessionId: "session-1",
  revision: 7,
  activePageId: "page-1",
  pages: [{ id: "page-1", title: "Today", sortKey: 1_024 }],
  viewport: {
    pageId: "page-1",
    anchorId: null,
    beforeCursor: null,
    afterCursor: null,
    pageNode: {
      id: "page-1",
      parentId: "root",
      sortKey: 1024,
      kind: "bullet", image: null,
      text: "Today",
      note: "",
      marker: "bullet",
      collapsed: false,
      completed: false,
      starred: false,
      deleted: false
    },
    nodes: [
      {
        id: "bullet-1",
        parentId: "page-1",
        sortKey: 1024,
        kind: "bullet", image: null,
        text: "First thought",
        note: "",
        marker: "bullet",
        collapsed: false,
        completed: false,
        starred: false,
        deleted: false
      },
      {
        id: "bullet-2",
        parentId: "page-1",
        sortKey: 2048,
        kind: "bullet", image: null,
        text: "Second thought",
        note: "",
        marker: "bullet",
        collapsed: false,
        completed: false,
        starred: false,
        deleted: false
      }
    ]
  },
  history: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
};

export function receipt(text: string): MutationReceipt {
  return {
    revision: 8,
    changedNodes: [
      {
        ...snapshot.viewport!.nodes[0],
        text
      }
    ],
    deletedIds: [],
    history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
  };
}

export function appApi(): NotesApi {
  return {
    bootstrap: vi.fn().mockResolvedValue(snapshot),
    queryViewport: vi.fn(),
    queryForest: vi.fn().mockImplementation(async (request) => ({
      revision: snapshot.revision,
      nodes: snapshot.viewport?.nodes.filter((node) =>
        request.rootIds.includes(node.id)) ?? [],
      complete: true
    })),
    execute: vi.fn().mockImplementation((envelope) =>
      Promise.resolve(receipt(
        envelope.command.kind === "updateText"
          ? envelope.command.text
          : "First thought"
      ))
    ),
    importImageBytes: vi.fn(),
    importImagePaths: vi.fn(),
    replaceImageBytes: vi.fn(),
    replaceImagePath: vi.fn(),
    readImage: vi.fn(),
    viewImageOriginal: vi.fn(),
    downloadImage: vi.fn(),
    exportNotes: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    search: vi.fn().mockResolvedValue({ hits: [], nextCursor: null }),
    closeSession: vi.fn(),
    unusedAssets: vi.fn(),
    deleteAllData: vi.fn(),
    syncVaultGet: vi.fn().mockResolvedValue(null),
    syncVaultSet: vi.fn(),
    rebuildFromVault: vi.fn().mockResolvedValue({
      documents: 0,
      unreadable: 0
    }),
    onboardingWriteGuide: vi.fn(),
    onboardingFirstRun: vi.fn().mockResolvedValue(false),
    syncConflicts: vi.fn().mockResolvedValue([]),
    syncFlush: vi.fn(),
    syncStatus: vi.fn().mockResolvedValue({
      refused: [], writeError: null, watchError: null
    }),
    syncAttachments: vi.fn(),
    syncDeleteAttachment: vi.fn(),
    syncRestoreConflict: vi.fn(),
    syncForgetConflict: vi.fn()
  };
}
