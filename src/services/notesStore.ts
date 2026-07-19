import {
  isNoteSearchResult,
  isImageAtomOperationLookup,
  isImageAtomMutationResult,
  isImportNotesMarkdownInput,
  isNotesHistoryReplayOutcome,
  isNotesHistoryState,
  isNotesMutationResult,
  isNotesWorkspaceResetResult,
  isRetryableNotesErrorCode,
  MAX_NOTE_ATTACHMENT_BATCH_BYTES,
  MAX_NOTE_ATTACHMENT_BYTES,
  MAX_NOTE_IMAGE_NODE_IMPORT_BATCH_ITEMS,
  MAX_NOTE_ATTACHMENTS_PER_NODE,
  MAX_NOTES_BATCH_NODE_IDS,
  normalizeNotesWorkspace,
  parseNotesError
} from "../domain/notes";
import {
  encodeNotesAttachmentRawEnvelope,
  encodeNotesImageAtomPasteRawEnvelope,
  encodeNotesImageNodeRawEnvelope
} from "./notesAttachmentRawIpc";
import {
  isCanonicalNoteTagBody,
  validateAndCanonicalizeNoteSearchQuery
} from "../features/notes/noteSearchQuery";
import type {
  ApplyNotesBatchInput,
  ApplyImageAtomEditInput,
  ApplyImageAtomPasteInput,
  CreateNoteNodeInput,
  ImportNotesMarkdownInput,
  ImportImageNodeBytesInput,
  ImportImageNodePathsInput,
  ImportNoteAttachmentBytesBatchInput,
  ImportNoteAttachmentInput,
  ImportNoteAttachmentPathBatchInput,
  ImportSubtreeInput,
  ImageAtomOperationLookup,
  ImageAtomMutationResult,
  MoveNoteNodeInput,
  NoteAttachment,
  NoteId,
  NoteNode,
  NoteSearchResult,
  NoteSearchScope,
  NoteStructuredSearchQuery,
  NoteTagSummary,
  NotesHistoryContext,
  NotesHistoryCloseInput,
  NotesHistoryReplayInput,
  NotesHistoryReplayOutcome,
  NotesHistoryResetInput,
  NotesHistoryResetResult,
  NotesHistoryState,
  NotesHistoryStatus,
  NotesInitializeInput,
  NotesPrepareNavigationInput,
  NotesPruneHistoryInput,
  NotesDeleteDatabaseResult,
  NotesMutationResult,
  NotesStore,
  NotesStoreError,
  NotesWorkspace,
  NotesWorkspaceResetResult,
  NotesWorkspaceScope,
  ResizeNoteAttachmentInput,
  SplitNoteNodeInput,
  UpdateNoteNodeInput
} from "../domain/notes";

/**
 * Builds a {@link NotesStoreError} from a rejected IPC cause. The structured
 * `code` is parsed from the backend `NotesError` (falling back to `internal`),
 * and `retryable` is derived from that code — omit the third argument for
 * transport/backend failures. The only callers that pass `retryable`
 * explicitly are the client-side "response was malformed" guards, which are
 * never retryable regardless of code.
 */
function notesStoreError(
  operation: NotesStoreError["operation"],
  cause: unknown,
  retryable?: boolean
): NotesStoreError {
  const { code, message } = parseNotesError(cause);
  return Object.assign(new Error(message), {
    operation,
    code,
    retryable: retryable ?? isRetryableNotesErrorCode(code)
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every(
      (key) => typeof key === "string" && expectedKeys.includes(key)
    )
  );
}

function isCanonicalUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

function normalizeAttachmentHistoryContext(
  historyContext: unknown
): NotesHistoryContext | undefined {
  if (
    !isPlainRecord(historyContext) ||
    !hasExactKeys(historyContext, [
      "sessionId",
      "historyEpoch",
      "entryId",
      "commandKind"
    ]) ||
    !isCanonicalUuidV4(historyContext.sessionId) ||
    typeof historyContext.historyEpoch !== "string" ||
    !isCanonicalUuidV4(historyContext.entryId) ||
    typeof historyContext.commandKind !== "string"
  ) {
    return undefined;
  }
  const commandKind = historyContext.commandKind.trim();
  const commandKindBytes = new TextEncoder().encode(commandKind).byteLength;
  if (commandKindBytes === 0 || commandKindBytes > 128) {
    return undefined;
  }
  return {
    sessionId: historyContext.sessionId,
    historyEpoch: historyContext.historyEpoch,
    entryId: historyContext.entryId,
    commandKind
  };
}

function normalizeMarkdownImportHistoryContext(
  historyContext: unknown
): NotesHistoryContext | undefined {
  if (
    !isPlainRecord(historyContext) ||
    historyContext.commandKind !== "importMarkdown"
  ) {
    return undefined;
  }
  const normalized = normalizeAttachmentHistoryContext(historyContext);
  if (
    normalized === undefined ||
    normalized.historyEpoch.trim().length === 0 ||
    normalized.historyEpoch.includes("\0") ||
    new TextEncoder().encode(normalized.historyEpoch).byteLength > 128
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeImageAtomOperationAuthority(
  sessionId: unknown,
  historyEpoch: unknown,
  operationId: unknown
):
  | { sessionId: string; historyEpoch: string; operationId: string }
  | undefined {
  if (
    !isCanonicalUuidV4(sessionId) ||
    typeof historyEpoch !== "string" ||
    historyEpoch.trim().length === 0 ||
    historyEpoch.includes("\0") ||
    new TextEncoder().encode(historyEpoch).byteLength > 128 ||
    !isCanonicalUuidV4(operationId)
  ) {
    return undefined;
  }
  return { sessionId, historyEpoch, operationId };
}

function normalizeImageAtomEditHistoryContext(
  historyContext: unknown
): NotesHistoryContext | undefined {
  const normalized = normalizeAttachmentHistoryContext(historyContext);
  if (
    normalized === undefined ||
    normalized.historyEpoch.trim().length === 0 ||
    normalized.historyEpoch.includes("\0") ||
    new TextEncoder().encode(normalized.historyEpoch).byteLength > 128 ||
    normalized.commandKind !== "imageAtomEdit"
  ) {
    return undefined;
  }
  return normalized;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function normalizeApplyImageAtomEditInput(
  value: unknown
): ApplyImageAtomEditInput | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["target", "selection", "edit"]) ||
    !isPlainRecord(value.target) ||
    !hasExactKeys(value.target, [
      "nodeId",
      "expectedUpdatedAt",
      "expectedTitle",
      "expectedImageOffsetUtf16",
      "expectedPrimaryAttachmentId"
    ]) ||
    !isCanonicalUuidV4(value.target.nodeId) ||
    typeof value.target.expectedUpdatedAt !== "string" ||
    value.target.expectedUpdatedAt.trim().length === 0 ||
    value.target.expectedUpdatedAt.includes("\0") ||
    typeof value.target.expectedTitle !== "string" ||
    !isSafeInteger(value.target.expectedImageOffsetUtf16) ||
    value.target.expectedImageOffsetUtf16 < 0 ||
    !isCanonicalUuidV4(value.target.expectedPrimaryAttachmentId) ||
    !isPlainRecord(value.selection) ||
    !hasExactKeys(value.selection, ["anchorUtf16", "focusUtf16"]) ||
    !isSafeInteger(value.selection.anchorUtf16) ||
    !isSafeInteger(value.selection.focusUtf16) ||
    !isPlainRecord(value.edit)
  ) {
    return undefined;
  }
  const target = {
    nodeId: value.target.nodeId,
    expectedUpdatedAt: value.target.expectedUpdatedAt,
    expectedTitle: value.target.expectedTitle,
    expectedImageOffsetUtf16: value.target.expectedImageOffsetUtf16,
    expectedPrimaryAttachmentId: value.target.expectedPrimaryAttachmentId
  };
  const selection = {
    anchorUtf16: value.selection.anchorUtf16,
    focusUtf16: value.selection.focusUtf16
  };
  if (
    value.edit.kind === "remove" &&
    hasExactKeys(value.edit, ["kind", "replacementText"]) &&
    typeof value.edit.replacementText === "string"
  ) {
    return {
      target,
      selection,
      edit: { kind: "remove", replacementText: value.edit.replacementText }
    };
  }
  if (
    value.edit.kind === "enter" &&
    hasExactKeys(value.edit, ["kind", "siblingId"]) &&
    isCanonicalUuidV4(value.edit.siblingId)
  ) {
    return {
      target,
      selection,
      edit: { kind: "enter", siblingId: value.edit.siblingId }
    };
  }
  return undefined;
}

function normalizeImageAtomPasteHistoryContext(
  value: NotesHistoryContext
): NotesHistoryContext | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["sessionId", "historyEpoch", "entryId", "commandKind"]) ||
    !isCanonicalUuidV4(value.sessionId) ||
    !isCanonicalUuidV4(value.entryId) ||
    typeof value.historyEpoch !== "string" ||
    value.historyEpoch.trim().length === 0 ||
    value.historyEpoch.includes("\0") ||
    new TextEncoder().encode(value.historyEpoch).byteLength > 128 ||
    value.commandKind !== "imageAtomPaste"
  ) {
    return undefined;
  }
  return {
    sessionId: value.sessionId,
    historyEpoch: value.historyEpoch,
    entryId: value.entryId,
    commandKind: value.commandKind
  };
}

