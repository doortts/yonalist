import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { ImageCandidate } from "../imageApi";
import {
  bindImageIngest,
  ingestImages,
  type MonacoImageIngestPort,
  type MonacoImageIngestSession,
  type MonacoImagePayload
} from "./imageIngest";

function imported(id: string): NoteView {
  return {
    id,
    parentId: "page",
    sortKey: 1_024,
    kind: "image",
    image: {
      contentHash: `${id}-hash`,
      originalName: `${id}.png`,
      mimeType: "image/png",
      byteLength: 128,
      pixelWidth: 800,
      pixelHeight: 400,
      displayWidth: 800
    },
    text: `${id}.png`,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

function candidates(count = 1): readonly ImageCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    originalName: `shot-${index}.png`,
    declaredMimeType: "image/png",
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })
  }));
}

function harness() {
  const order: string[] = [];
  const session = {
    canAcceptStructuralEdit: vi.fn().mockReturnValue(true),
    imageInsertionAnchor: vi.fn().mockReturnValue({
      parentId: "page",
      beforeId: null
    }),
    flush: vi.fn(async () => {
      order.push("flush");
    }),
    insertImageNodes: vi.fn((
      _input: Parameters<MonacoImageIngestSession["insertImageNodes"]>[0]
    ) => {
      order.push("insert");
      return 2 as number | null;
    }),
    reportExternalFailure: vi.fn()
  };
  const port = {
    import: vi.fn(async (
      _input: Parameters<MonacoImageIngestPort["import"]>[0]
    ) => {
      order.push("import");
      return { nodeIds: ["pic"], nodes: [imported("pic"), imported("other")] };
    }),
    importPaths: vi.fn(async (
      _input: Parameters<MonacoImageIngestPort["importPaths"]>[0]
    ) => {
      order.push("importPaths");
      return { nodeIds: ["pic"], nodes: [imported("pic")] };
    }),
    remove: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined)
  };
  const ingest = (nodeId: string | null, payload: MonacoImagePayload) =>
    ingestImages({
      session: session as unknown as MonacoImageIngestSession,
      port: port as unknown as MonacoImageIngestPort,
      nodeId,
      payload
    });
  return {
    session,
    port,
    order,
    ingest,
    run: (nodeId: string | null, images: readonly ImageCandidate[]) =>
      ingest(nodeId, { candidates: images })
  };
}

describe("ingestImages", () => {
  it("drains the session queue before the image IPC claims a revision", async () => {
    const { session, port, order, run } = harness();

    const lineNumber = await run("first", candidates(2));

    expect(order).toEqual(["flush", "import", "insert"]);
    expect(lineNumber).toBe(2);
    expect(session.flush).toHaveBeenCalledWith("blur");
    expect(port.import).toHaveBeenCalledWith({
      parentId: "page",
      beforeId: null,
      candidates: expect.any(Array)
    });
    // Only the nodes the import claims, in the order it created them.
    expect(session.insertImageNodes.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        anchor: { parentId: "page", beforeId: null },
        nodes: [imported("pic")]
      })
    );
  });

  it("sends the image undo to the store rather than the editor batch", async () => {
    const { session, port, run } = harness();

    await run(null, candidates());
    const external = session.insertImageNodes.mock.calls[0]?.[0].external!;

    await external.undo();
    expect(port.remove).toHaveBeenCalledWith(["pic"]);

    await external.redo();
    expect(port.restore).toHaveBeenCalledWith(["pic"]);
  });

  it("refuses the gesture while the session queue cannot take a change", async () => {
    const { session, port, run } = harness();
    session.canAcceptStructuralEdit.mockReturnValue(false);

    expect(await run("first", candidates())).toBeNull();

    expect(session.flush).not.toHaveBeenCalled();
    expect(port.import).not.toHaveBeenCalled();
  });

  it("retries a revision conflict once and then surfaces it on the queue", async () => {
    const conflict = Object.assign(new Error("stale"), {
      code: "revision_conflict"
    });
    const { session, port, run } = harness();
    port.import
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ nodeIds: ["pic"], nodes: [imported("pic")] });

    expect(await run("first", candidates())).toBe(2);
    expect(port.import).toHaveBeenCalledTimes(2);
    expect(session.flush).toHaveBeenCalledTimes(2);
    expect(session.reportExternalFailure).not.toHaveBeenCalled();

    port.import.mockReset();
    port.import.mockRejectedValue(conflict);
    session.insertImageNodes.mockClear();

    expect(await run("first", candidates())).toBeNull();
    expect(port.import).toHaveBeenCalledTimes(2);
    expect(session.reportExternalFailure).toHaveBeenCalledWith(conflict);
    expect(session.insertImageNodes).not.toHaveBeenCalled();
  });

  it("takes the anchor again when the conflicting write moved it", async () => {
    const conflict = Object.assign(new Error("stale"), {
      code: "revision_conflict"
    });
    const { session, port, order, run } = harness();
    // The write that won the revision deleted the node the first anchor
    // pointed at, so the second attempt must not aim at it again.
    session.imageInsertionAnchor.mockImplementation((nodeId: string | null) => {
      order.push(`anchor:${nodeId ?? "page"}`);
      if (nodeId === null) return { parentId: "page", beforeId: null };
      return session.imageInsertionAnchor.mock.calls.length === 1
        ? { parentId: "page", beforeId: "gone" }
        : null;
    });
    port.import.mockImplementationOnce(async () => {
      order.push("import");
      throw conflict;
    });

    expect(await run("first", candidates())).toBe(2);

    expect(order).toEqual([
      "anchor:first",
      "flush",
      "import",
      "flush",
      "anchor:first",
      "anchor:page",
      "import",
      "insert"
    ]);
    expect(port.import).toHaveBeenLastCalledWith(
      expect.objectContaining({ parentId: "page", beforeId: null })
    );
    expect(session.insertImageNodes.mock.calls[0]?.[0].anchor).toEqual({
      parentId: "page",
      beforeId: null
    });
  });

  it("leaves the session untouched when the import fails validation", async () => {
    const { session, port, run } = harness();
    port.import.mockRejectedValue(
      new Error("The declared image type is unsupported.")
    );

    await expect(run("first", candidates()))
      .rejects.toThrow("The declared image type is unsupported.");

    expect(port.import).toHaveBeenCalledOnce();
    expect(session.insertImageNodes).not.toHaveBeenCalled();
    expect(session.reportExternalFailure).not.toHaveBeenCalled();
  });

  it("does nothing without a supported image or an anchor", async () => {
    const { session, port, run } = harness();

    expect(await run("first", [])).toBeNull();

    session.imageInsertionAnchor.mockReturnValue(null);
    expect(await run("first", candidates())).toBeNull();
    expect(port.import).not.toHaveBeenCalled();
  });
});

