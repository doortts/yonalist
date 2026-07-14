import {
  isNoteSearchResult,
  isNotesHistoryReplayResult,
  isNotesMutationResult,
  isRetryableNotesErrorCode,
  MAX_NOTE_ATTACHMENT_BATCH_BYTES,
  MAX_NOTE_ATTACHMENT_BYTES,
  MAX_NOTE_ATTACHMENTS_PER_NODE,
  MAX_NOTES_BATCH_NODE_IDS,
  normalizeNotesWorkspace,
  parseNotesError
} from "../domain/notes";
import { encodeNotesAttachmentRawEnvelope } from "./notesAttachmentRawIpc";
import {
  isCanonicalNoteTagBody,
  validateAndCanonicalizeNoteSearchQuery
} from "../features/notes/noteSearchQuery";
import type {
  ApplyNotesBatchInput,
  CreateNoteNodeInput,
  ImportNoteAttachmentBytesBatchInput,
  ImportNoteAttachmentInput,
  ImportNoteAttachmentPathBatchInput,
  ImportSubtreeInput,
  MoveNoteNodeInput,
  NoteId,
  NoteSearchResult,
  NoteSearchScope,
  NoteStructuredSearchQuery,
  NoteTagSummary,
  NotesHistoryContext,
  NotesHistoryReplayResult,
  NotesHistoryStatus,
  NotesDeleteDatabaseResult,
  NotesMutationResult,
  NotesStore,
  NotesStoreError,
  NotesWorkspace,
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
): NotesHistoryContext | null | undefined {
  if (historyContext == null) {
    return null;
  }
  if (
    !isPlainRecord(historyContext) ||
    !hasExactKeys(historyContext, ["sessionId", "entryId", "commandKind"]) ||
    !isCanonicalUuidV4(historyContext.sessionId) ||
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
    entryId: historyContext.entryId,
    commandKind
  };
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

export async function notesInitialize(vaultPath: string): Promise<void> {
  try {
    await invokeNotes<void>("notes_initialize", { vaultPath });
  } catch (cause) {
    throw notesStoreError("load", cause);
  }
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
  historyContext: NotesHistoryContext | null = null
): Promise<NotesMutationResult> {
  return invokeMutation("notes_create_node", { vaultPath, input, historyContext }, historyContext);
}

export function notesUpdateNode(
  vaultPath: string,
  input: UpdateNoteNodeInput,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesMutationResult> {
  return invokeMutation("notes_update_node", { vaultPath, input, historyContext }, historyContext);
}

export function notesSplitNode(
  vaultPath: string,
  input: SplitNoteNodeInput,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesMutationResult> {
  return invokeMutation("notes_split_node", { vaultPath, input, historyContext }, historyContext);
}

export function notesMoveNode(
  vaultPath: string,
  input: MoveNoteNodeInput,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesMutationResult> {
  return invokeMutation("notes_move_node", { vaultPath, input, historyContext }, historyContext);
}

export function notesApplyBatch(
  vaultPath: string,
  input: ApplyNotesBatchInput,
  historyContext: NotesHistoryContext | null = null
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
  historyContext: NotesHistoryContext | null = null
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

async function invokeMutation(
  command: string,
  args: Record<string, unknown>,
  historyContext: NotesHistoryContext | null
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
  historyContext: NotesHistoryContext | null
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
    result.historyEntryId !== historyContext?.entryId
  ) {
    throw notesStoreError(
      "write",
      "Notes mutation returned an unexpected history entry ID.",
      false
    );
  }
  const workspace = normalizeNotesWorkspace(result.workspace);
  if (workspace === null) {
    throw notesStoreError(
      "write",
      "Notes mutation returned an invalid result.",
      false
    );
  }
  return { ...result, workspace };
}

function invokeNodeMutation(
  command: string,
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
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
  historyContext: NotesHistoryContext | null = null
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_toggle_complete", vaultPath, nodeId, historyContext);
}

export function notesToggleCollapsed(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_toggle_collapsed", vaultPath, nodeId, historyContext);
}

export function notesExpandAll(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_expand_all", vaultPath, nodeId, historyContext);
}

export function notesCollapseAll(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_collapse_all", vaultPath, nodeId, historyContext);
}

export function notesSortSubtreeAscending(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
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
  historyContext: NotesHistoryContext | null = null
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
  historyContext: NotesHistoryContext | null = null
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_toggle_star", vaultPath, nodeId, historyContext);
}

export function notesDuplicateNode(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_duplicate_node", vaultPath, nodeId, historyContext);
}

export function notesRemoveEmptyNode(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_remove_empty_node", vaultPath, nodeId, historyContext);
}

export function notesSoftDeleteNode(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_soft_delete_node", vaultPath, nodeId, historyContext);
}

export function notesRestoreNode(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_restore_node", vaultPath, nodeId, historyContext);
}

export function notesArchiveNode(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_archive_node", vaultPath, nodeId, historyContext);
}

export function notesUnarchiveNode(
  vaultPath: string,
  nodeId: NoteId,
  historyContext: NotesHistoryContext | null = null
): Promise<NotesMutationResult> {
  return invokeNodeMutation("notes_unarchive_node", vaultPath, nodeId, historyContext);
}

export function notesUndo(
  vaultPath: string,
  sessionId: string,
  scope: NotesWorkspaceScope
): Promise<NotesHistoryReplayResult> {
  return invokeHistoryReplay("notes_undo", { vaultPath, sessionId, scope });
}

export function notesRedo(
  vaultPath: string,
  sessionId: string,
  scope: NotesWorkspaceScope
): Promise<NotesHistoryReplayResult> {
  return invokeHistoryReplay("notes_redo", { vaultPath, sessionId, scope });
}

async function invokeHistoryReplay(
  command: string,
  args: Record<string, unknown>
): Promise<NotesHistoryReplayResult> {
  let result: unknown;
  try {
    result = await invokeNotes<unknown>(command, args);
  } catch (cause) {
    throw notesStoreError("write", cause);
  }
  if (!isNotesHistoryReplayResult(result)) {
    throw notesStoreError(
      "write",
      "Notes history replay returned an invalid result.",
      false
    );
  }
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

export function notesHistoryStatus(
  vaultPath: string,
  sessionId: string
): Promise<NotesHistoryStatus> {
  return invokeNotes<NotesHistoryStatus>("notes_history_status", { vaultPath, sessionId });
}

export function notesClearHistory(
  vaultPath: string,
  sessionId: string
): Promise<NotesHistoryStatus> {
  return invokeNotes<NotesHistoryStatus>("notes_clear_history", { vaultPath, sessionId });
}

export function notesImportAttachment(
  vaultPath: string,
  input: ImportNoteAttachmentInput,
  historyContext: NotesHistoryContext | null = null
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
  historyContext: NotesHistoryContext | null = null
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
  historyContext: NotesHistoryContext | null = null
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

  // The command now streams a raw IPC body, so Tauri hands the webview either a
  // Uint8Array or an ArrayBuffer. Both are accepted with a strict prototype
  // check; there is no JSON numeric-array element-wise scan any more (a 20MB
  // image no longer becomes an ~80MB number array validated byte by byte).
  let source: Uint8Array;
  if (isStandardByteArray(result)) {
    source = result;
  } else if (isStandardArrayBuffer(result)) {
    source = new Uint8Array(result);
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
  return source.slice();
}

export function notesResizeAttachment(
  vaultPath: string,
  input: ResizeNoteAttachmentInput,
  historyContext: NotesHistoryContext | null = null
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
  historyContext: NotesHistoryContext | null = null
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
  historyContext: NotesHistoryContext | null = null
): Promise<NotesMutationResult> {
  return invokeMutation(
    "notes_restore_attachment",
    { vaultPath, attachmentId, historyContext },
    historyContext
  );
}

export async function notesEmptyTrash(
  vaultPath: string
): Promise<NotesWorkspace> {
  let result: unknown;
  try {
    result = await invokeNotes<unknown>("notes_empty_trash", { vaultPath });
  } catch (cause) {
    throw notesStoreError("write", cause);
  }
  const workspace = normalizeNotesWorkspace(result);
  if (workspace === null) {
    throw notesStoreError(
      "write",
      "Notes empty trash returned an invalid workspace.",
      false
    );
  }
  return workspace;
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
  moveNode: notesMoveNode,
  applyBatch: notesApplyBatch,
  importSubtree: notesImportSubtree,
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
  clearHistory: notesClearHistory,
  importAttachment: notesImportAttachment,
  importAttachmentPaths: notesImportAttachmentPaths,
  importAttachmentBytes: notesImportAttachmentBytes,
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