function normalizeApplyImageAtomPasteInput(
  value: unknown
): ApplyImageAtomPasteInput | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "target",
      "selection",
      "version",
      "fragment",
      "initialMaxDisplayWidth"
    ]) ||
    !isPlainRecord(value.target) ||
    !hasExactKeys(value.target, [
      "nodeId",
      "expectedUpdatedAt",
      "expectedNodeKind",
      "expectedTitle",
      "expectedImageOffsetUtf16",
      "expectedPrimaryAttachmentId"
    ]) ||
    !isCanonicalUuidV4(value.target.nodeId) ||
    typeof value.target.expectedUpdatedAt !== "string" ||
    value.target.expectedUpdatedAt.trim().length === 0 ||
    value.target.expectedUpdatedAt.includes("\0") ||
    (value.target.expectedNodeKind !== "text" &&
      value.target.expectedNodeKind !== "image") ||
    typeof value.target.expectedTitle !== "string" ||
    !isSafeInteger(value.target.expectedImageOffsetUtf16) ||
    value.target.expectedImageOffsetUtf16 < 0 ||
    !isPlainRecord(value.selection) ||
    !hasExactKeys(value.selection, ["anchorUtf16", "focusUtf16"]) ||
    !isSafeInteger(value.selection.anchorUtf16) ||
    !isSafeInteger(value.selection.focusUtf16) ||
    value.version !== 1 ||
    !Array.isArray(value.fragment) ||
    Object.getPrototypeOf(value.fragment) !== Array.prototype ||
    value.fragment.length === 0 ||
    !isSafeInteger(value.initialMaxDisplayWidth) ||
    value.initialMaxDisplayWidth <= 0 ||
    (value.target.expectedNodeKind === "text" &&
      (value.target.expectedImageOffsetUtf16 !== 0 ||
        value.target.expectedPrimaryAttachmentId !== null)) ||
    (value.target.expectedNodeKind === "image" &&
      !isCanonicalUuidV4(value.target.expectedPrimaryAttachmentId))
  ) {
    return undefined;
  }
  return value as unknown as ApplyImageAtomPasteInput;
}

function normalizeNullableNoteId(value: unknown): NoteId | null | undefined {
  if (value === null) {
    return null;
  }
  return isCanonicalUuidV4(value) ? value : undefined;
}

function isSupportedImageMimeType(value: unknown): value is string {
  return typeof value === "string" && SUPPORTED_IMAGE_MIME_TYPES.has(value);
}

function isValidImageOriginalName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    new TextEncoder().encode(value).byteLength <= 1024
  );
}

function isStandardByteArray(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array &&
    Object.getPrototypeOf(value) === Uint8Array.prototype
  );
}

function isStandardArrayBuffer(value: unknown): value is ArrayBuffer {
  return (
    value instanceof ArrayBuffer &&
    Object.getPrototypeOf(value) === ArrayBuffer.prototype
  );
}

function isStandardJsonByteArray(value: unknown): value is number[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_NOTE_ATTACHMENT_BYTES
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const byte = value[index];
    if (
      !Object.prototype.hasOwnProperty.call(value, index) ||
      !Number.isInteger(byte) ||
      byte < 0 ||
      byte > 255
    ) {
      return false;
    }
  }
  return true;
}

function isNonEmptyNativeString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function normalizeImportAttachmentInput(
  input: unknown
): ImportNoteAttachmentInput | null {
  if (!isPlainRecord(input)) {
    return null;
  }
  const expectedKeys = [
    "id",
    "nodeId",
    "sourcePath",
    "initialMaxDisplayWidth"
  ];
  if (
    !hasExactKeys(input, expectedKeys) ||
    !isCanonicalUuidV4(input.id) ||
    !isCanonicalUuidV4(input.nodeId) ||
    typeof input.sourcePath !== "string" ||
    input.sourcePath.length === 0 ||
    input.sourcePath.includes("\0") ||
    !Number.isSafeInteger(input.initialMaxDisplayWidth) ||
    (input.initialMaxDisplayWidth as number) <= 0
  ) {
    return null;
  }
  return {
    id: input.id,
    nodeId: input.nodeId,
    sourcePath: input.sourcePath,
    initialMaxDisplayWidth: input.initialMaxDisplayWidth as number
  };
}

function normalizeImportAttachmentPathBatchInput(
  input: unknown
): ImportNoteAttachmentPathBatchInput | null {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, [
      "nodeId",
      "attachments",
      "initialMaxDisplayWidth"
    ]) ||
    !isCanonicalUuidV4(input.nodeId) ||
    !Array.isArray(input.attachments) ||
    Object.getPrototypeOf(input.attachments) !== Array.prototype ||
    input.attachments.length === 0 ||
    input.attachments.length > MAX_NOTE_ATTACHMENTS_PER_NODE ||
    !Number.isSafeInteger(input.initialMaxDisplayWidth) ||
    (input.initialMaxDisplayWidth as number) <= 0
  ) {
    return null;
  }

  const ids = new Set<string>();
  const attachments: Array<{ id: string; sourcePath: string }> = [];
  for (let index = 0; index < input.attachments.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(input.attachments, index)) {
      return null;
    }
    const attachment = input.attachments[index];
    if (
      !isPlainRecord(attachment) ||
      !hasExactKeys(attachment, ["id", "sourcePath"]) ||
      !isCanonicalUuidV4(attachment.id) ||
      ids.has(attachment.id) ||
      typeof attachment.sourcePath !== "string" ||
      attachment.sourcePath.length === 0 ||
      attachment.sourcePath.includes("\0")
    ) {
      return null;
    }
    ids.add(attachment.id);
    attachments.push({ id: attachment.id, sourcePath: attachment.sourcePath });
  }

  return {
    nodeId: input.nodeId,
    attachments,
    initialMaxDisplayWidth: input.initialMaxDisplayWidth as number
  };
}

