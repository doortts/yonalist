import { describe, expect, it, vi } from "vitest";
import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";
import type { NotesApi } from "./api";
import type {
  ImageCandidate,
  ImageImportRequest,
  ImagePathImportRequest
} from "./imageApi";
import { NotesStore } from "./notesStore";
import { snapshot } from "./test/appApiFixture";

function candidates(): readonly ImageCandidate[] {
  return [
    {
      originalName: "cat.png",
      declaredMimeType: "image/png",
      blob: new Blob([Uint8Array.from([1, 2, 3])], { type: "image/png" })
    },
    {
      originalName: "dog.png",
      declaredMimeType: "image/png",
      blob: new Blob([Uint8Array.from([4, 5])], { type: "image/png" })
    }
  ];
}

function receiptFor(request: ImageImportRequest): MutationReceipt {
  return {
    revision: 8,
    changedNodes: request.images.map((image, index) => ({
      id: image.nodeId,
      parentId: request.parentId,
      sortKey: 1_500 + index,
      kind: "image",
      image: {
        contentHash: (index === 0 ? "a" : "b").repeat(64),
        originalName: image.originalName,
        mimeType: image.declaredMimeType ?? "image/png",
        byteLength: image.blob.size,
        pixelWidth: 1,
        pixelHeight: 1,
        displayWidth: 320
      },
      text: image.originalName,
      note: "",
      marker: "bullet",
      collapsed: false,
      completed: false,
      starred: false,
      deleted: false
    })),
    deletedIds: [],
    history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
  };
}

