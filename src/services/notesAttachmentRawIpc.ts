import {
  MAX_NOTE_ATTACHMENT_BATCH_BYTES,
  MAX_NOTE_ATTACHMENT_BATCH_METADATA_BYTES,
  MAX_NOTE_ATTACHMENT_BYTES,
  MAX_NOTE_ATTACHMENTS_PER_NODE,
  MAX_NOTE_IMAGE_NODE_IMPORT_BATCH_ITEMS
} from "../domain/notes";
import type {
  ImportImageNodeBytesInput,
  ImportNoteAttachmentBytesBatchInput,
  NotesHistoryContext
} from "../domain/notes";

const MAGIC = Uint8Array.of(89, 78, 65, 66);
const IMAGE_NODE_MAGIC = Uint8Array.of(89, 78, 73, 66);
const VERSION = 1;
const IMAGE_NODE_VERSION = 2;
const HEADER_BYTES = 9;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HISTORY_CONTEXT_KEYS = ["sessionId", "entryId", "commandKind"] as const;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

function isCanonicalUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

function normalizeHistoryContext(
  historyContext: NotesHistoryContext | null | undefined
): NotesHistoryContext | null {
  if (historyContext == null) {
    return null;
  }
  if (
    typeof historyContext !== "object" ||
    Reflect.ownKeys(historyContext).length !== HISTORY_CONTEXT_KEYS.length ||
    HISTORY_CONTEXT_KEYS.some(
      (key) => !Object.prototype.hasOwnProperty.call(historyContext, key)
    )
  ) {
    throw new Error(
      "History context must contain exactly sessionId, entryId, and commandKind."
    );
  }
  if (!isCanonicalUuidV4(historyContext.sessionId)) {
    throw new Error("History session ID must be a canonical UUID v4.");
  }
  if (!isCanonicalUuidV4(historyContext.entryId)) {
    throw new Error("History entry ID must be a canonical UUID v4.");
  }
  if (typeof historyContext.commandKind !== "string") {
    throw new Error("History command kind must contain 1 to 128 characters.");
  }

  const commandKind = historyContext.commandKind.trim();
  const commandKindBytes = new TextEncoder().encode(commandKind).byteLength;
  if (commandKindBytes === 0 || commandKindBytes > 128) {
    throw new Error("History command kind must contain 1 to 128 characters.");
  }

  return {
    sessionId: historyContext.sessionId,
    entryId: historyContext.entryId,
    commandKind
  };
}

function validateOptionalNoteId(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  if (isCanonicalUuidV4(value)) {
    return value;
  }
  throw new Error(`${label} must be null or a canonical UUID v4.`);
}

function isDenseStandardArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      return false;
    }
  }
  return true;
}

function validateImageName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    new TextEncoder().encode(value).byteLength > 1024
  ) {
    throw new Error("Image original names must contain 1 to 1024 UTF-8 bytes.");
  }
  return value;
}

function validateImageMimeType(value: unknown): string {
  if (typeof value !== "string" || !SUPPORTED_IMAGE_MIME_TYPES.has(value)) {
    throw new Error("Unsupported image MIME type.");
  }
  return value;
}

