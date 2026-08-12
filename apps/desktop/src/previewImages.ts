import type { ImageDownloadRequest } from "../../../packages/contracts/generated/ImageDownloadRequest";
import type { ImagePathImportRequest } from "../../../packages/contracts/generated/ImagePathImportRequest";
import type { ImageReadRequest } from "../../../packages/contracts/generated/ImageReadRequest";
import type { ImageReplacePathRequest } from "../../../packages/contracts/generated/ImageReplacePathRequest";
import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { ImageImportRequest, ImageReplaceRequest } from "./imageApi";

export interface PreviewImageHost {
  readonly sessionId: string;
  revision(): number;
  nodes(): NoteView[];
  setNodes(nodes: NoteView[]): void;
  copyNodes(): NoteView[];
  sortKeyBefore(parentId: string, beforeId: string | null): number;
  priorReceipt(requestId: string): MutationReceipt | undefined;
  recordMutation(previousNodes: readonly NoteView[]): void;
  advanceRevision(): void;
  receipt(changedNodes: NoteView[]): MutationReceipt;
  recordReceipt(requestId: string, receipt: MutationReceipt): void;
}

export class PreviewImages {
  private readonly blobs = new Map<string, Blob>();

  constructor(private readonly host: PreviewImageHost) {}

  async importBytes(
    request: ImageImportRequest
  ): Promise<MutationReceipt> {
    const priorReceipt = this.host.priorReceipt(request.requestId);
    if (priorReceipt) return priorReceipt;
    this.validateContext(request.sessionId, request.baseRevision);
    if (request.images.length === 0) {
      throw new Error("The preview image batch is empty.");
    }

    const previousNodes = this.host.copyNodes();
    const changed: NoteView[] = [];
    for (const input of request.images) {
      const mimeType = input.declaredMimeType || input.blob.type;
      if (!extensionForMime(mimeType)) {
        throw new Error("The preview image type is unsupported.");
      }
      const bytes = new Uint8Array(await input.blob.arrayBuffer());
      const contentHash = await hashBytes(bytes);
      const dimensions = await imageDimensions(input.blob);
      const node: NoteView = {
        id: input.nodeId,
        parentId: request.parentId,
        sortKey: this.host.sortKeyBefore(
          request.parentId,
          request.beforeId
        ),
        kind: "image",
        image: {
          contentHash,
          originalName: input.originalName,
          mimeType,
          byteLength: bytes.length,
          pixelWidth: dimensions.width,
          pixelHeight: dimensions.height,
          displayWidth: 320
        },
        text: input.originalName,
        note: "",
        marker: "bullet",
        collapsed: false,
        completed: false,
        starred: false,
        deleted: false
      };
      this.host.nodes().push(node);
      changed.push(node);
      this.blobs.set(contentHash, input.blob);
    }
    return this.finishMutation(request.requestId, previousNodes, changed);
  }

  async importPaths(_request: ImagePathImportRequest): Promise<never> {
    throw new Error("Native image paths are unavailable in browser preview.");
  }

  async replaceBytes(
    request: ImageReplaceRequest
  ): Promise<MutationReceipt> {
    const priorReceipt = this.host.priorReceipt(request.requestId);
    if (priorReceipt) return priorReceipt;
    this.validateContext(request.sessionId, request.baseRevision);
    const currentNodes = this.host.nodes();
    const position = currentNodes.findIndex((node) =>
      node.id === request.targetId &&
      node.kind === "image" &&
      !node.deleted
    );
    const target = currentNodes[position];
    if (position < 0 || !target?.image) throw new Error("Image unavailable");
    const mimeType = request.image.declaredMimeType || request.image.blob.type;
    if (!extensionForMime(mimeType)) {
      throw new Error("The preview image type is unsupported.");
    }
    const bytes = new Uint8Array(await request.image.blob.arrayBuffer());
    const contentHash = await hashBytes(bytes);
    const dimensions = await imageDimensions(request.image.blob);
    const replacement: NoteView = {
      ...target,
      text: request.image.originalName,
      image: {
        contentHash,
        originalName: request.image.originalName,
        mimeType,
        byteLength: bytes.length,
        pixelWidth: dimensions.width,
        pixelHeight: dimensions.height,
        displayWidth: target.image.displayWidth
      }
    };
    const previousNodes = this.host.copyNodes();
    this.host.setNodes(currentNodes.map((node, index) =>
      index === position ? replacement : node));
    this.blobs.set(contentHash, request.image.blob);
    return this.finishMutation(
      request.requestId,
      previousNodes,
      [replacement]
    );
  }

  async replacePath(_request: ImageReplacePathRequest): Promise<never> {
    throw new Error("Native image paths are unavailable in browser preview.");
  }

  // A pasted node references bytes by hash, the way the Rust asset store is
  // asked whether they are still there.
  holds(contentHash: string): boolean {
    return this.blobs.has(contentHash);
  }

  async read(request: ImageReadRequest): Promise<Uint8Array> {
    if (request.sessionId !== this.host.sessionId) {
      throw new Error("Preview session does not match.");
    }
    const node = this.host.nodes().find((candidate) =>
      candidate.id === request.nodeId &&
      candidate.kind === "image" &&
      !candidate.deleted
    );
    const blob = node?.image
      ? this.blobs.get(node.image.contentHash)
      : undefined;
    if (!node?.image || !blob) throw new Error("Image unavailable");
    return new Uint8Array(await blob.arrayBuffer());
  }

  async viewOriginal(request: ImageReadRequest): Promise<void> {
    await this.read(request);
  }

  async download(request: ImageDownloadRequest): Promise<void> {
    await this.read(request);
  }

  private validateContext(session: string, baseRevision: number): void {
    if (session !== this.host.sessionId) {
      throw new Error("Preview session does not match.");
    }
    if (baseRevision !== this.host.revision()) {
      throw new Error("Preview revision is stale.");
    }
  }

  private finishMutation(
    requestId: string,
    previousNodes: readonly NoteView[],
    changedNodes: NoteView[]
  ): MutationReceipt {
    this.host.recordMutation(previousNodes);
    this.host.advanceRevision();
    const nextReceipt = this.host.receipt(changedNodes);
    this.host.recordReceipt(requestId, nextReceipt);
    return nextReceipt;
  }
}

function extensionForMime(mimeType: string): string | null {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/webp") return "webp";
  return null;
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digestInput = new Uint8Array(bytes.length);
    digestInput.set(bytes);
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      digestInput.buffer
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  let value = 0;
  bytes.forEach((byte) => {
    value = Math.imul(value ^ byte, 16_777_619) >>> 0;
  });
  return value.toString(16).padStart(8, "0").repeat(8);
}

async function imageDimensions(
  blob: Blob
): Promise<{ readonly width: number; readonly height: number }> {
  if (typeof globalThis.createImageBitmap !== "function") {
    return { width: 1, height: 1 };
  }
  const bitmap = await globalThis.createImageBitmap(blob);
  const dimensions = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return dimensions;
}