function pngFile(name = "shot.png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

function clipboardEvent(files: readonly File[]): Event {
  const event = new Event("paste", { cancelable: true, bubbles: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: files.map((file) => ({
        kind: "file",
        type: file.type,
        getAsFile: () => file
      }))
    }
  });
  return event;
}

function dragEvent(
  type: string,
  files: readonly File[],
  clientY = 0
): Event {
  const event = new Event(type, { cancelable: true, bubbles: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files, dropEffect: "none" },
    writable: true
  });
  Object.defineProperty(event, "clientX", { value: 40 });
  Object.defineProperty(event, "clientY", { value: clientY });
  return event;
}

/** A page of four lines: a title, its two note lines, a picture caption. */
const lineNodeIds = ["bullet-1", "bullet-1", "bullet-1", "image-1"];

function boundHarness() {
  const base = harness();
  const host = document.createElement("div");
  document.body.append(host);
  const setPosition = vi.fn();
  const decorations: unknown[][] = [];
  // 25px lines, so y 60 is line 3 and y 90 is past the end.
  const editor = {
    getDomNode: () => host,
    setPosition,
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    focus: vi.fn(),
    getTargetAtClientPoint: (_x: number, y: number) => {
      const lineNumber = Math.floor(y / 25) + 1;
      return lineNumber > lineNodeIds.length
        ? { position: null }
        : { position: { lineNumber, column: 1 } };
    },
    createDecorationsCollection: () => ({
      set: (value: unknown[]) => decorations.push(value),
      clear: () => decorations.push([])
    })
  } as unknown as Parameters<typeof bindImageIngest>[0];
  const bound = bindImageIngest(editor, {
    session: {
      ...base.session,
      nodeIdAtLine: (lineNumber: number) =>
        lineNodeIds[lineNumber - 1] ?? null
    } as unknown as MonacoImageIngestSession,
    port: base.port as unknown as MonacoImageIngestPort,
    activeNodeId: () => "first"
  });
  return {
    ...base,
    host,
    setPosition,
    bound,
    decorations,
    dispose: bound.dispose
  };
}

