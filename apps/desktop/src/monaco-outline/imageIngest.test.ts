import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { ImageCandidate } from "../imageApi";
import {
  bindImageIngest,
  ingestImages,
  type MonacoImageIngestPort,
  type MonacoImageIngestSession
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
    remove: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined)
  };
  return {
    session,
    port,
    order,
    run: (nodeId: string | null, images: readonly ImageCandidate[]) =>
      ingestImages({
        session: session as unknown as MonacoImageIngestSession,
        port: port as unknown as MonacoImageIngestPort,
        nodeId,
        candidates: images
      })
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

function dragEvent(type: string, files: readonly File[]): Event {
  const event = new Event(type, { cancelable: true, bubbles: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files, dropEffect: "none" },
    writable: true
  });
  return event;
}

function boundHarness() {
  const base = harness();
  const host = document.createElement("div");
  document.body.append(host);
  const setPosition = vi.fn();
  const editor = {
    getDomNode: () => host,
    setPosition,
    focus: vi.fn()
  } as unknown as Parameters<typeof bindImageIngest>[0];
  const dispose = bindImageIngest(editor, {
    session: base.session as unknown as MonacoImageIngestSession,
    port: base.port as unknown as MonacoImageIngestPort,
    activeNodeId: () => "first"
  });
  return { ...base, host, setPosition, dispose };
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

  it("imports an OS file drop at the active node's anchor", async () => {
    const { host, session, port, dispose } = boundHarness();
    const over = dragEvent("dragover", [pngFile()]);

    host.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);

    const drop = dragEvent("drop", [pngFile("cat.png")]);
    host.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(port.import).toHaveBeenCalledOnce());
    expect(session.imageInsertionAnchor).toHaveBeenCalledWith("first");
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
