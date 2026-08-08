import { act, fireEvent, render, waitFor } from "@testing-library/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { IpcEditorCommand } from "../../../packages/contracts/generated/IpcEditorCommand";
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
  const editor = monaco.editor.getEditors().at(-1)!;
  // jsdom reports a zero-sized host, which would leave the decoration window
  // one line wide and no picture inside it. One explicit layout is enough.
  await act(async () => {
    editor.layout({ width: 800, height: 600 });
    await frame();
  });
  return {
    api,
    store,
    registry,
    view,
    editor,
    session: lease.session,
    /** Monaco's hidden input — every key gesture enters the editor here. */
    keys: () => view.container.querySelector<HTMLTextAreaElement>(
      ".notes-monaco-outline textarea"
    )!,
    lines: () => lease.session.metadata.current().lines,
    kinds: () => lease.session.metadata.current().lines.map(
      (line) => line.kind
    ),
    async cleanup() {
      view.unmount();
      await lease.release();
      await registry.dispose();
    }
  };
}

function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** The last editor batch the store actually sent, flattened to commands. */
function sentCommands(api: NotesApi): readonly IpcEditorCommand[] {
  return vi.mocked(api.execute).mock.calls.flatMap(([envelope]) =>
    envelope.command.kind === "applyEditorBatch"
      ? envelope.command.commands
      : []);
}

/** One image on the clipboard, in the shape `clipboardImageCandidates` reads. */
function clipboard(name: string): Pick<DataTransfer, "items"> {
  const file = new File([Uint8Array.from([1, 2, 3])], name, {
    type: "image/png"
  });
  return {
    items: [{
      kind: "file",
      type: "image/png",
      getAsFile: () => file
    }] as unknown as DataTransferItemList
  };
}

function typeInto(
  session: { readonly model: monaco.editor.ITextModel },
  lineNumber: number,
  text: string
): void {
  const column = session.model.getLineMaxColumn(lineNumber);
  session.model.pushEditOperations([], [{
    range: new monaco.Range(lineNumber, column, lineNumber, column),
    text
  }], () => null);
}