export async function encodeNotesAttachmentRawEnvelope(
  vaultPath: string,
  input: ImportNoteAttachmentBytesBatchInput,
  historyContext?: NotesHistoryContext | null
): Promise<Uint8Array> {
  if (input.attachments.length === 0) {
    throw new Error("An attachment batch must contain at least one attachment.");
  }
  if (input.attachments.length > MAX_NOTE_ATTACHMENTS_PER_NODE) {
    throw new Error("An attachment batch may contain at most 128 attachments.");
  }
  if (
    !Number.isSafeInteger(input.initialMaxDisplayWidth) ||
    input.initialMaxDisplayWidth <= 0
  ) {
    throw new Error("Initial attachment display width must be positive.");
  }
  if (!isCanonicalUuidV4(input.nodeId)) {
    throw new Error("The attachment node ID must be a canonical UUID v4.");
  }

  const normalizedHistoryContext = normalizeHistoryContext(historyContext);

  const ids = new Set<string>();
  let bodyBytes = 0;
  const attachments = input.attachments.map((attachment, ordinal) => {
    if (!isCanonicalUuidV4(attachment.id)) {
      throw new Error("Every attachment ID must be a canonical UUID v4.");
    }
    if (ids.has(attachment.id)) {
      throw new Error(`Duplicate attachment ID: ${attachment.id}`);
    }
    ids.add(attachment.id);

    const byteLength = attachment.blob.size;
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
      throw new Error("Attachment blobs must not be empty.");
    }
    if (byteLength > MAX_NOTE_ATTACHMENT_BYTES) {
      throw new Error("Each attachment blob must be at most 20 MiB.");
    }
    bodyBytes += byteLength;
    if (bodyBytes > MAX_NOTE_ATTACHMENT_BATCH_BYTES) {
      throw new Error("Attachment batch bytes must be at most 64 MiB.");
    }

    return {
      id: attachment.id,
      ordinal,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      byteLength
    };
  });

  const metadataBytes = new TextEncoder().encode(
    JSON.stringify({
      vaultPath,
      nodeId: input.nodeId,
      attachments,
      initialMaxDisplayWidth: input.initialMaxDisplayWidth,
      historyContext: normalizedHistoryContext
    })
  );
  if (metadataBytes.byteLength > MAX_NOTE_ATTACHMENT_BATCH_METADATA_BYTES) {
    throw new Error("Attachment batch metadata must be at most 256 KiB.");
  }

  const envelope = new Uint8Array(
    HEADER_BYTES + metadataBytes.byteLength + bodyBytes
  );
  envelope.set(MAGIC, 0);
  envelope[4] = VERSION;
  new DataView(envelope.buffer).setUint32(5, metadataBytes.byteLength, true);
  envelope.set(metadataBytes, HEADER_BYTES);

  let offset = HEADER_BYTES + metadataBytes.byteLength;
  for (const attachment of input.attachments) {
    const bytes = new Uint8Array(await attachment.blob.arrayBuffer());
    if (bytes.byteLength !== attachment.blob.size) {
      throw new Error("Attachment blob size changed while encoding the batch.");
    }
    envelope.set(bytes, offset);
    offset += bytes.byteLength;
  }

  return envelope;
}

