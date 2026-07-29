import { describe, expect, it, vi } from "vitest";
import {
  MAX_IMAGE_BATCH_BYTES,
  MAX_IMAGE_BATCH_ITEMS,
  MAX_IMAGE_BYTES,
  encodeImageEnvelope,
  type ImageImportRequest,
  type ImageInput
} from "./imageApi";

function request(images: readonly ImageInput[]): ImageImportRequest {
  return {
    sessionId: "session",
    requestId: "request",
    baseRevision: 7,
    historyGroup: "images:batch",
    parentId: "page",
    beforeId: "next",
    images
  };
}

function input(
  nodeId: string,
  originalName: string,
  bytes: readonly number[]
): ImageInput {
  return {
    nodeId,
    originalName,
    declaredMimeType: "image/png",
    blob: new Blob([Uint8Array.from(bytes)], { type: "image/png" })
  };
}

function u16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint16(offset, true);
}

function u32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(offset, true);
}

describe("image raw IPC envelope", () => {
  it("encodes exact header metadata and payload order without base64", async () => {
    const encoded = await encodeImageEnvelope(request([
      input("image-a", "고양이.png", [0, 1, 2]),
      input("image-b", "dog.png", [253, 254, 255])
    ]));

    expect([...encoded.slice(0, 4)]).toEqual([89, 86, 50, 73]);
    expect(u16(encoded, 4)).toBe(1);
    expect(u16(encoded, 6)).toBe(0);
    expect(u32(encoded, 12)).toBe(2);
    const metadataLength = u32(encoded, 8);
    const metadataText = new TextDecoder().decode(
      encoded.slice(16, 16 + metadataLength)
    );
    expect(JSON.parse(metadataText)).toEqual({
      sessionId: "session",
      requestId: "request",
      baseRevision: 7,
      historyGroup: "images:batch",
      parentId: "page",
      beforeId: "next",
      items: [
        {
          nodeId: "image-a",
          originalName: "고양이.png",
          declaredMimeType: "image/png",
          byteLength: 3
        },
        {
          nodeId: "image-b",
          originalName: "dog.png",
          declaredMimeType: "image/png",
          byteLength: 3
        }
      ]
    });
    expect(metadataText).not.toMatch(/base64|AAEC|\/f7\//iu);
    expect([...encoded.slice(16 + metadataLength)]).toEqual([
      0, 1, 2, 253, 254, 255
    ]);
  });

  it("rejects count and byte budgets before reading any Blob", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const fakeBlob = (size: number) => ({
      size,
      type: "image/png",
      arrayBuffer
    } as unknown as Blob);
    const fakeInput = (index: number, size: number): ImageInput => ({
      nodeId: `image-${index}`,
      originalName: `${index}.png`,
      declaredMimeType: "image/png",
      blob: fakeBlob(size)
    });

    await expect(encodeImageEnvelope(request([]))).rejects.toThrow();
    await expect(encodeImageEnvelope(request([
      fakeInput(0, MAX_IMAGE_BYTES + 1)
    ]))).rejects.toThrow();
    await expect(encodeImageEnvelope(request(
      Array.from(
        { length: MAX_IMAGE_BATCH_ITEMS + 1 },
        (_, index) => fakeInput(index, 1)
      )
    ))).rejects.toThrow();
    await expect(encodeImageEnvelope(request(
      Array.from({ length: 4 }, (_, index) =>
        fakeInput(index, MAX_IMAGE_BATCH_BYTES / 4 + 1)
      )
    ))).rejects.toThrow();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