type ImportAttachmentBytesBatchNormalization =
  | { input: ImportNoteAttachmentBytesBatchInput; errorMessage: null }
  | { input: null; errorMessage: string };

const invalidImportAttachmentBytesBatch: ImportAttachmentBytesBatchNormalization =
  {
    input: null,
    errorMessage: "Notes attachment byte batch input is invalid."
  };

function normalizeImportAttachmentBytesBatchInput(
  input: unknown
): ImportAttachmentBytesBatchNormalization {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, [
      "nodeId",
      "attachments",
      "initialMaxDisplayWidth"
    ]) ||
    !isCanonicalUuidV4(input.nodeId) ||
    !Array.isArray(input.attachments) ||
    Object.getPrototypeOf(input.attachments) !== Array.prototype ||
    input.attachments.length === 0 ||
    input.attachments.length > MAX_NOTE_ATTACHMENTS_PER_NODE ||
    !Number.isSafeInteger(input.initialMaxDisplayWidth) ||
    (input.initialMaxDisplayWidth as number) <= 0
  ) {
    return invalidImportAttachmentBytesBatch;
  }

  const ids = new Set<string>();
  const attachments = [] as ImportNoteAttachmentBytesBatchInput["attachments"][number][];
  for (let index = 0; index < input.attachments.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(input.attachments, index)) {
      return invalidImportAttachmentBytesBatch;
    }
    const attachment = input.attachments[index];
    if (
      !isPlainRecord(attachment) ||
      !hasExactKeys(attachment, ["id", "originalName", "mimeType", "blob"]) ||
      !isCanonicalUuidV4(attachment.id) ||
      ids.has(attachment.id) ||
      typeof attachment.originalName !== "string" ||
      attachment.originalName.trim().length === 0 ||
      new TextEncoder().encode(attachment.originalName).byteLength > 1024 ||
      typeof attachment.mimeType !== "string" ||
      typeof attachment.blob !== "object" ||
      attachment.blob === null ||
      !Number.isSafeInteger((attachment.blob as Blob).size) ||
      (attachment.blob as Blob).size <= 0 ||
      typeof (attachment.blob as Blob).arrayBuffer !== "function"
    ) {
      return invalidImportAttachmentBytesBatch;
    }
    ids.add(attachment.id);
    attachments.push({
      id: attachment.id,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      blob: attachment.blob as Blob
    });
  }

  let aggregateBytes = 0;
  for (const attachment of attachments) {
    if (attachment.blob.size > MAX_NOTE_ATTACHMENT_BYTES) {
      return {
        input: null,
        errorMessage: `Attachment ${JSON.stringify(attachment.originalName)} exceeds the 20 MiB per-file limit.`
      };
    }
    aggregateBytes += attachment.blob.size;
    if (aggregateBytes > MAX_NOTE_ATTACHMENT_BATCH_BYTES) {
      return {
        input: null,
        errorMessage: `Attachment ${JSON.stringify(attachment.originalName)} causes the batch to exceed the 64 MiB total limit.`
      };
    }
  }

  return {
    input: {
      nodeId: input.nodeId,
      attachments,
      initialMaxDisplayWidth: input.initialMaxDisplayWidth as number
    },
    errorMessage: null
  };
}

function normalizeImportImageNodePathsInput(
  input: unknown
): { input: ImportImageNodePathsInput; nodeIds: NoteId[] } | null {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, [
      "parentId",
      "afterId",
      "items",
      "initialMaxDisplayWidth"
    ]) ||
    !Array.isArray(input.items) ||
    Object.getPrototypeOf(input.items) !== Array.prototype ||
    input.items.length === 0 ||
    input.items.length > MAX_NOTE_IMAGE_NODE_IMPORT_BATCH_ITEMS ||
    !Number.isSafeInteger(input.initialMaxDisplayWidth) ||
    (input.initialMaxDisplayWidth as number) <= 0
  ) {
    return null;
  }

  const parentId = normalizeNullableNoteId(input.parentId);
  const afterId = normalizeNullableNoteId(input.afterId);
  if (parentId === undefined || afterId === undefined) {
    return null;
  }

  const nodeIds = new Set<string>();
  const attachmentIds = new Set<string>();
  const allIds = new Set<string>();
  const items: ImportImageNodePathsInput["items"][number][] = [];
  for (let index = 0; index < input.items.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(input.items, index)) {
      return null;
    }
    const item = input.items[index];
    if (
      !isPlainRecord(item) ||
      !hasExactKeys(item, ["nodeId", "attachmentId", "sourcePath"]) ||
      !isCanonicalUuidV4(item.nodeId) ||
      nodeIds.has(item.nodeId) ||
      !isCanonicalUuidV4(item.attachmentId) ||
      attachmentIds.has(item.attachmentId) ||
      item.nodeId === item.attachmentId ||
      allIds.has(item.nodeId) ||
      allIds.has(item.attachmentId) ||
      typeof item.sourcePath !== "string" ||
      item.sourcePath.length === 0 ||
      item.sourcePath.includes("\0")
    ) {
      return null;
    }
    nodeIds.add(item.nodeId);
    attachmentIds.add(item.attachmentId);
    allIds.add(item.nodeId);
    allIds.add(item.attachmentId);
    items.push({
      nodeId: item.nodeId,
      attachmentId: item.attachmentId,
      sourcePath: item.sourcePath
    });
  }

  return {
    input: {
      parentId,
      afterId,
      items,
      initialMaxDisplayWidth: input.initialMaxDisplayWidth as number
    },
    nodeIds: items.map((item) => item.nodeId)
  };
}

function normalizeImportImageNodeBytesInput(
  input: unknown
): { input: ImportImageNodeBytesInput; nodeIds: NoteId[] } | null {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, [
      "parentId",
      "afterId",
      "items",
      "initialMaxDisplayWidth"
    ]) ||
    !Array.isArray(input.items) ||
    Object.getPrototypeOf(input.items) !== Array.prototype ||
    input.items.length === 0 ||
    input.items.length > MAX_NOTE_IMAGE_NODE_IMPORT_BATCH_ITEMS ||
    !Number.isSafeInteger(input.initialMaxDisplayWidth) ||
    (input.initialMaxDisplayWidth as number) <= 0
  ) {
    return null;
  }

  const parentId = normalizeNullableNoteId(input.parentId);
  const afterId = normalizeNullableNoteId(input.afterId);
  if (parentId === undefined || afterId === undefined) {
    return null;
  }

  const nodeIds = new Set<string>();
  const attachmentIds = new Set<string>();
  const allIds = new Set<string>();
  const items: ImportImageNodeBytesInput["items"][number][] = [];
  for (let index = 0; index < input.items.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(input.items, index)) {
      return null;
    }
    const item = input.items[index];
    if (
      !isPlainRecord(item) ||
      !hasExactKeys(item, [
        "nodeId",
        "attachmentId",
        "originalName",
        "mimeType",
        "blob"
      ]) ||
      !isCanonicalUuidV4(item.nodeId) ||
      nodeIds.has(item.nodeId) ||
      !isCanonicalUuidV4(item.attachmentId) ||
      attachmentIds.has(item.attachmentId) ||
      item.nodeId === item.attachmentId ||
      allIds.has(item.nodeId) ||
      allIds.has(item.attachmentId) ||
      !isValidImageOriginalName(item.originalName) ||
      !isSupportedImageMimeType(item.mimeType) ||
      typeof item.blob !== "object" ||
      item.blob === null ||
      !Number.isSafeInteger((item.blob as Blob).size) ||
      (item.blob as Blob).size <= 0 ||
      typeof (item.blob as Blob).arrayBuffer !== "function"
    ) {
      return null;
    }
    nodeIds.add(item.nodeId);
    attachmentIds.add(item.attachmentId);
    allIds.add(item.nodeId);
    allIds.add(item.attachmentId);
    items.push({
      nodeId: item.nodeId,
      attachmentId: item.attachmentId,
      originalName: item.originalName,
      mimeType: item.mimeType,
      blob: item.blob as Blob
    });
  }

  let aggregateBytes = 0;
  for (const item of items) {
    if (item.blob.size > MAX_NOTE_ATTACHMENT_BYTES) {
      return null;
    }
    aggregateBytes += item.blob.size;
    if (aggregateBytes > MAX_NOTE_ATTACHMENT_BATCH_BYTES) {
      return null;
    }
  }

  return {
    input: {
      parentId,
      afterId,
      items,
      initialMaxDisplayWidth: input.initialMaxDisplayWidth as number
    },
    nodeIds: items.map((item) => item.nodeId)
  };
}

