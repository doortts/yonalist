import { describe, expect, it, vi } from "vitest";
import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";
import type { NotesApi } from "./api";
import type { ImageCandidate, ImageImportRequest } from "./imageApi";
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

function api(importImageBytes: NotesApi["importImageBytes"]): NotesApi {
  return {
    bootstrap: vi.fn().mockResolvedValue(snapshot),
    queryViewport: vi.fn(),
    queryForest: vi.fn(),
    execute: vi.fn(),
    importImageBytes,
    readImage: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    search: vi.fn(),
    closeSession: vi.fn()
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
});
