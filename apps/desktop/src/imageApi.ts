import type { ImageImportContext } from "../../../packages/contracts/generated/ImageImportContext";
import type { ImagePathImportItem } from "../../../packages/contracts/generated/ImagePathImportItem";
import type {
  ImagePathImportRequest as GeneratedImagePathImportRequest
} from "../../../packages/contracts/generated/ImagePathImportRequest";
import type { ImageReplaceContext } from "../../../packages/contracts/generated/ImageReplaceContext";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BATCH_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_BATCH_ITEMS = 128;
const HEADER_BYTES = 16;
const supportedMimeTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp"
]);

export interface ImageInput {
  readonly nodeId: string;
  readonly originalName: string;
  readonly declaredMimeType: string | null;
  readonly blob: Blob;
}

export type ImageCandidate = Omit<ImageInput, "nodeId">;

export interface ImageImportRequest {
  readonly sessionId: string;
  readonly requestId: string;
  readonly baseRevision: number;
  readonly historyGroup: string | null;
  readonly parentId: string;
  readonly beforeId: string | null;
  readonly images: readonly ImageInput[];
}

export type ImagePathInput = ImagePathImportItem;
export type ImagePathImportRequest = GeneratedImagePathImportRequest;

export interface ImageReplaceRequest {
  readonly sessionId: string;
  readonly requestId: string;
  readonly baseRevision: number;
  readonly historyGroup: string | null;
  readonly targetId: string;
  readonly image: ImageInput;
}

export async function encodeImageEnvelope(
  request: ImageImportRequest
): Promise<Uint8Array> {
  validateRequest(request);
  const items = request.images.map((image) => ({
    nodeId: image.nodeId,
    originalName: image.originalName,
    declaredMimeType: image.declaredMimeType,
    byteLength: image.blob.size
  }));
  const context: ImageImportContext = {
    sessionId: request.sessionId,
    requestId: request.requestId,
    baseRevision: request.baseRevision,
    historyGroup: request.historyGroup,
    parentId: request.parentId,
    beforeId: request.beforeId,
    items
  };
  return encodeRawEnvelope(context, request.images);
}

export async function encodeImageReplaceEnvelope(
  request: ImageReplaceRequest
): Promise<Uint8Array> {
  validateRequest({
    sessionId: request.sessionId,
    requestId: request.requestId,
    baseRevision: request.baseRevision,
    historyGroup: request.historyGroup,
    parentId: request.targetId,
    beforeId: null,
    images: [request.image]
  });
  if (request.image.nodeId !== request.targetId) {
    throw new Error("The replacement image identity is invalid.");
  }
  const context: ImageReplaceContext = {
    sessionId: request.sessionId,
    requestId: request.requestId,
    baseRevision: request.baseRevision,
    historyGroup: request.historyGroup,
    targetId: request.targetId,
    item: {
      nodeId: request.image.nodeId,
      originalName: request.image.originalName,
      declaredMimeType: request.image.declaredMimeType,
      byteLength: request.image.blob.size
    }
  };
  return encodeRawEnvelope(context, [request.image]);
}

async function encodeRawEnvelope(
  context: ImageImportContext | ImageReplaceContext,
  images: readonly ImageInput[]
): Promise<Uint8Array> {
  const metadata = new TextEncoder().encode(JSON.stringify(context));
  const buffers = await Promise.all(
    images.map((image) => image.blob.arrayBuffer())
  );
  buffers.forEach((buffer, index) => {
    if (buffer.byteLength !== images[index]!.blob.size) {
      throw new Error("An image changed while its bytes were read.");
    }
  });
  const payloadLength = images.reduce(
    (total, image) => total + image.blob.size,
    0
  );
  const envelope = new Uint8Array(HEADER_BYTES + metadata.length + payloadLength);
  envelope.set([89, 86, 50, 73], 0);
  const view = new DataView(envelope.buffer);
  view.setUint16(4, 1, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, metadata.length, true);
  view.setUint32(12, images.length, true);
  envelope.set(metadata, HEADER_BYTES);
  let offset = HEADER_BYTES + metadata.length;
  for (const buffer of buffers) {
    const bytes = new Uint8Array(buffer);
    envelope.set(bytes, offset);
    offset += bytes.length;
  }
  return envelope;
}

export function normalizeImageBytes(value: unknown): Uint8Array {
  let bytes: Uint8Array;
  if (
    value instanceof Uint8Array &&
    Object.getPrototypeOf(value) === Uint8Array.prototype
  ) {
    bytes = value;
  } else if (
    value instanceof ArrayBuffer &&
    Object.getPrototypeOf(value) === ArrayBuffer.prototype
  ) {
    bytes = new Uint8Array(value);
  } else if (isJsonByteArray(value)) {
    bytes = Uint8Array.from(value);
  } else {
    throw new Error("Notes image bytes returned an invalid result.");
  }
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("Notes image bytes returned an invalid result.");
  }
  return bytes.slice();
}

function validateRequest(request: ImageImportRequest): void {
  if (
    !request.sessionId ||
    !request.requestId ||
    !request.parentId ||
    !Number.isSafeInteger(request.baseRevision) ||
    request.baseRevision < 0
  ) {
    throw new Error("The image import context is invalid.");
  }
  if (
    request.images.length === 0 ||
    request.images.length > MAX_IMAGE_BATCH_ITEMS
  ) {
    throw new Error("An image batch must contain between 1 and 128 images.");
  }
  const nodeIds = new Set<string>();
  let aggregate = 0;
  for (const image of request.images) {
    const nameBytes = new TextEncoder().encode(image.originalName).length;
    if (
      !image.nodeId ||
      nodeIds.has(image.nodeId) ||
      nameBytes === 0 ||
      nameBytes > 1_024 ||
      /[\u0000-\u001f\u007f]/u.test(image.originalName)
    ) {
      throw new Error("Image metadata is invalid.");
    }
    nodeIds.add(image.nodeId);
    if (
      image.declaredMimeType !== null &&
      !supportedMimeTypes.has(image.declaredMimeType)
    ) {
      throw new Error("The declared image type is unsupported.");
    }
    if (
      !Number.isSafeInteger(image.blob.size) ||
      image.blob.size < 1 ||
      image.blob.size > MAX_IMAGE_BYTES
    ) {
      throw new Error("An image must be between 1 byte and 20 MiB.");
    }
    aggregate += image.blob.size;
    if (aggregate > MAX_IMAGE_BATCH_BYTES) {
      throw new Error("The image batch exceeds 64 MiB.");
    }
  }
}

function isJsonByteArray(value: unknown): value is number[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_IMAGE_BYTES
  ) {
    return false;
  }
  return value.every((byte, index) =>
    Object.prototype.hasOwnProperty.call(value, index) &&
    Number.isInteger(byte) &&
    byte >= 0 &&
    byte <= 255
  );
}