async function invokeNotes<T>(
  command: string,
  args: Record<string, unknown>
): Promise<T> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    throw new Error("Notes requires Tauri desktop storage.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export function notesInitialize(
  vaultPath: string,
  input: NotesInitializeInput
): Promise<NotesHistoryState> {
  return invokeHistoryState(
    "notes_initialize",
    { vaultPath, input },
    "load",
    "Notes initialize returned an invalid history state."
  );
}

export async function notesLoadWorkspace(
  vaultPath: string,
  scope: NotesWorkspaceScope
): Promise<NotesWorkspace> {
  if (
    scope.kind === "tags" &&
    scope.tags.some((tag) => !isCanonicalNoteTagBody(tag.normalizedTag))
  ) {
    return Promise.reject(
      new Error(
        "Structured Notes search tag normalizedTag must be a canonical tag body."
      )
    );
  }
  let result: unknown;
  try {
    result = await invokeNotes<unknown>("notes_load_workspace", {
      vaultPath,
      scope
    });
  } catch (cause) {
    throw notesStoreError("load", cause);
  }
  const workspace = normalizeNotesWorkspace(result);
  if (workspace === null) {
    throw notesStoreError(
      "load",
      "Notes load returned an invalid workspace.",
      false
    );
  }
  return workspace;
}

export function notesCreateNode(
  vaultPath: string,
  input: CreateNoteNodeInput,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeMutation("notes_create_node", { vaultPath, input, historyContext }, historyContext);
}

export function notesUpdateNode(
  vaultPath: string,
  input: UpdateNoteNodeInput,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeMutation("notes_update_node", { vaultPath, input, historyContext }, historyContext);
}

export function notesSplitNode(
  vaultPath: string,
  input: SplitNoteNodeInput,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeMutation("notes_split_node", { vaultPath, input, historyContext }, historyContext);
}

export async function notesApplyImageAtomEdit(
  vaultPath: string,
  input: ApplyImageAtomEditInput,
  historyContext: NotesHistoryContext
): Promise<ImageAtomMutationResult> {
  const normalizedInput = normalizeApplyImageAtomEditInput(input);
  const normalizedHistoryContext = normalizeImageAtomEditHistoryContext(historyContext);
  if (normalizedInput === undefined || normalizedHistoryContext === undefined) {
    throw notesStoreError("write", "Notes image atom edit input is invalid.", false);
  }
  let result: unknown;
  try {
    result = await invokeNotes<unknown>("notes_apply_image_atom_edit", {
      vaultPath,
      input: normalizedInput,
      historyContext: normalizedHistoryContext
    });
  } catch (cause) {
    throw notesStoreError("write", cause);
  }
  if (
    !isImageAtomMutationResult(result) ||
    result.operation.operationId !== normalizedHistoryContext.entryId ||
    result.historyEntryId !== normalizedHistoryContext.entryId ||
    result.operation.historyEpoch !== normalizedHistoryContext.historyEpoch
  ) {
    throw notesStoreError(
      "write",
      "Notes image atom edit returned an invalid result.",
      false
    );
  }
  return result;
}

export async function notesApplyImageAtomPaste(
  vaultPath: string,
  input: ApplyImageAtomPasteInput,
  historyContext: NotesHistoryContext
): Promise<ImageAtomMutationResult> {
  const normalizedInput = normalizeApplyImageAtomPasteInput(input);
  const normalizedHistoryContext = normalizeImageAtomPasteHistoryContext(historyContext);
  if (normalizedInput === undefined || normalizedHistoryContext === undefined) {
    throw notesStoreError("write", "Notes image atom paste input is invalid.", false);
  }
  let result: unknown;
  try {
    const body = await encodeNotesImageAtomPasteRawEnvelope(
      vaultPath,
      normalizedInput,
      normalizedHistoryContext
    );
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      throw new Error("Notes requires Tauri desktop storage.");
    }
    const { invoke } = await import("@tauri-apps/api/core");
    result = await invoke<unknown>("notes_apply_image_atom_paste", body);
  } catch (cause) {
    throw notesStoreError("write", cause);
  }
  if (
    !isImageAtomMutationResult(result) ||
    result.operation.operationId !== normalizedHistoryContext.entryId ||
    result.historyEntryId !== normalizedHistoryContext.entryId ||
    result.operation.historyEpoch !== normalizedHistoryContext.historyEpoch
  ) {
    throw notesStoreError(
      "write",
      "Notes image atom paste returned an invalid result.",
      false
    );
  }
  return result;
}

export function notesMoveNode(
  vaultPath: string,
  input: MoveNoteNodeInput,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeMutation("notes_move_node", { vaultPath, input, historyContext }, historyContext);
}

export function notesApplyBatch(
  vaultPath: string,
  input: ApplyNotesBatchInput,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  if (input.nodeIds.length === 0) {
    return Promise.reject(
      new Error("A batch operation requires at least one node.")
    );
  }
  if (input.nodeIds.length > MAX_NOTES_BATCH_NODE_IDS) {
    return Promise.reject(
      new Error("A batch operation can contain at most 10,000 node IDs.")
    );
  }
  const seenNodeIds = new Set<NoteId>();
  const nodeIds = input.nodeIds.filter((nodeId) => {
    if (seenNodeIds.has(nodeId)) {
      return false;
    }
    seenNodeIds.add(nodeId);
    return true;
  });
  const normalizedInput = { ...input, nodeIds } as ApplyNotesBatchInput;
  // Reuses the shared mutation transport: the result is validated with
  // isNotesMutationResult (normalizeMutationResult) and a rejected IPC is mapped
  // to a structured NotesStoreError via parseNotesError (notesStoreError). One
  // backend transaction / one history entry, so undo reverts the batch in one
  // step.
  return invokeMutation(
    "notes_apply_batch",
    { vaultPath, input: normalizedInput, historyContext },
    historyContext
  );
}

export function notesImportSubtree(
  vaultPath: string,
  input: ImportSubtreeInput,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  // Reuses the shared mutation transport, exactly like notesApplyBatch: the
  // result is validated with isNotesMutationResult (normalizeMutationResult),
  // a rejected IPC is mapped to a structured NotesStoreError, and one backend
  // transaction / one history entry means one undo step removes the whole
  // imported subtree.
  return invokeMutation(
    "notes_import_subtree",
    { vaultPath, input, historyContext },
    historyContext
  );
}

