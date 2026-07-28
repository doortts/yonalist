import type { BootSnapshot } from "../../../../packages/contracts/generated/BootSnapshot";
import type { MutationReceipt } from "../../../../packages/contracts/generated/MutationReceipt";
import type { NotesApi } from "../api";

export const snapshot: BootSnapshot = {
  sessionId: "session-1",
  revision: 7,
  activePageId: "page-1",
  pages: [{ id: "page-1", title: "Today" }],
  viewport: {
    pageId: "page-1",
    anchorId: null,
    beforeCursor: null,
    afterCursor: null,
    nodes: [
      {
        id: "bullet-1",
        parentId: "page-1",
        sortKey: 1024,
        kind: "bullet",
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
        kind: "bullet",
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
    undo: vi.fn(),
    redo: vi.fn(),
    search: vi.fn().mockResolvedValue({ hits: [], nextCursor: null }),
    closeSession: vi.fn()
  };
}