export async function encodeNotesImageNodeRawEnvelope(
  vaultPath: string,
  input: ImportImageNodeBytesInput,
  historyContext?: NotesHistoryContext | null
): Promise<Uint8Array> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length !== 4 ||
    !Object.prototype.hasOwnProperty.call(input, "parentId") ||
    !Object.prototype.hasOwnProperty.call(input, "afterId") ||
    !Object.prototype.hasOwnProperty.call(input, "items") ||
    !Object.prototype.hasOwnProperty.call(input, "initialMaxDisplayWidth")
  ) {
    throw new Error("Image-node byte batch input is invalid.");
  }

  const parentId = validateOptionalNoteId(
    input.parentId,
    "Image-node parent ID"
  );
  const afterId = validateOptionalNoteId(input.afterId, "Image-node after ID");

  if (!isDenseStandardArray(input.items)) {
    throw new Error("Image-node byte items must be contiguous.");
  }
  if (input.items.length === 0) {
    throw new Error("An image-node byte batch must contain at least one image.");
  }
  if (input.items.length > MAX_NOTE_IMAGE_NODE_IMPORT_BATCH_ITEMS) {
    throw new Error("An image-node byte batch may contain at most 128 images.");
  }
  if (
    !Number.isSafeInteger(input.initialMaxDisplayWidth) ||
    input.initialMaxDisplayWidth <= 0
  ) {
    throw new Error("Initial image display width must be positive.");
  }

  const normalizedHistoryContext = normalizeHistoryContext(historyContext);

  const nodeIds = new Set<string>();
  const attachmentIds = new Set<string>();
  const allIds = new Set<string>();
  let bodyBytes = 0;
  const items = input.items.map((item, ordinal) => {
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      Reflect.ownKeys(item).length !== 5 ||
      !Object.prototype.hasOwnProperty.call(item, "nodeId") ||
      !Object.prototype.hasOwnProperty.call(item, "attachmentId") ||
      !Object.prototype.hasOwnProperty.call(item, "originalName") ||
      !Object.prototype.hasOwnProperty.call(item, "mimeType") ||
      !Object.prototype.hasOwnProperty.call(item, "blob")
    ) {
      throw new Error("Image-node byte items must contain exactly the expected fields.");
    }
    if (!isCanonicalUuidV4(item.nodeId)) {
      throw new Error("Every image node ID must be a canonical UUID v4.");
    }
    if (nodeIds.has(item.nodeId)) {
      throw new Error(`Duplicate image node ID: ${item.nodeId}`);
    }
    if (!isCanonicalUuidV4(item.attachmentId)) {
      throw new Error("Every image attachment ID must be a canonical UUID v4.");
    }
    if (attachmentIds.has(item.attachmentId)) {
      throw new Error(`Duplicate attachment ID: ${item.attachmentId}`);
    }
    if (
      item.nodeId === item.attachmentId ||
      allIds.has(item.nodeId) ||
      allIds.has(item.attachmentId)
    ) {
      throw new Error("Image node and attachment IDs must be distinct.");
    }
    nodeIds.add(item.nodeId);
    attachmentIds.add(item.attachmentId);
    allIds.add(item.nodeId);
    allIds.add(item.attachmentId);

    const originalName = validateImageName(item.originalName);
    const mimeType = validateImageMimeType(item.mimeType);
    if (
      typeof item.blob !== "object" ||
      item.blob === null ||
      typeof item.blob.arrayBuffer !== "function" ||
      !Number.isSafeInteger(item.blob.size)
    ) {
      throw new Error("Image blobs must expose a stable byte size.");
    }
    const byteLength = item.blob.size;
    if (byteLength <= 0) {
      throw new Error("Image blobs must not be empty.");
    }
    if (byteLength > MAX_NOTE_ATTACHMENT_BYTES) {
      throw new Error("Each image blob must be at most 20 MiB.");
    }
    bodyBytes += byteLength;
    if (bodyBytes > MAX_NOTE_ATTACHMENT_BATCH_BYTES) {
      throw new Error("Image-node batch bytes must be at most 64 MiB.");
    }

    return {
      nodeId: item.nodeId,
      attachmentId: item.attachmentId,
      ordinal,
      originalName,
      mimeType,
      byteLength
    };
  });

  const metadataBytes = new TextEncoder().encode(
    JSON.stringify({
      vaultPath,
      parentId,
      afterId,
      items,
      initialMaxDisplayWidth: input.initialMaxDisplayWidth,
      historyContext: normalizedHistoryContext
    })
  );
  if (metadataBytes.byteLength > MAX_NOTE_ATTACHMENT_BATCH_METADATA_BYTES) {
    throw new Error("Image-node batch metadata must be at most 256 KiB.");
  }

  const envelope = new Uint8Array(
    HEADER_BYTES + metadataBytes.byteLength + bodyBytes
  );
  envelope.set(IMAGE_NODE_MAGIC, 0);
  envelope[4] = IMAGE_NODE_VERSION;
  new DataView(envelope.buffer).setUint32(5, metadataBytes.byteLength, true);
  envelope.set(metadataBytes, HEADER_BYTES);

  let offset = HEADER_BYTES + metadataBytes.byteLength;
  for (const item of input.items) {
    const bytes = new Uint8Array(await item.blob.arrayBuffer());
    if (bytes.byteLength !== item.blob.size) {
      throw new Error("Image blob size changed while encoding the batch.");
    }
    envelope.set(bytes, offset);
    offset += bytes.byteLength;
  }

  return envelope;
}