export async function notesImportMarkdown(
  vaultPath: string,
  input: ImportNotesMarkdownInput,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  const normalizedHistoryContext =
    normalizeMarkdownImportHistoryContext(historyContext);
  if (
    !isImportNotesMarkdownInput(input) ||
    normalizedHistoryContext === undefined
  ) {
    throw notesStoreError(
      "write",
      "Notes Markdown import input is invalid.",
      false
    );
  }
  const normalizedInput: ImportNotesMarkdownInput = {
    sourcePath: input.sourcePath,
    parentId: input.parentId,
    afterId: input.afterId
  };

  const result = await invokeMutation(
    "notes_import_markdown",
    { vaultPath, input: normalizedInput, historyContext: normalizedHistoryContext },
    normalizedHistoryContext
  );
  const importedRootIds = result.importedRootIds;
  const importedRootId = importedRootIds?.[0];
  if (
    importedRootIds === undefined ||
    importedRootIds.length !== 1 ||
    !isCanonicalUuidV4(importedRootId) ||
    result.historyEntryId !== normalizedHistoryContext.entryId ||
    !result.workspace.nodes.some((node) => node.id === importedRootId)
  ) {
    throw notesStoreError(
      "write",
      "Notes Markdown import returned an invalid result.",
      false
    );
  }
  return result;
}

async function invokeMutation(
  command: string,
  args: Record<string, unknown>,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  let result: unknown;
  try {
    result = await invokeNotes<unknown>(command, args);
  } catch (cause) {
    throw notesStoreError("write", cause);
  }
  return normalizeMutationResult(result, historyContext);
}

function normalizeMutationResult(
  result: unknown,
  historyContext: NotesHistoryContext
): NotesMutationResult {
  if (!isNotesMutationResult(result)) {
    throw notesStoreError(
      "write",
      "Notes mutation returned an invalid result.",
      false
    );
  }
  if (
    result.historyEntryId !== null &&
    result.historyEntryId !== historyContext.entryId
  ) {
    throw notesStoreError(
      "write",
      "Notes mutation returned an unexpected history entry ID.",
      false
    );
  }
  const workspace = normalizeNotesWorkspace(result.workspace);
  if (workspace === null || !workspaceHasUniqueNodeIds(workspace)) {
    throw notesStoreError(
      "write",
      "Notes mutation returned an invalid result.",
      false
    );
  }
  return { ...result, workspace };
}

function workspaceHasUniqueNodeIds(workspace: NotesWorkspace): boolean {
  const nodeIds = new Set<NoteId>();
  for (const node of workspace.nodes) {
    if (nodeIds.has(node.id)) {
      return false;
    }
    nodeIds.add(node.id);
  }
  return true;
}

function canonicalNodeEquals(left: NoteNode, right: NoteNode): boolean {
  return (
    left.id === right.id &&
    left.nodeKind === right.nodeKind &&
    left.parentId === right.parentId &&
    left.sortKey === right.sortKey &&
    left.title === right.title &&
    left.note === right.note &&
    left.imageOffsetUtf16 === right.imageOffsetUtf16 &&
    left.layoutMode === right.layoutMode &&
    left.isCollapsed === right.isCollapsed &&
    left.isStarred === right.isStarred &&
    left.completedAt === right.completedAt &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.deletedAt === right.deletedAt &&
    left.archivedAt === right.archivedAt &&
    left.archiveRootId === right.archiveRootId
  );
}