describe("Monaco outline surface selection", () => {
  it("opens a page carrying a note and an image on the Monaco surface", async () => {
    const harness = await outline();

    expect(harness.view.container.querySelector(
      "[data-outline-surface]"
    )).toHaveAttribute("data-outline-surface", "monaco");
    expect(harness.view.container.querySelector(".notes-outline-list"))
      .toBeNull();
    expect(harness.kinds()).toEqual(["text", "note", "note", "image", "text"]);
    expect(harness.session.model.getValue()).toBe(
      "First thought\nalpha\nbeta\ncat.png\nSecond thought"
    );
    expect(document.querySelectorAll(".yonalist-outline-image-zone"))
      .toHaveLength(1);

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

describe("Monaco outline supporting notes", () => {
  it("opens, edits, saves and removes a note run without leaving the editor", async () => {
    const harness = await outline([bullet("bullet-1", "First thought", 1_024)]);
    const keys = harness.keys();

    // N1: Shift+Enter on the title opens the run and takes the caret with it.
    harness.editor.setPosition({ lineNumber: 1, column: 14 });
    fireEvent.keyDown(keys, { key: "Enter", shiftKey: true });
    expect(harness.kinds()).toEqual(["text", "note"]);
    expect(harness.editor.getPosition()?.lineNumber).toBe(2);

    // N5: the note text is the node's, so the batch carries updateNote.
    typeInto(harness.session, 2, "why it matters");
    await harness.session.flush("blur");
    expect(sentCommands(harness.api)).toContainEqual({
      kind: "updateNote",
      id: "bullet-1",
      note: "why it matters"
    });

    // N4: Backspace at the front of an empty run removes it and comes home.
    harness.session.model.pushEditOperations([], [{
      range: new monaco.Range(2, 1, 2, harness.session.model
        .getLineMaxColumn(2)),
      text: ""
    }], () => null);
    harness.editor.setPosition({ lineNumber: 2, column: 1 });
    fireEvent.keyDown(keys, { key: "Backspace" });
    expect(harness.kinds()).toEqual(["text"]);
    expect(harness.editor.getPosition()).toEqual(
      expect.objectContaining({ lineNumber: 1, column: 14 })
    );

    await harness.cleanup();
  });

  it("takes a collapsed parent's whole block, note run and picture, out of view", async () => {
    const harness = await outline([
      bullet("bullet-1", "First thought", 1_024),
      {
        ...bullet("child", "A child", 2_048, "kept out of sight"),
        parentId: "bullet-1"
      },
      { ...picture("image-1", "cat.png", 3_072), parentId: "bullet-1" }
    ]);
    expect(harness.kinds()).toEqual(["text", "text", "note", "image"]);
    expect(document.querySelectorAll(".yonalist-outline-image-zone"))
      .toHaveLength(1);

    // N6: the run and the picture travel with the title they hang off, so the
    // pane recomputes hidden areas across the whole block.
    await act(async () => {
      harness.session.toggleCollapsed("bullet-1");
      await frame();
    });
    expect(document.querySelectorAll(".yonalist-outline-image-zone"))
      .toHaveLength(0);

    await act(async () => {
      harness.session.toggleCollapsed("bullet-1");
      await frame();
    });
    expect(document.querySelectorAll(".yonalist-outline-image-zone"))
      .toHaveLength(1);

    await harness.cleanup();
  });
});

describe("Monaco outline image rows", () => {
  it("saves a caption as the image node's own text", async () => {
    const harness = await outline([picture("image-1", "cat.png", 1_024)]);

    // I7: the caption is the node's text, so it takes the ordinary updateText.
    typeInto(harness.session, 1, " on a wall");
    await harness.session.flush("blur");

    expect(sentCommands(harness.api)).toEqual([{
      kind: "updateText",
      id: "image-1",
      text: "cat.png on a wall"
    }]);

    await harness.cleanup();
  });

  it("commits one resize gesture after the editor queue has drained", async () => {
    const harness = await outline([picture("image-1", "cat.png", 1_024)]);
    // An unsaved title edit is what proves the drain: it has to reach the
    // backend before the resize claims a revision (design §5).
    typeInto(harness.session, 1, "!");
    const handle = document.querySelector(".yonalist-outline-image-resize")!;

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 7,
      clientX: 400
    });
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 500 });
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 500 });

    await waitFor(() => expect(vi.mocked(harness.api.execute).mock.calls
      .some(([envelope]) => envelope.command.kind === "resizeImage"))
      .toBe(true));
    const kinds = vi.mocked(harness.api.execute).mock.calls.map(
      ([envelope]) => envelope.command.kind
    );
    // I4: one gesture, one write, and the batch went first.
    expect(kinds).toEqual(["applyEditorBatch", "resizeImage"]);
    expect(vi.mocked(harness.api.execute).mock.calls.at(-1)?.[0].command)
      .toEqual({ kind: "resizeImage", id: "image-1", display_width: 500 });

    await harness.cleanup();
  });

  it("pastes an image into the editor and undoes it through the store", async () => {
    const harness = await outline([bullet("bullet-1", "First thought", 1_024)]);
    vi.mocked(harness.api.importImageBytes).mockImplementation(
      async (request) => receipt(8, [{
        ...picture("image-new", "dog.png", 2_048),
        id: request.images[0]!.nodeId
      }])
    );
    harness.editor.setPosition({ lineNumber: 1, column: 1 });

    fireEvent.paste(harness.editor.getDomNode()!, {
      clipboardData: clipboard("dog.png")
    });

    await waitFor(() => expect(harness.kinds()).toEqual(["text", "image"]));
    expect(harness.session.model.getValue())
      .toBe("First thought\ndog.png");
    // The Phase 4 trap: the ingest must not take the surface with it.
    expect(harness.view.container.querySelector(".notes-monaco-outline"))
      .not.toBeNull();

    // I6: the inverse of an image creation is a subtree delete, which no
    // editor batch can carry — one undo step hands it to the store instead.
    await act(() => harness.session.undo());
    await waitFor(() => expect(harness.kinds()).toEqual(["text"]));
    expect(vi.mocked(harness.api.execute).mock.calls.map(
      ([envelope]) => envelope.command.kind
    )).toContain("deleteSubtrees");

    await act(() => harness.session.redo());
    await waitFor(() => expect(harness.kinds()).toEqual(["text", "image"]));
    expect(vi.mocked(harness.api.execute).mock.calls.map(
      ([envelope]) => envelope.command.kind
    )).toContain("restoreSubtree");

    await harness.cleanup();
  });
});

describe("Monaco outline fallback boundary", () => {
  it("falls back to React for a page the viewport query could not finish", async () => {
    const api = outlineApi([bullet("bullet-1", "First thought", 1_024)]);
    vi.mocked(api.queryViewport).mockResolvedValue({
      ...boot([]).viewport!,
      afterCursor: "cursor-50000",
      nodes: [bullet("bullet-1", "First thought", 1_024)]
    });
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

    await waitFor(() => expect(view.container.querySelector(
      "[data-outline-fallback='monaco-unsupported']"
    )).not.toBeNull());
    expect(view.container.querySelector(".notes-monaco-outline")).toBeNull();

    view.unmount();
    await registry.dispose();
  });
});