describe("bindImageIngest", () => {
  it("takes a pasted image away from Monaco and imports it", async () => {
    const { host, port, setPosition, dispose } = boundHarness();
    const event = clipboardEvent([pngFile()]);

    host.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(port.import).toHaveBeenCalledOnce());
    expect(port.import.mock.calls[0]?.[0].candidates).toEqual([
      expect.objectContaining({
        originalName: "shot.png",
        declaredMimeType: "image/png"
      })
    ]);
    expect(setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 1 });
    dispose();
  });

  it("lets a text paste fall through to Monaco untouched", () => {
    const { host, port, dispose } = boundHarness();
    const event = new Event("paste", { cancelable: true, bubbles: true });
    Object.defineProperty(event, "clipboardData", {
      value: { items: [{ kind: "string", type: "text/plain" }] }
    });

    host.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(port.import).not.toHaveBeenCalled();
    dispose();
  });

  it("imports a file drop at the line it was dropped on", async () => {
    const { host, session, port, decorations, dispose } = boundHarness();
    // y 60 is line 3, a note line, which answers with its title's node.
    const over = dragEvent("dragover", [pngFile()], 60);

    host.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(decorations.at(-1)).toEqual([expect.objectContaining({
      range: expect.objectContaining({ startLineNumber: 3, endLineNumber: 3 }),
      options: expect.objectContaining({
        isWholeLine: true,
        className: "yonalist-outline-drop-target"
      })
    })]);

    const drop = dragEvent("drop", [pngFile("cat.png")], 80);
    host.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(true);
    expect(decorations.at(-1)).toEqual([]);
    await vi.waitFor(() => expect(port.import).toHaveBeenCalledOnce());
    // y 80 is line 4, the picture: the caret's node never came into it.
    expect(session.imageInsertionAnchor).toHaveBeenCalledWith("image-1");
    dispose();
  });

  it("drops the drag highlight when the pointer leaves", () => {
    const { host, decorations, dispose } = boundHarness();

    host.dispatchEvent(dragEvent("dragover", [pngFile()], 0));
    expect(decorations.at(-1)).toHaveLength(1);

    host.dispatchEvent(dragEvent("dragleave", [pngFile()], 0));

    expect(decorations.at(-1)).toEqual([]);
    dispose();
  });

  it("falls back to the active node when the point hits no line", async () => {
    const { host, session, port, decorations, dispose } = boundHarness();

    host.dispatchEvent(dragEvent("dragover", [pngFile()], 400));
    // The gesture still lands, so the marker shows the caret's line rather
    // than leaving the user with nothing to read.
    expect(decorations.at(-1)).toEqual([expect.objectContaining({
      range: expect.objectContaining({ startLineNumber: 1, endLineNumber: 1 })
    })]);
    host.dispatchEvent(dragEvent("drop", [pngFile("cat.png")], 400));

    await vi.waitFor(() => expect(port.import).toHaveBeenCalledOnce());
    expect(session.imageInsertionAnchor).toHaveBeenCalledWith("first");
    dispose();
  });

  it("still imports when neither the point nor the node has an anchor", async () => {
    const { session, port, bound, dispose } = boundHarness();
    // Nothing resolves: the point is off the editor and the caret's node is
    // one the metadata no longer titles. The page anchor takes the drop.
    session.imageInsertionAnchor.mockImplementation((nodeId: string | null) =>
      nodeId === null ? { parentId: "page", beforeId: null } : null);

    await bound.run({ paths: ["/tmp/cat.png"] }, { clientX: 40, clientY: 400 });

    expect(session.imageInsertionAnchor).toHaveBeenCalledWith("first");
    expect(session.imageInsertionAnchor).toHaveBeenCalledWith(null);
    expect(port.importPaths).toHaveBeenCalledWith({
      parentId: "page",
      beforeId: null,
      paths: ["/tmp/cat.png"]
    });
    dispose();
  });

  it("hands a refused import back to the caller instead of eating it", async () => {
    const { port, bound, dispose } = boundHarness();
    port.importPaths.mockRejectedValue(new Error("The image is too large."));

    await expect(bound.run({ paths: ["/tmp/cat.png"] }))
      .rejects.toThrow("The image is too large.");
    dispose();
  });

  it("anchors a native path drop at the point the pane reports", async () => {
    const { session, port, bound, decorations, dispose } = boundHarness();

    bound.markDropPoint({ clientX: 40, clientY: 0 });
    expect(decorations.at(-1)).toHaveLength(1);
    bound.run({ paths: ["/tmp/cat.png"] }, { clientX: 40, clientY: 80 });

    await vi.waitFor(() => expect(port.importPaths).toHaveBeenCalledOnce());
    // Running the gesture takes the drag feedback down with it.
    expect(decorations.at(-1)).toEqual([]);
    expect(session.imageInsertionAnchor).toHaveBeenCalledWith("image-1");
    dispose();
  });

  it("runs a native path drop through the same anchor and caret", async () => {
    const { session, port, order, bound, setPosition, dispose } =
      boundHarness();

    bound.run({ paths: ["/tmp/cat.png", "/tmp/dog.webp"] });

    await vi.waitFor(() => expect(port.importPaths).toHaveBeenCalledOnce());
    expect(order).toEqual(["flush", "importPaths", "insert"]);
    expect(session.imageInsertionAnchor).toHaveBeenCalledWith("first");
    expect(port.importPaths).toHaveBeenCalledWith({
      parentId: "page",
      beforeId: null,
      paths: ["/tmp/cat.png", "/tmp/dog.webp"]
    });
    expect(port.import).not.toHaveBeenCalled();
    expect(setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 1 });
    dispose();
  });

  it("ignores a drop that carries no supported image", () => {
    const { host, port, dispose } = boundHarness();
    const drop = dragEvent("drop", [
      new File(["<svg />"], "vector.svg", { type: "image/svg+xml" })
    ]);

    host.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(false);
    expect(port.import).not.toHaveBeenCalled();
    dispose();
  });
});