function canonicalAttachmentEquals(
  left: NoteAttachment,
  right: NoteAttachment
): boolean {
  return (
    left.id === right.id &&
    left.nodeId === right.nodeId &&
    left.sortKey === right.sortKey &&
    left.relativePath === right.relativePath &&
    left.contentHash === right.contentHash &&
    left.originalName === right.originalName &&
    left.mimeType === right.mimeType &&
    left.byteSize === right.byteSize &&
    left.intrinsicWidth === right.intrinsicWidth &&
    left.intrinsicHeight === right.intrinsicHeight &&
    left.displayWidth === right.displayWidth &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

const NOTE_SORT_KEY_STEP = 1024;

function imageNodeImportDeltaMatchesWorkspace(
  result: NotesMutationResult,
  input: ImportImageNodePathsInput | ImportImageNodeBytesInput
): boolean {
  const deltaFields = [
    result.changedNodes !== undefined,
    result.removedNodeIds !== undefined,
    result.changedAttachments !== undefined
  ];
  if (!deltaFields.every(Boolean)) {
    return false;
  }

  const changedNodes = result.changedNodes!;
  const removedNodeIds = result.removedNodeIds!;
  const changedAttachments = result.changedAttachments!;
  const importedNodeIds = new Set(input.items.map((item) => item.nodeId));
  const canonicalNodesById = new Map(
    result.workspace.nodes.map((node) => [node.id, node])
  );
  const canonicalAttachmentsById = new Map<string, NoteAttachment>();
  for (const attachments of Object.values(
    result.workspace.attachmentsByNodeId ?? {}
  )) {
    for (const attachment of attachments) {
      canonicalAttachmentsById.set(attachment.id, attachment);
    }
  }

  const changedNodeIds = new Set<NoteId>();
  for (const changedNode of changedNodes) {
    const canonicalNode = canonicalNodesById.get(changedNode.id);
    if (
      changedNodeIds.has(changedNode.id) ||
      !canonicalNode ||
      !canonicalNodeEquals(changedNode, canonicalNode)
    ) {
      return false;
    }
    changedNodeIds.add(changedNode.id);
  }

  if (removedNodeIds.length !== 0) {
    return false;
  }

  // A sparse-key rebalance updates every live sibling. If the delta reports
  // one existing sibling, require the complete step-aligned sibling set.
  const reportsSiblingRebalance = changedNodes.some(
    (node) => !importedNodeIds.has(node.id)
  );
  const expectedChangedNodeIds = reportsSiblingRebalance
    ? new Set(
        result.workspace.nodes
          .filter(
            (node) =>
              node.parentId === input.parentId &&
              node.deletedAt === null &&
              node.archivedAt === null
          )
          .map((node) => node.id)
      )
    : importedNodeIds;
  if (
    changedNodeIds.size !== expectedChangedNodeIds.size ||
    [...expectedChangedNodeIds].some((id) => !changedNodeIds.has(id))
  ) {
    return false;
  }
  if (
    reportsSiblingRebalance &&
    result.workspace.nodes.some(
      (node) =>
        node.parentId === input.parentId &&
        node.deletedAt === null &&
        node.archivedAt === null &&
        !importedNodeIds.has(node.id) &&
        (node.sortKey <= 0 || node.sortKey % NOTE_SORT_KEY_STEP !== 0)
    )
  ) {
    return false;
  }

  if (changedAttachments.length !== input.items.length) {
    return false;
  }
  for (let index = 0; index < input.items.length; index += 1) {
    const item = input.items[index]!;
    const changedAttachment = changedAttachments[index]!;
    const canonicalAttachment = canonicalAttachmentsById.get(
      changedAttachment.id
    );
    if (
      changedAttachment.id !== item.attachmentId ||
      changedAttachment.nodeId !== item.nodeId ||
      !canonicalAttachment ||
      !canonicalAttachmentEquals(changedAttachment, canonicalAttachment)
    ) {
      return false;
    }
  }

  return true;
}

function normalizeImageNodeImportResult(
  result: unknown,
  historyContext: NotesHistoryContext,
  input: ImportImageNodePathsInput | ImportImageNodeBytesInput
): NotesMutationResult {
  const normalized = normalizeMutationResult(result, historyContext);
  const expectedImportedRootIds = input.items.map((item) => item.nodeId);
  if (
    !Array.isArray(normalized.importedRootIds) ||
    normalized.importedRootIds.length !== expectedImportedRootIds.length ||
    normalized.importedRootIds.some(
      (id, index) => id !== expectedImportedRootIds[index]
    )
  ) {
    throw notesStoreError(
      "write",
      "Notes image-node import returned unexpected imported root IDs.",
      false
    );
  }
  if (
    normalized.historyEntryId !== historyContext.entryId ||
    !imageNodeImportWorkspaceMatchesInput(normalized.workspace, input)
  ) {
    throw notesStoreError(
      "write",
      "Notes image-node import returned an invalid workspace.",
      false
    );
  }
  if (!imageNodeImportDeltaMatchesWorkspace(normalized, input)) {
    throw notesStoreError(
      "write",
      "Notes image-node import returned an invalid mutation delta.",
      false
    );
  }
  return normalized;
}

function imageNodeImportWorkspaceMatchesInput(
  workspace: NotesWorkspace,
  input: ImportImageNodePathsInput | ImportImageNodeBytesInput
): boolean {
  const nodesById = new Map(workspace.nodes.map((node) => [node.id, node]));
  if (input.parentId !== null && !nodesById.has(input.parentId)) {
    return false;
  }

  const siblings = workspace.nodes
    .filter((node) => node.parentId === input.parentId)
    .sort(
      (left, right) =>
        left.sortKey - right.sortKey || left.id.localeCompare(right.id)
    );
  const anchorIndex =
    input.afterId === null
      ? -1
      : siblings.findIndex((node) => node.id === input.afterId);
  if (input.afterId !== null && anchorIndex < 0) {
    return false;
  }

  const expectedNodeIds = input.items.map((item) => item.nodeId);
  const actualNodeIds = siblings
    .slice(anchorIndex + 1, anchorIndex + 1 + expectedNodeIds.length)
    .map((node) => node.id);
  if (
    actualNodeIds.length !== expectedNodeIds.length ||
    actualNodeIds.some((id, index) => id !== expectedNodeIds[index])
  ) {
    return false;
  }

  for (const item of input.items) {
    const node = nodesById.get(item.nodeId);
    if (
      !node ||
      node.nodeKind !== "image" ||
      node.parentId !== input.parentId ||
      node.deletedAt !== null ||
      node.archivedAt !== null
    ) {
      return false;
    }
    const attachments = workspace.attachmentsByNodeId?.[item.nodeId] ?? [];
    if (
      attachments.length !== 1 ||
      attachments[0]?.id !== item.attachmentId ||
      attachments[0].nodeId !== item.nodeId
    ) {
      return false;
    }
  }

  return true;
}

function invokeNodeMutation(
  command: string,
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeMutation(
    command,
    { vaultPath, nodeId, historyContext },
    historyContext
  );
}

export function notesToggleComplete(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_toggle_complete", vaultPath, nodeId, historyContext);
}

export function notesToggleCollapsed(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_toggle_collapsed", vaultPath, nodeId, historyContext);
}

export function notesExpandAll(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_expand_all", vaultPath, nodeId, historyContext);
}

export function notesCollapseAll(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_collapse_all", vaultPath, nodeId, historyContext);
}

export function notesSortSubtreeAscending(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeNodeMutation(
    "notes_sort_subtree_ascending",
    vaultPath,
    nodeId,
    historyContext
  );
}

export function notesSortSubtreeDescending(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeNodeMutation(
    "notes_sort_subtree_descending",
    vaultPath,
    nodeId,
    historyContext
  );
}

export function notesToggleStar(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_toggle_star", vaultPath, nodeId, historyContext);
}

export function notesDuplicateNode(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_duplicate_node", vaultPath, nodeId, historyContext);
}

export function notesRemoveEmptyNode(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_remove_empty_node", vaultPath, nodeId, historyContext);
}

export function notesSoftDeleteNode(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_soft_delete_node", vaultPath, nodeId, historyContext);
}

export function notesRestoreNode(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_restore_node", vaultPath, nodeId, historyContext);
}

export function notesArchiveNode(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_archive_node", vaultPath, nodeId, historyContext);
}

export function notesUnarchiveNode(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_unarchive_node", vaultPath, nodeId, historyContext);
}

export function notesUndo(
  vaultPath: string,
  input: NotesHistoryReplayInput
): Promise<NotesHistoryReplayOutcome> {
  return invokeHistoryReplay("notes_undo", { vaultPath, request: input });
}

export function notesRedo(
  vaultPath: string,
  input: NotesHistoryReplayInput
): Promise<NotesHistoryReplayOutcome> {
  return invokeHistoryReplay("notes_redo", { vaultPath, request: input });
}

async function invokeHistoryReplay(
  command: string,
  args: Record<string, unknown>
): Promise<NotesHistoryReplayOutcome> {
  let result: unknown;
  try {
    result = await invokeNotes<unknown>(command, args);
  } catch (cause) {
    throw notesStoreError("write", cause);
  }
  if (!isNotesHistoryReplayOutcome(result)) {
    throw notesStoreError(
      "write",
      "Notes history replay returned an invalid result.",
      false
    );
  }
  if (result.kind === "applied") {
    const workspace = normalizeNotesWorkspace(result.workspace);
    if (workspace === null) {
      throw notesStoreError(
        "write",
        "Notes history replay returned an invalid result.",
        false
      );
    }
    return { ...result, workspace };
  }
  return result;
}

async function invokeHistoryState(
  command: string,
  args: Record<string, unknown>,
  operation: NotesStoreError["operation"] = "write",
  invalidMessage = "Notes history operation returned an invalid state."
): Promise<NotesHistoryState> {
  let result: unknown;
  try {
    result = await invokeNotes<unknown>(command, args);
  } catch (cause) {
    throw notesStoreError(operation, cause);
  }
  if (!isNotesHistoryState(result)) {
    throw notesStoreError(operation, invalidMessage, false);
  }
  return result;
}

export function notesHistoryStatus(
  vaultPath: string,
  sessionId: string
): Promise<NotesHistoryStatus> {
  return invokeHistoryState(
    "notes_history_status",
    { vaultPath, sessionId },
    "write",
    "Notes history status returned an invalid state."
  );
}

export async function notesLookupImageAtomOperation(
  vaultPath: string,
  sessionId: string,
  historyEpoch: string,
  operationId: string
): Promise<ImageAtomOperationLookup> {
  const authority = normalizeImageAtomOperationAuthority(
    sessionId,
    historyEpoch,
    operationId
  );
  if (authority === undefined) {
    throw notesStoreError(
      "write",
      "Notes image operation lookup authority is invalid.",
      false
    );
  }
  let result: unknown;
  try {
    result = await invokeNotes<unknown>("notes_lookup_image_atom_operation", {
      vaultPath,
      ...authority
    });
  } catch (cause) {
    throw notesStoreError("write", cause);
  }
  if (!isImageAtomOperationLookup(result)) {
    throw notesStoreError(
      "write",
      "Notes image operation lookup returned an invalid result.",
      false
    );
  }
  const matchesAuthority =
    result.kind === "found"
      ? result.receipt.operationId === authority.operationId &&
        result.receipt.historyEpoch === authority.historyEpoch
      : result.kind === "missing"
        ? result.historyEpoch === authority.historyEpoch
        : result.historyEpoch !== authority.historyEpoch;
  if (!matchesAuthority) {
    throw notesStoreError(
      "write",
      "Notes image operation lookup returned an invalid result.",
      false
    );
  }
  return result;
}

export async function notesAckImageAtomOperation(
  vaultPath: string,
  sessionId: string,
  historyEpoch: string,
  operationId: string
): Promise<void> {
  const authority = normalizeImageAtomOperationAuthority(
    sessionId,
    historyEpoch,
    operationId
  );
  if (authority === undefined) {
    throw notesStoreError(
      "write",
      "Notes image operation acknowledgement authority is invalid.",
      false
    );
  }
  let result: unknown;
  try {
    result = await invokeNotes<unknown>("notes_ack_image_atom_operation", {
      vaultPath,
      ...authority
    });
  } catch (cause) {
    throw notesStoreError("write", cause);
  }
  if (result !== null) {
    throw notesStoreError(
      "write",
      "Notes image operation acknowledgement returned an invalid result.",
      false
    );
  }
}

export async function notesClearHistory(
  vaultPath: string,
  input: NotesHistoryResetInput
): Promise<NotesHistoryResetResult> {
  const { workspace: _workspace, ...result } = await invokeWorkspaceReset(
    "notes_clear_history",
    { vaultPath, input },
    "Notes clear history returned an invalid reset result."
  );
  return result;
}

export function notesPrepareNavigation(
  vaultPath: string,
  input: NotesPrepareNavigationInput
): Promise<NotesHistoryState> {
  return invokeHistoryState("notes_prepare_navigation", { vaultPath, input });
}

export function notesPruneHistoryEntries(
  vaultPath: string,
  input: NotesPruneHistoryInput
): Promise<NotesHistoryState> {
  return invokeHistoryState("notes_prune_history_entries", {
    vaultPath,
    input
  });
}

export async function notesCloseHistorySession(
  vaultPath: string,
  input: NotesHistoryCloseInput
): Promise<void> {
  try {
    await invokeNotes<void>("notes_close_history_session", {
      vaultPath,
      input
    });
  } catch (cause) {
    throw notesStoreError("write", cause);
  }
}

export function notesImportAttachment(
  vaultPath: string,
  input: ImportNoteAttachmentInput,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  const normalizedInput = normalizeImportAttachmentInput(input);
  if (normalizedInput === null) {
    return Promise.reject(
      notesStoreError(
        "write",
        "Notes attachment import input is invalid.",
        false
      )
    );
  }
  return notesImportAttachmentPaths(
    vaultPath,
    {
      nodeId: normalizedInput.nodeId,
      attachments: [
        { id: normalizedInput.id, sourcePath: normalizedInput.sourcePath }
      ],
      initialMaxDisplayWidth: normalizedInput.initialMaxDisplayWidth
    },
    historyContext
  );
}

export function notesImportAttachmentPaths(
  vaultPath: string,
  input: ImportNoteAttachmentPathBatchInput,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  const normalizedInput = normalizeImportAttachmentPathBatchInput(input);
  const normalizedHistoryContext =
    normalizeAttachmentHistoryContext(historyContext);
  if (normalizedInput === null || normalizedHistoryContext === undefined) {
    return Promise.reject(
      notesStoreError(
        "write",
        "Notes attachment path batch input is invalid.",
        false
      )
    );
  }
  return invokeMutation(
    "notes_import_attachment_paths_batch",
    { vaultPath, input: normalizedInput, historyContext: normalizedHistoryContext },
    normalizedHistoryContext
  );
}

export async function notesImportAttachmentBytes(
  vaultPath: string,
  input: ImportNoteAttachmentBytesBatchInput,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  const normalization = normalizeImportAttachmentBytesBatchInput(input);
  const normalizedHistoryContext =
    normalizeAttachmentHistoryContext(historyContext);
  if (normalization.input === null || normalizedHistoryContext === undefined) {
    throw notesStoreError(
      "write",
      normalizedHistoryContext === undefined
        ? "Notes attachment byte batch input is invalid."
        : normalization.errorMessage,
      false
    );
  }
  const normalizedInput = normalization.input;

  let result: unknown;
  try {
    const body = await encodeNotesAttachmentRawEnvelope(
      vaultPath,
      normalizedInput,
      normalizedHistoryContext
    );
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      throw new Error("Notes requires Tauri desktop storage.");
    }
    const { invoke } = await import("@tauri-apps/api/core");
    result = await invoke<unknown>("notes_import_attachment_bytes", body);
  } catch (cause) {
    throw notesStoreError("write", cause);
  }
  return normalizeMutationResult(result, normalizedHistoryContext);
}

export async function notesImportImageNodePaths(
  vaultPath: string,
  input: ImportImageNodePathsInput,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  const normalization = normalizeImportImageNodePathsInput(input);
  const normalizedHistoryContext =
    normalizeAttachmentHistoryContext(historyContext);
  if (normalization === null || normalizedHistoryContext === undefined) {
    throw notesStoreError(
      "write",
      "Notes image-node path import input is invalid.",
      false
    );
  }

  let result: unknown;
  try {
    result = await invokeNotes<unknown>("notes_import_image_node_paths_batch", {
      vaultPath,
      input: normalization.input,
      historyContext: normalizedHistoryContext
    });
  } catch (cause) {
    throw notesStoreError("write", cause);
  }
  return normalizeImageNodeImportResult(
    result,
    normalizedHistoryContext,
    normalization.input
  );
}

export async function notesImportImageNodeBytes(
  vaultPath: string,
  input: ImportImageNodeBytesInput,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  const normalization = normalizeImportImageNodeBytesInput(input);
  const normalizedHistoryContext =
    normalizeAttachmentHistoryContext(historyContext);
  if (normalization === null || normalizedHistoryContext === undefined) {
    throw notesStoreError(
      "write",
      "Notes image-node byte import input is invalid.",
      false
    );
  }

  let result: unknown;
  try {
    const body = await encodeNotesImageNodeRawEnvelope(
      vaultPath,
      normalization.input,
      normalizedHistoryContext
    );
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      throw new Error("Notes requires Tauri desktop storage.");
    }
    const { invoke } = await import("@tauri-apps/api/core");
    result = await invoke<unknown>("notes_import_image_node_bytes", body);
  } catch (cause) {
    throw notesStoreError("write", cause);
  }
  return normalizeImageNodeImportResult(
    result,
    normalizedHistoryContext,
    normalization.input
  );
}

