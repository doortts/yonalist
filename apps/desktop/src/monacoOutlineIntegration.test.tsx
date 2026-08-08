import { render, waitFor } from "@testing-library/react";

import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "./api";
import {
  MonacoOutlineSessionRegistry
} from "./monaco-outline/sessionRegistry";
import { NotesOutline } from "./NotesOutline";
import { NotesStore } from "./notesStore";
import { installMonacoDomStubs } from "./test/monacoDom";

installMonacoDomStubs();

function bullet(
  id: string,
  text: string,
  sortKey: number,
  note = ""
): NoteView {
  return {
    id,
    parentId: "page-1",
    sortKey,
    kind: "bullet",
    image: null,
    text,
    note,
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

function picture(id: string, caption: string, sortKey: number): NoteView {
  return {
    ...bullet(id, caption, sortKey),
    kind: "image",
    image: {
      contentHash: "a".repeat(64),
      originalName: "cat.png",
      mimeType: "image/png",
      byteLength: 4,
      pixelWidth: 800,
      pixelHeight: 400,
      displayWidth: 400
    }
  };
}

const mixedNodes: readonly NoteView[] = [
  bullet("bullet-1", "First thought", 1_024, "alpha\nbeta"),
  picture("image-1", "cat.png", 2_048),
  bullet("bullet-2", "Second thought", 3_072)
];

function boot(nodes: readonly NoteView[]): BootSnapshot {
  return {
    sessionId: "session-1",
    revision: 7,
    activePageId: "page-1",
    pages: [{ id: "page-1", title: "Today" }],
    viewport: {
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: [...nodes]
    },
    history: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
  };
}

function receipt(
  revision: number,
  changedNodes: readonly NoteView[] = []
): MutationReceipt {
  return {
    revision,
    changedNodes: [...changedNodes],
    deletedIds: [],
    history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
  };
}

function outlineApi(nodes: readonly NoteView[]): NotesApi {
  const snapshot = boot(nodes);
  return {
    bootstrap: vi.fn().mockResolvedValue(snapshot),
    queryViewport: vi.fn().mockResolvedValue(snapshot.viewport),
    queryForest: vi.fn().mockResolvedValue({
      revision: snapshot.revision,
      nodes: [],
      complete: true
    }),
    execute: vi.fn().mockResolvedValue(receipt(8)),
    importImageBytes: vi.fn(),
    importImagePaths: vi.fn(),
    replaceImageBytes: vi.fn(),
    replaceImagePath: vi.fn(),
    readImage: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3, 4])),
    viewImageOriginal: vi.fn(),
    downloadImage: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    search: vi.fn().mockResolvedValue({ hits: [], nextCursor: null }),
    exportNotes: vi.fn(),
    closeSession: vi.fn(),
    unusedAssets: vi.fn(),
    deleteAllData: vi.fn()
  };
}

async function outline(nodes: readonly NoteView[] = mixedNodes) {
  const api = outlineApi(nodes);
  const store = new NotesStore(api);
  await store.bootstrap();
  const registry = new MonacoOutlineSessionRegistry({
    loadMonacoPage: (pageId) => store.loadMonacoPage(pageId),
    executeEditorBatch: (requestId, commands) =>
      store.executeEditorBatch(requestId, commands)
  });
  const view = render(
    <NotesOutline
      store={store}
      status="ready"
      error={null}
      pendingWrites={0}
      page={{ id: "page-1", title: "Today" }}
      zoomRootId={null}
      onZoomRootChange={vi.fn()}
      onTagClick={vi.fn()}
      paneId="primary"
      restoreRequest={null}
      monacoSessions={registry}
    />
  );
  await waitFor(() => expect(
    view.container.querySelector(".notes-monaco-outline")
  ).not.toBeNull());
  // The registry shares one session per page, so the lease the test takes is
  // the very session the surface is editing.
  const lease = await registry.acquire("page-1");
  return {
    api,
    store,
    registry,
    view,
    session: lease.session,
    async cleanup() {
      view.unmount();
      await lease.release();
      await registry.dispose();
    }
  };
}

describe("Monaco outline surface selection", () => {
  it("opens a page carrying a note and an image on the Monaco surface", async () => {
    const harness = await outline();

    expect(harness.view.container.querySelector(
      "[data-outline-surface]"
    )).toHaveAttribute("data-outline-surface", "monaco");
    expect(harness.view.container.querySelector(".notes-outline-list"))
      .toBeNull();
    expect(harness.session.metadata.current().lines.map((line) => line.kind))
      .toEqual(["text", "note", "note", "image", "text"]);
    expect(harness.session.model.getValue()).toBe(
      "First thought\nalpha\nbeta\ncat.png\nSecond thought"
    );

    await harness.cleanup();
  });

  it("keeps the Monaco surface when the page gains an image node", async () => {
    const harness = await outline([bullet("bullet-1", "First thought", 1_024)]);
    vi.mocked(harness.api.importImageBytes).mockResolvedValue(
      receipt(8, [picture("image-new", "dog.png", 2_048)])
    );

    await harness.store.images.importAfter("page-1", null, [{
      blob: new Blob([Uint8Array.from([1])], { type: "image/png" }),
      originalName: "dog.png",
      declaredMimeType: "image/png"
    }]);

    await waitFor(() => expect(
      harness.store.getOutlineSnapshot().nodes.some(
        (node) => node.kind === "image"
      )
    ).toBe(true));
    expect(harness.view.container.querySelector(".notes-monaco-outline"))
      .not.toBeNull();
    expect(harness.view.container.querySelector(".notes-outline-list"))
      .toBeNull();
    expect(harness.view.container.querySelector(
      "[data-outline-fallback]"
    )).toBeNull();

    await harness.cleanup();
  });
});
