import {
  MAX_NOTE_ATTACHMENT_BATCH_BYTES,
  MAX_NOTE_ATTACHMENT_BATCH_METADATA_BYTES,
  MAX_NOTE_ATTACHMENT_BYTES,
  MAX_NOTE_ATTACHMENTS_PER_NODE
} from "../domain/notes";
import type {
  ImportNoteAttachmentBytesBatchInput,
  NotesHistoryContext
} from "../domain/notes";

const MAGIC = Uint8Array.of(89, 78, 65, 66);
const VERSION = 1;
const HEADER_BYTES = 9;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
  if (!UUID_V4.test(input.nodeId)) {
    throw new Error("The attachment node ID must be a canonical UUID v4.");
  }

  const ids = new Set<string>();
  let bodyBytes = 0;
  const attachments = input.attachments.map((attachment, ordinal) => {
    if (!UUID_V4.test(attachment.id)) {
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
      historyContext: historyContext ?? null
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