export async function notesReadAttachmentBytes(
  vaultPath: string,
  attachmentId: string
): Promise<Uint8Array> {
  let result: unknown;
  try {
    result = await invokeNotes<unknown>("notes_read_attachment_bytes", {
      vaultPath,
      attachmentId
    });
  } catch (cause) {
    throw notesStoreError("load", cause);
  }

  // Typed raw-IPC responses keep the bulk-copy fast path. Tauri on macOS may
  // expose the same response as a JSON number array, which uses the strict
  // bounded byte-array fallback below.
  let source: Uint8Array;
  let needsOwnedCopy = true;
  if (isStandardByteArray(result)) {
    source = result;
  } else if (isStandardArrayBuffer(result)) {
    source = new Uint8Array(result);
  } else if (isStandardJsonByteArray(result)) {
    source = Uint8Array.from(result);
    needsOwnedCopy = false;
  } else {
    throw notesStoreError(
      "load",
      "Notes attachment bytes returned an invalid result.",
      false
    );
  }

  if (source.length === 0 || source.length > MAX_NOTE_ATTACHMENT_BYTES) {
    throw notesStoreError(
      "load",
      "Notes attachment bytes returned an invalid result.",
      false
    );
  }

  // Return an owned copy so callers never observe the transport buffer.
  return needsOwnedCopy ? source.slice() : source;
}