function api(
  importImageBytes: NotesApi["importImageBytes"],
  importImagePaths: NotesApi["importImagePaths"] = vi.fn()
): NotesApi {
  return {
    bootstrap: vi.fn().mockResolvedValue(snapshot),
    queryViewport: vi.fn(),
    queryForest: vi.fn(),
    execute: vi.fn(),
    importImageBytes,
    importImagePaths,
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

describe("StoreImages", () => {
  it("imports one ordered batch and applies one receipt/history event", async () => {
    const importImageBytes = vi.fn(async (request: ImageImportRequest) =>
      receiptFor(request));
    const store = new NotesStore(api(importImageBytes));
    await store.bootstrap();
    const history = vi.fn();
    store.subscribeHistory(history);

    const firstId = await store.images.importAfter(
      "page-1",
      "bullet-2",
      candidates()
    );

    expect(importImageBytes).toHaveBeenCalledOnce();
    const request = importImageBytes.mock.calls[0]![0];
    expect(request.images.map((image) => image.originalName)).toEqual([
      "cat.png",
      "dog.png"
    ]);
    expect(request.images.map((image) => image.nodeId)).toEqual([
      firstId,
      store.getSnapshot().nodes.find((node) =>
        node.image?.originalName === "dog.png")?.id
    ]);
    expect(store.getSnapshot().revision).toBe(8);
    expect(history).toHaveBeenCalledOnce();
  });

  it("reuses request and node IDs after a response is lost", async () => {
    let attempted: ImageImportRequest | null = null;
    const importImageBytes = vi.fn(async (request: ImageImportRequest) => {
      if (!attempted) {
        attempted = request;
        throw new Error("response lost");
      }
      return receiptFor(request);
    });
    const store = new NotesStore(api(importImageBytes));
    await store.bootstrap();
    const images = candidates();

    await expect(
      store.images.importAfter("page-1", null, images)
    ).rejects.toThrow("response lost");
    const firstAttempt = attempted!;
    const firstId = await store.images.importAfter("page-1", null, images);
    const secondAttempt = importImageBytes.mock.calls[1]![0];

    expect(secondAttempt.requestId).toBe(firstAttempt.requestId);
    expect(secondAttempt.images.map((image) => image.nodeId)).toEqual(
      firstAttempt.images.map((image) => image.nodeId)
    );
    expect(firstId).toBe(firstAttempt.images[0]!.nodeId);
  });

  it("imports native paths as one ordered request with stable node IDs", async () => {
    const importImagePaths = vi.fn(async (
      request: ImagePathImportRequest
    ): Promise<MutationReceipt> => ({
      revision: 8,
      changedNodes: request.images.map((image, index) => ({
        id: image.nodeId,
        parentId: request.parentId,
        sortKey: 1_500 + index,
        kind: "image",
        image: {
          contentHash: (index === 0 ? "a" : "b").repeat(64),
          originalName: image.path.split(/[\\/]/u).at(-1)!,
          mimeType: "image/png",
          byteLength: 1,
          pixelWidth: 1,
          pixelHeight: 1,
          displayWidth: 320
        },
        text: image.path,
        note: "",
        marker: "bullet",
        collapsed: false,
        completed: false,
        starred: false,
        deleted: false
      })),
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    }));
    const store = new NotesStore(api(vi.fn(), importImagePaths));
    await store.bootstrap();

    const firstId = await store.images.importPathsAfter(
      "page-1",
      "bullet-2",
      ["C:\\images\\cat.png", "/images/dog.png"]
    );

    expect(importImagePaths).toHaveBeenCalledOnce();
    const request = importImagePaths.mock.calls[0]![0];
    expect(request.images.map((image) => image.path)).toEqual([
      "C:\\images\\cat.png",
      "/images/dog.png"
    ]);
    expect(request.images[0]!.nodeId).toBe(firstId);
  });

  it("resizes through the shared revision and history command path", async () => {
    const notesApi = api(vi.fn());
    notesApi.execute = vi.fn().mockResolvedValue({
      revision: 8,
      changedNodes: [],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    });
    const store = new NotesStore(notesApi);
    await store.bootstrap();

    await store.images.resize("image", 480);

    expect(notesApi.execute).toHaveBeenCalledWith(expect.objectContaining({
      historyGroup: null,
      command: {
        kind: "resizeImage",
        id: "image",
        display_width: 480
      }
    }));
  });

  it("keeps two consecutive inserts as two undo steps", async () => {
    // Mirrors the Rust coalescer: an entry folds into the previous one when
    // the history group matches, with no time component.
    const entries: string[][] = [];
    let lastGroup: string | null = null;
    const importImageBytes = vi.fn(async (request: ImageImportRequest) => {
      const ids = request.images.map((image) => image.nodeId);
      if (request.historyGroup !== null && request.historyGroup === lastGroup) {
        entries.at(-1)!.push(...ids);
      } else {
        entries.push(ids);
      }
      lastGroup = request.historyGroup;
      return {
        ...receiptFor(request),
        history: {
          canUndo: true,
          canRedo: false,
          undoDepth: entries.length,
          redoDepth: 0
        }
      };
    });
    const notesApi = api(importImageBytes);
    notesApi.undo = vi.fn(async () => ({
      revision: 20,
      changedNodes: [],
      deletedIds: entries.pop() ?? [],
      history: {
        canUndo: entries.length > 0,
        canRedo: true,
        undoDepth: entries.length,
        redoDepth: 1
      }
    }));
    const store = new NotesStore(notesApi);
    await store.bootstrap();
    const history = vi.fn();
    store.subscribeHistory(history);
    const [cat, dog] = candidates();

    await store.images.importAfter("page-1", null, [cat!]);
    await store.images.importAfter("page-1", null, [dog!]);

    expect(store.getSnapshot().undoDepth).toBe(2);
    expect(history).toHaveBeenCalledTimes(2);
    await store.undo();
    expect(store.getSnapshot().nodes
      .filter((node) => node.image)
      .map((node) => node.image!.originalName)).toEqual(["cat.png"]);
  });

  it("keeps the group stable across a retry so it still pairs the request", async () => {
    let attempted: ImageImportRequest | null = null;
    const importImageBytes = vi.fn(async (request: ImageImportRequest) => {
      if (!attempted) {
        attempted = request;
        throw new Error("response lost");
      }
      return receiptFor(request);
    });
    const store = new NotesStore(api(importImageBytes));
    await store.bootstrap();
    const images = candidates();

    await expect(
      store.images.importAfter("page-1", null, images)
    ).rejects.toThrow("response lost");
    await store.images.importAfter("page-1", null, images);

    const [first, second] = importImageBytes.mock.calls.map((call) => call[0]);
    expect(second!.historyGroup).toBe(first!.historyGroup);
  });

  it("gives each image replacement its own undo step", async () => {
    const notesApi = api(vi.fn());
    notesApi.replaceImageBytes = vi.fn().mockImplementation(async () => ({
      revision: 8,
      changedNodes: [],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    }));
    notesApi.replaceImagePath = vi.fn().mockImplementation(async () => ({
      revision: 9,
      changedNodes: [],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 2, redoDepth: 0 }
    }));
    const store = new NotesStore(notesApi);
    await store.bootstrap();
    const [cat, dog] = candidates();

    await store.images.replace("image-a", cat!);
    await store.images.replace("image-b", dog!);
    await store.images.replacePath("image-c", "/images/fox.png");
    await store.images.replacePath("image-d", "/images/owl.png");

    const groups = [
      ...(notesApi.replaceImageBytes as ReturnType<typeof vi.fn>).mock.calls,
      ...(notesApi.replaceImagePath as ReturnType<typeof vi.fn>).mock.calls
    ].map((call) => call[0].historyGroup);
    expect(groups.every((group) => typeof group === "string")).toBe(true);
    expect(new Set(groups).size).toBe(4);
  });

  it("replaces bytes without changing the target node identity", async () => {
    const notesApi = api(vi.fn());
    notesApi.replaceImageBytes = vi.fn().mockImplementation(async (request) => ({
      revision: 8,
      changedNodes: [{
        ...snapshot.viewport!.nodes[0]!,
        id: request.targetId,
        kind: "image",
        text: request.image.originalName,
        image: {
          contentHash: "c".repeat(64),
          originalName: request.image.originalName,
          mimeType: "image/png",
          byteLength: request.image.blob.size,
          pixelWidth: 1,
          pixelHeight: 1,
          displayWidth: 320
        }
      }],
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    }));
    const store = new NotesStore(notesApi);
    await store.bootstrap();
    const replacement = candidates()[0]!;

    await store.images.replace("image-a", replacement);

    expect(notesApi.replaceImageBytes).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: "image-a",
        image: expect.objectContaining({
          nodeId: "image-a",
          originalName: "cat.png"
        })
      })
    );
    expect(store.getSnapshot().nodes.some((node) =>
      node.id === "image-a" &&
      node.image?.originalName === "cat.png"
    )).toBe(true);
  });
});