async function invokeAttachmentVoidAction(
  command: string,
  args: Record<string, unknown>
): Promise<void> {
  let result: unknown;
  try {
    result = await invokeNotes<unknown>(command, args);
  } catch (cause) {
    throw notesStoreError("write", cause);
  }
  if (result !== null) {
    throw notesStoreError(
      "write",
      "Notes attachment action returned an invalid result.",
      false
    );
  }
}

export function notesOpenAttachmentOriginal(
  vaultPath: string,
  attachmentId: string
): Promise<void> {
  if (!isNonEmptyNativeString(attachmentId)) {
    return Promise.reject(
      notesStoreError(
        "write",
        "Notes attachment action input is invalid.",
        false
      )
    );
  }
  return invokeAttachmentVoidAction("notes_open_attachment_original", {
    vaultPath,
    attachmentId
  });
}

export function notesDownloadAttachment(
  vaultPath: string,
  attachmentId: string
): Promise<void> {
  if (!isNonEmptyNativeString(attachmentId)) {
    return Promise.reject(
      notesStoreError(
        "write",
        "Notes attachment action input is invalid.",
        false
      )
    );
  }
  return invokeAttachmentVoidAction("notes_download_attachment", {
    vaultPath,
    attachmentId
  });
}

export function notesResizeAttachment(
  vaultPath: string,
  input: ResizeNoteAttachmentInput,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeMutation(
    "notes_resize_attachment",
    { vaultPath, input, historyContext },
    historyContext
  );
}

export function notesRemoveAttachment(
  vaultPath: string,
  attachmentId: string,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeMutation(
    "notes_remove_attachment",
    { vaultPath, attachmentId, historyContext },
    historyContext
  );
}

export function notesRestoreAttachment(
  vaultPath: string,
  attachmentId: string,
  historyContext: NotesHistoryContext
): Promise<NotesMutationResult> {
  return invokeMutation(
    "notes_restore_attachment",
    { vaultPath, attachmentId, historyContext },
    historyContext
  );
}

export async function notesEmptyTrash(
  vaultPath: string,
  input: NotesHistoryResetInput
): Promise<NotesWorkspaceResetResult> {
  return invokeWorkspaceReset(
    "notes_empty_trash",
    { vaultPath, input },
    "Notes empty trash returned an invalid reset result."
  );
}

async function invokeWorkspaceReset(
  command: string,
  args: Record<string, unknown>,
  invalidMessage: string
): Promise<NotesWorkspaceResetResult> {
  let result: unknown;
  try {
    result = await invokeNotes<unknown>(command, args);
  } catch (cause) {
    throw notesStoreError("write", cause);
  }
  if (!isNotesWorkspaceResetResult(result)) {
    throw notesStoreError("write", invalidMessage, false);
  }
  const workspace = normalizeNotesWorkspace(result.workspace);
  if (workspace === null) {
    throw notesStoreError("write", invalidMessage, false);
  }
  return { ...result, workspace };
}

export async function notesSearch(
  vaultPath: string,
  query: string,
  scope: NoteSearchScope = { kind: "active" }
): Promise<NoteSearchResult[]> {
  const results = await invokeNotes<unknown>("notes_search", {
    vaultPath,
    query,
    scope
  });
  if (!Array.isArray(results) || !results.every(isNoteSearchResult)) {
    throw new Error("Notes search returned an invalid result.");
  }
  return results;
}

export async function notesSearchStructured(
  vaultPath: string,
  query: NoteStructuredSearchQuery
): Promise<NoteSearchResult[]> {
  const validation = validateAndCanonicalizeNoteSearchQuery(query);
  if (!validation.ok) {
    throw new Error(validation.error.message);
  }
  const results = await invokeNotes<unknown>("notes_search_structured", {
    vaultPath,
    query
  });
  if (!Array.isArray(results) || !results.every(isNoteSearchResult)) {
    throw new Error("Notes search returned an invalid result.");
  }
  return results;
}

export function notesListTags(vaultPath: string): Promise<string[]> {
  return invokeNotes<string[]>("notes_list_tags", { vaultPath });
}

export function notesListTagsWithCounts(
  vaultPath: string
): Promise<NoteTagSummary[]> {
  return invokeNotes<NoteTagSummary[]>("notes_list_tags_with_counts", { vaultPath });
}

export type { NotesDeleteDatabaseResult } from "../domain/notes";

export async function notesDeleteDatabase(
  vaultPath: string
): Promise<NotesDeleteDatabaseResult> {
  const result = await invokeNotes<unknown>("notes_delete_database", {
    vaultPath
  });
  if (
    !isPlainRecord(result) ||
    typeof result.attachmentCleanupFailed !== "boolean"
  ) {
    throw new Error("Notes data deletion returned an invalid result.");
  }
  return { attachmentCleanupFailed: result.attachmentCleanupFailed };
}

export const notesStore: NotesStore = {
  initialize: notesInitialize,
  loadWorkspace: notesLoadWorkspace,
  createNode: notesCreateNode,
  updateNode: notesUpdateNode,
  splitNode: notesSplitNode,
  applyImageAtomEdit: notesApplyImageAtomEdit,
  applyImageAtomPaste: notesApplyImageAtomPaste,
  moveNode: notesMoveNode,
  applyBatch: notesApplyBatch,
  importSubtree: notesImportSubtree,
  importMarkdown: notesImportMarkdown,
  toggleComplete: notesToggleComplete,
  toggleCollapsed: notesToggleCollapsed,
  expandAll: notesExpandAll,
  collapseAll: notesCollapseAll,
  sortSubtreeAscending: notesSortSubtreeAscending,
  sortSubtreeDescending: notesSortSubtreeDescending,
  toggleStar: notesToggleStar,
  duplicateNode: notesDuplicateNode,
  removeEmptyNode: notesRemoveEmptyNode,
  softDeleteNode: notesSoftDeleteNode,
  restoreNode: notesRestoreNode,
  archiveNode: notesArchiveNode,
  unarchiveNode: notesUnarchiveNode,
  undo: notesUndo,
  redo: notesRedo,
  historyStatus: notesHistoryStatus,
  lookupImageAtomOperation: notesLookupImageAtomOperation,
  ackImageAtomOperation: notesAckImageAtomOperation,
  clearHistory: notesClearHistory,
  pruneHistoryEntries: notesPruneHistoryEntries,
  prepareNavigation: notesPrepareNavigation,
  closeHistorySession: notesCloseHistorySession,
  importAttachment: notesImportAttachment,
  importAttachmentPaths: notesImportAttachmentPaths,
  importAttachmentBytes: notesImportAttachmentBytes,
  importImageNodePaths: notesImportImageNodePaths,
  importImageNodeBytes: notesImportImageNodeBytes,
  openAttachmentOriginal: notesOpenAttachmentOriginal,
  downloadAttachment: notesDownloadAttachment,
  readAttachmentBytes: notesReadAttachmentBytes,
  resizeAttachment: notesResizeAttachment,
  removeAttachment: notesRemoveAttachment,
  restoreAttachment: notesRestoreAttachment,
  emptyTrash: notesEmptyTrash,
  search: notesSearch,
  searchStructured: notesSearchStructured,
  listTags: notesListTags,
  listTagsWithCounts: notesListTagsWithCounts,
  deleteDatabase: notesDeleteDatabase
};
