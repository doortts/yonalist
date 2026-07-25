import type {
  GithubNotificationsPluginMeta,
  GithubNotificationsPluginState
} from "./externalSources";
import {
  isGithubNotificationsPluginMeta,
  isGithubNotificationsPluginState
} from "./externalSources";

export type NoteId = string;
export type NoteLayoutMode = "bullets";
export type NoteNodeKind = "text" | "image";
export type NoteMarkerKind = "bullet" | "todo";

export const MAX_NOTE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_NOTE_ATTACHMENT_BATCH_BYTES = 64 * 1024 * 1024;
export const MAX_NOTE_ATTACHMENT_BATCH_METADATA_BYTES = 256 * 1024;
export const MAX_NOTE_ATTACHMENT_PIXELS = 40_000_000;
export const MIN_NOTE_ATTACHMENT_DISPLAY_WIDTH = 160;
export const MAX_NOTE_ATTACHMENTS_PER_NODE = 128;
export const MAX_NOTE_ATTACHMENTS_PER_WORKSPACE = 512;
export const MAX_NOTE_IMAGE_NODE_IMPORT_BATCH_ITEMS = 128;
export const MAX_NOTES_BATCH_NODE_IDS = 10_000;
export const MAX_NOTE_MARKDOWN_IMAGE_DISPLAY_WIDTH = 16_384;

export interface NoteNode {
  id: NoteId;
  nodeKind: NoteNodeKind;
  markerKind: NoteMarkerKind;
  parentId: NoteId | null;
  sortKey: number;
  title: string;
  note: string;
  imageOffsetUtf16: number;
  markdownImageWidth: number | null;
  layoutMode: NoteLayoutMode;
  isCollapsed: boolean;
  isStarred: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  archivedAt: string | null;
  archiveRootId: NoteId | null;
  isReadonly?: boolean;
  pluginState?: GithubNotificationsPluginState;
  pluginMeta?: GithubNotificationsPluginMeta;
}

export interface NoteAttachment {
  id: string;
  nodeId: NoteId;
  sortKey: number;
  relativePath: string;
  contentHash: string;
  originalName: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  byteSize: number;
  intrinsicWidth: number;
  intrinsicHeight: number;
  displayWidth: number;
  createdAt: string;
  updatedAt: string;
}

export type NoteAttachmentsByNodeId = Record<NoteId, NoteAttachment[]>;

export interface NotesWorkspace {
  nodes: NoteNode[];
  /** Missing legacy payloads are normalized to an empty attachment map. */
  attachmentsByNodeId?: NoteAttachmentsByNodeId;
}

export interface DeleteReadonlyPreflight {
  readonlyDescendantIds: NoteId[];
}

export interface ConfirmReadonlyDescendants {
  expectedReadonlyDescendantIds: NoteId[];
}

export type NormalizedNotesWorkspace = NotesWorkspace & {
  attachmentsByNodeId: NoteAttachmentsByNodeId;
};

export interface NotesHistoryContext {
  sessionId: string;
  historyEpoch: string;
  entryId: string;
  commandKind: string;
}

export interface NotesHistoryState {
  canUndo: boolean;
  canRedo: boolean;
  historyEpoch: string;
  nextUndoEntryId: string | null;
  nextRedoEntryId: string | null;
  prunedEntryIds: string[];
}

export type NotesHistoryStatus = NotesHistoryState;

export interface NotesInitializeInput {
  sessionId: string;
}

export interface NotesHistoryReplayInput {
  sessionId: string;
  historyEpoch: string;
  expectedEntryId: string;
  scope: NotesWorkspaceScope;
}

export interface NotesPruneHistoryInput {
  sessionId: string;
  historyEpoch: string;
  entryIds: readonly string[];
}

export interface NotesPrepareNavigationInput {
  sessionId: string;
  historyEpoch: string;
  unreachableRedoEntryIds: readonly string[];
}

export interface NotesHistoryCloseInput {
  sessionId: string;
  historyEpoch: string;
}

export interface ImageAtomFocusResult {
  nodeId: NoteId;
  anchorUtf16: number;
  focusUtf16: number;
}

export interface ImageAtomOperationReceiptResult {
  operationId: string;
  historyEpoch: string;
  postconditionDigest: string;
  affectedRootIds: NoteId[];
  focus: ImageAtomFocusResult;
}

export type ImageAtomOperationLookup =
  | { kind: "found"; receipt: ImageAtomOperationReceiptResult }
  | { kind: "missing"; historyEpoch: string }
  | { kind: "epochMismatch"; historyEpoch: string };

export interface LogicalSelection {
  anchorUtf16: number;
  focusUtf16: number;
}

export interface ImageTargetAuthority {
  nodeId: NoteId;
  expectedUpdatedAt: string;
  expectedTitle: string;
  expectedImageOffsetUtf16: number;
  expectedPrimaryAttachmentId: string;
}

export type ImageAtomEdit =
  | { kind: "remove"; replacementText: string }
  | { kind: "enter"; siblingId: NoteId };

export interface ApplyImageAtomEditInput {
  target: ImageTargetAuthority;
  selection: LogicalSelection;
  edit: ImageAtomEdit;
}

export interface ImageAtomPasteTargetAuthority {
  nodeId: NoteId;
  expectedUpdatedAt: string;
  expectedNodeKind: NoteNodeKind;
  expectedTitle: string;
  expectedImageOffsetUtf16: number;
  expectedPrimaryAttachmentId: string | null;
}

export type ImageAtomFragmentItem =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "image";
      readonly nodeId: NoteId;
      readonly attachmentId: string;
      readonly originalName: string;
      readonly mimeType: NoteAttachment["mimeType"];
      readonly blob: Blob;
    };

export interface ApplyImageAtomPasteInput {
  readonly target: ImageAtomPasteTargetAuthority;
  readonly selection: LogicalSelection;
  readonly version: 1;
  readonly fragment: readonly ImageAtomFragmentItem[];
  readonly initialMaxDisplayWidth: number;
}

export interface NotesHistoryResetInput {
  sessionId: string;
  historyEpoch: string;
}

export interface NotesMutationResult extends NotesHistoryState {
  /**
   * Full post-mutation workspace. The native layer may omit it only when all
   * three audit-delta fields carry a complete, nonempty change. Callers must
   * reconstruct such a result from the coordinator's confirmed pre-mutation
   * workspace; explicit full-workspace consumers keep receiving this field.
   */
  workspace?: NotesWorkspace;
  historyEntryId: string | null;
  /**
   * Incremental deltas derived from the mutation's history audit rows. Present
   * only when the backend ran the mutation with a history context; otherwise
   * the full {@link NotesMutationResult.workspace} remains authoritative. These
   * are additive and not yet consumed (frontend consumption is a later phase).
   */
  changedNodes?: NoteNode[];
  removedNodeIds?: NoteId[];
  changedAttachments?: NoteAttachment[];
  /**
   * New root ids created by `notes_import_subtree` (paste import, plan Phase
   * 4.4), in the order supplied by the caller. Present only on that
   * mutation's result; every other mutation omits it. The frontend uses
   * `importedRootIds[0]` to focus the first imported node.
   */
  importedRootIds?: NoteId[];
  /**
   * New root ids created by a batch duplicate, in source order. Present only
   * on that mutation's result; every other mutation omits it.
   */
  duplicatedRootIds?: NoteId[];
}

export interface SetReadonlyNoteInput {
  nodeId: NoteId;
  isReadonly: boolean;
}

export interface DeleteNotesInput {
  nodeIds: readonly NoteId[];
  expectedReadonlyDescendantIds?: readonly NoteId[] | null;
}

export type DeleteNotesResponse = NotesMutationResponse | DeleteReadonlyPreflight;

export interface ImageAtomMutationResult extends NotesMutationResult {
  operation: ImageAtomOperationReceiptResult;
}

export type NotesMutationResponse = NotesWorkspace | NotesMutationResult;

export type NotesHistoryReplayOutcome =
  | ({
      kind: "applied";
      workspace: NotesWorkspace;
      replayedEntryId: string;
    } & NotesHistoryState)
  | ({
      kind: "epochMismatch" | "entryMissing" | "entryNotNext";
    } & NotesHistoryState);

export interface NotesHistoryResetResult extends NotesHistoryState {
  historyReset: true;
}

export interface NotesWorkspaceResetResult extends NotesHistoryResetResult {
  workspace: NotesWorkspace;
}

export type NoteTagPrefix = "#" | "@";

export interface NoteTagFilter {
  prefix: NoteTagPrefix;
  normalizedTag: string;
}

export interface NoteTagSummary extends NoteTagFilter {
  displayTag: string;
  count: number;
}

export interface NoteSearchTag extends NoteTagFilter {
  displayTag: string;
}

export interface NoteStructuredSearchQuery {
  text: string;
  requiredTags: NoteSearchTag[];
  excludedTags: NoteSearchTag[];
  orGroups: NoteSearchTag[][];
}

export type NotesWorkspaceScope =
  | { kind: "active" }
  | { kind: "starred" }
  | { kind: "recent" }
  | { kind: "tag"; tag: string }
  | { kind: "tags"; tags: NoteTagFilter[] }
  | { kind: "archive" }
  | { kind: "trash" };

export type NoteSearchScope =
  | { kind: "active" }
  | { kind: "archive" }
  | { kind: "trash" };

export interface NoteSearchResult {
  nodeId: NoteId;
  nodeKind: NoteNodeKind;
  title: string;
  imageOffsetUtf16: number;
  attachmentName: string | null;
  displayLabel: string;
  parentTrail: string[];
  parentTrailKinds: NoteNodeKind[];
  matchedField: "title" | "note" | "attachment" | "date";
}

/**
 * Machine-readable error classification mirrored from the Rust `NotesErrorCode`
 * enum (`src-tauri/src/notes/error.rs`). Every `notes_*` command rejects with a
 * serialized `{ code, message }` object; the frontend branches on `code` rather
 * than matching human-facing message text.
 */
export type NotesErrorCode =
  | "vaultBusy"
  | "unsupportedSchemaVersion"
  | "destinationExists"
  | "foreignExportAssetDir"
  | "readonlyConfirmationStale"
  | "internal";

const NOTES_ERROR_CODES: ReadonlySet<NotesErrorCode> = new Set<NotesErrorCode>([
  "vaultBusy",
  "unsupportedSchemaVersion",
  "destinationExists",
  "foreignExportAssetDir",
  "readonlyConfirmationStale",
  "internal"
]);

/**
 * Codes that will never succeed on a bare retry of the identical request, so a
 * derived {@link NotesStoreError.retryable} must be `false` for them. Everything
 * else (transport failures, `vaultBusy`, unclassified `internal`) is retryable.
 */
const NON_RETRYABLE_NOTES_ERROR_CODES: ReadonlySet<NotesErrorCode> =
  new Set<NotesErrorCode>([
    "destinationExists",
    "foreignExportAssetDir",
    "readonlyConfirmationStale",
    "unsupportedSchemaVersion"
  ]);

export interface NotesStructuredError {
  code: NotesErrorCode;
  message: string;
}

/**
 * Parses a rejected IPC cause into a structured `{ code, message }`. A cause
 * that carries a recognized `code` (the backend's `NotesError`) keeps it;
 * anything else — a transport `Error`, a legacy string, a malformed payload —
 * is classified as `internal` with its text preserved as the message.
 */
export function parseNotesError(cause: unknown): NotesStructuredError {
  if (typeof cause === "object" && cause !== null && !Array.isArray(cause)) {
    const record = cause as Record<string, unknown>;
    const message =
      typeof record.message === "string" ? record.message : undefined;
    if (message !== undefined) {
      const code =
        typeof record.code === "string" &&
        NOTES_ERROR_CODES.has(record.code as NotesErrorCode)
          ? (record.code as NotesErrorCode)
          : "internal";
      return { code, message };
    }
  }
  if (typeof cause === "string") {
    return { code: "internal", message: cause };
  }
  return { code: "internal", message: "Notes request failed." };
}

export function isRetryableNotesErrorCode(code: NotesErrorCode): boolean {
  return !NON_RETRYABLE_NOTES_ERROR_CODES.has(code);
}

/** True only when `cause` is a structured backend error carrying `code`. */
export function notesErrorHasCode(
  cause: unknown,
  code: NotesErrorCode
): boolean {
  if (typeof cause !== "object" || cause === null || Array.isArray(cause)) {
    return false;
  }
  return (cause as Record<string, unknown>).code === code;
}

export interface NotesStoreError extends Error {
  operation: "load" | "write" | "search" | "deleteData";
  code: NotesErrorCode;
  retryable: boolean;
}

export function isNotesMutationOutcomeUnknown(
  cause: unknown
): cause is Error & {
  readonly notesMutationOutcome: "unknown";
  readonly mutationCommitted?: unknown;
} {
  return (
    cause instanceof Error &&
    "notesMutationOutcome" in cause &&
    cause.notesMutationOutcome === "unknown"
  );
}

export interface CreateNoteNodeInput {
  id: NoteId;
  parentId: NoteId | null;
  afterId: NoteId | null;
  beforeId?: NoteId | null;
  title: string;
  note: string;
  markerKind: NoteMarkerKind;
}

export interface UpdateNoteNodeInput {
  id: NoteId;
  title: string;
  note: string;
  imageOffsetUtf16: number;
  markdownImageWidth?: number | null;
  markerKind: NoteMarkerKind;
}

export interface MoveNoteNodeInput {
  id: NoteId;
  parentId: NoteId | null;
  afterId: NoteId | null;
  beforeId?: NoteId | null;
}

export interface SplitNoteNodeInput {
  id: NoteId;
  newNodeId: NoteId;
  prefix: string;
  suffix: string;
}

export interface ImportNoteAttachmentInput {
  id: string;
  nodeId: NoteId;
  sourcePath: string;
  initialMaxDisplayWidth: number;
}

export interface ImportNoteAttachmentPathBatchInput {
  readonly nodeId: NoteId;
  readonly attachments: readonly {
    readonly id: string;
    readonly sourcePath: string;
  }[];
  readonly initialMaxDisplayWidth: number;
}

export interface ImportNoteAttachmentByteItem {
  readonly id: string;
  readonly originalName: string;
  readonly mimeType: string;
  readonly blob: Blob;
}

export type PendingNoteAttachmentByteItem = Omit<
  ImportNoteAttachmentByteItem,
  "id"
>;

export interface ImportNoteAttachmentBytesBatchInput {
  readonly nodeId: NoteId;
  readonly attachments: readonly ImportNoteAttachmentByteItem[];
  readonly initialMaxDisplayWidth: number;
}

export interface ImportImageNodePathItem {
  readonly nodeId: NoteId;
  readonly attachmentId: string;
  readonly sourcePath: string;
}

export interface ImportImageNodePathsInput {
  readonly parentId: NoteId | null;
  readonly afterId: NoteId | null;
  readonly items: readonly ImportImageNodePathItem[];
  readonly initialMaxDisplayWidth: number;
}

export interface ImportImageNodeByteItem {
  readonly nodeId: NoteId;
  readonly attachmentId: string;
  readonly originalName: string;
  readonly mimeType: string;
  readonly blob: Blob;
}

export type PendingImageNodeByteItem = Omit<
  ImportImageNodeByteItem,
  "nodeId" | "attachmentId"
>;

export interface ImportImageNodeBytesInput {
  readonly parentId: NoteId | null;
  readonly afterId: NoteId | null;
  readonly items: readonly ImportImageNodeByteItem[];
  readonly initialMaxDisplayWidth: number;
}

export interface ResizeNoteAttachmentInput {
  id: string;
  displayWidth: number;
}

/**
 * Transport shape for `notes_apply_batch` (plan Phase 4.1): one structural
 * operation applied to a whole set of nodes in a single transaction / single
 * history entry. This is the internally-tagged wire form the Rust
 * `ApplyBatchInput` deserializes — the op-specific fields sit at the top level
 * alongside `op` and `nodeIds`. `nodeIds` is expected in outline order so the
 * backend can place a moved block contiguously.
 */
export interface NotesBackspaceTitleUpdate {
  readonly id: NoteId;
  readonly title: string;
}

export interface ApplyNotesBackspaceGestureInput {
  readonly op: "backspaceGesture";
  readonly nodeIds: readonly NoteId[];
  readonly titleUpdate: NotesBackspaceTitleUpdate | null;
}

export type ApplyNotesBatchInput =
  | { op: "complete"; nodeIds: readonly NoteId[]; completed: boolean }
  | { op: "delete"; nodeIds: readonly NoteId[] }
  | {
      op: "move";
      nodeIds: readonly NoteId[];
      parentId: NoteId | null;
      afterId: NoteId | null;
      /** Optional before-anchor; mutually exclusive with a non-null afterId. */
      beforeId?: NoteId | null;
    }
  | { op: "indent"; nodeIds: readonly NoteId[] }
  | { op: "outdent"; nodeIds: readonly NoteId[] }
  | { op: "duplicate"; nodeIds: readonly NoteId[] }
  | {
      op: "addTag";
      nodeIds: readonly NoteId[];
      tag: NoteSearchTag;
    }
  | {
      op: "removeTag";
      nodeIds: readonly NoteId[];
      tag: NoteTagFilter;
    }
  | ApplyNotesBackspaceGestureInput;

/**
 * One node in a `notes_import_subtree` payload (plan Phase 4.4, paste
 * import). Mirrors the Rust `ImportNode` (src-tauri/src/notes/types.rs): ids
 * are never supplied by the client — the backend generates them so the store
 * stays authoritative — only content + nesting is carried here.
 */
export interface NoteImportNode {
  title: string;
  note?: string;
  markerKind?: NoteMarkerKind;
  children: readonly NoteImportNode[];
}

/**
 * Input to `notes_import_subtree`: a forest of new nodes inserted as one
 * contiguous block under `parentId`, right after `afterId`. One backend
 * transaction / one history entry, so undo removes every imported node in a
 * single step.
 */
export interface ImportSubtreeInput {
  parentId: NoteId | null;
  afterId: NoteId | null;
  nodes: readonly NoteImportNode[];
}

/** Input to `notes_import_markdown`. */
export interface ImportNotesMarkdownInput {
  sourcePath: string;
  parentId: NoteId | null;
  afterId: NoteId | null;
}

export interface GithubNotificationSnapshotInput {
  dateKey: string;
  notificationKey: string;
  title: string;
  note: string;
  notificationType: string;
  url: string;
  updatedAt: string;
  unread: boolean;
}

export type MaterializeGithubNotificationTarget =
  | { kind: "sibling"; siblingId: NoteId }
  | { kind: "children"; nodes: readonly NoteImportNode[] };

export type MaterializeGithubNotificationIntent =
  | { kind: "sibling" }
  | { kind: "children"; nodes: readonly NoteImportNode[] }
  | { kind: "reparent"; nodeId: NoteId };

export interface MaterializeGithubNotificationInput {
  rootId: NoteId;
  snapshot: GithubNotificationSnapshotInput;
  target: MaterializeGithubNotificationTarget;
}

export interface MaterializeGithubNotificationReparentInput {
  rootId: NoteId;
  nodeId: NoteId;
  snapshot: GithubNotificationSnapshotInput;
}

export interface NotesStore {
  initialize(
    vaultPath: string,
    input: NotesInitializeInput
  ): Promise<NotesHistoryState>;
  loadWorkspace(
    vaultPath: string,
    scope: NotesWorkspaceScope
  ): Promise<NotesWorkspace>;
  createNode(
    vaultPath: string,
    input: CreateNoteNodeInput,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  updateNode(
    vaultPath: string,
    input: UpdateNoteNodeInput,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  setReadonly(
    vaultPath: string,
    input: SetReadonlyNoteInput,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  materializeGithubNotificationAndCreateSibling(
    vaultPath: string,
    input: MaterializeGithubNotificationInput,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  materializeGithubNotificationAndReparent(
    vaultPath: string,
    input: MaterializeGithubNotificationReparentInput,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  refreshMaterializedGithubNotifications(
    vaultPath: string,
    input: Readonly<{
      rootId: NoteId;
      notifications: readonly GithubNotificationSnapshotInput[];
    }>
  ): Promise<NotesWorkspace>;
  setGithubGroupCollapsed(
    vaultPath: string,
    input: Readonly<{ rootId: NoteId; groupKey: string; collapsed: boolean }>,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  markMaterializedGithubNotificationRead(
    vaultPath: string,
    input: Readonly<{
      rootId: NoteId;
      notificationKey: string;
      updatedAt: string;
    }>
  ): Promise<NotesWorkspace>;
  deleteNodes(
    vaultPath: string,
    input: DeleteNotesInput,
    historyContext: NotesHistoryContext
  ): Promise<DeleteNotesResponse>;
  splitNode(
    vaultPath: string,
    input: SplitNoteNodeInput,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  applyImageAtomEdit(
    vaultPath: string,
    input: ApplyImageAtomEditInput,
    historyContext: NotesHistoryContext
  ): Promise<ImageAtomMutationResult>;
  applyImageAtomPaste(
    vaultPath: string,
    input: ApplyImageAtomPasteInput,
    historyContext: NotesHistoryContext
  ): Promise<ImageAtomMutationResult>;
  moveNode(
    vaultPath: string,
    input: MoveNoteNodeInput,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  // Structural batch (plan Phase 4.1): one operation applied to a whole node set
  // as a single transaction / single history entry (one undo step).
  applyBatch(
    vaultPath: string,
    input: ApplyNotesBatchInput,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  // Paste import (plan Phase 4.4): insert a caller-supplied forest of new
  // nodes as one contiguous block, one transaction / one history entry.
  importSubtree(
    vaultPath: string,
    input: ImportSubtreeInput,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  importMarkdown(
    vaultPath: string,
    input: ImportNotesMarkdownInput,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResult>;
  toggleComplete(
    vaultPath: string,
    nodeId: NoteId,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  toggleCollapsed(
    vaultPath: string,
    nodeId: NoteId,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  expandAll?(
    vaultPath: string,
    nodeId: NoteId,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResult>;
  collapseAll?(
    vaultPath: string,
    nodeId: NoteId,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResult>;
  sortSubtreeAscending?(
    vaultPath: string,
    nodeId: NoteId,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResult>;
  sortSubtreeDescending?(
    vaultPath: string,
    nodeId: NoteId,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResult>;
  toggleStar(
    vaultPath: string,
    nodeId: NoteId,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  duplicateNode(
    vaultPath: string,
    nodeId: NoteId,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  removeEmptyNode(
    vaultPath: string,
    nodeId: NoteId,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  softDeleteNode(
    vaultPath: string,
    nodeId: NoteId,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  restoreNode(
    vaultPath: string,
    nodeId: NoteId,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  archiveNode(
    vaultPath: string,
    nodeId: NoteId,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  unarchiveNode(
    vaultPath: string,
    nodeId: NoteId,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  undo(
    vaultPath: string,
    input: NotesHistoryReplayInput
  ): Promise<NotesHistoryReplayOutcome>;
  redo(
    vaultPath: string,
    input: NotesHistoryReplayInput
  ): Promise<NotesHistoryReplayOutcome>;
  historyStatus?(
    vaultPath: string,
    sessionId: string
  ): Promise<NotesHistoryStatus>;
  lookupImageAtomOperation(
    vaultPath: string,
    sessionId: string,
    historyEpoch: string,
    operationId: string
  ): Promise<ImageAtomOperationLookup>;
  ackImageAtomOperation(
    vaultPath: string,
    sessionId: string,
    historyEpoch: string,
    operationId: string
  ): Promise<void>;
  clearHistory(
    vaultPath: string,
    input: NotesHistoryResetInput
  ): Promise<NotesHistoryResetResult>;
  pruneHistoryEntries(
    vaultPath: string,
    input: NotesPruneHistoryInput
  ): Promise<NotesHistoryState>;
  prepareNavigation(
    vaultPath: string,
    input: NotesPrepareNavigationInput
  ): Promise<NotesHistoryState>;
  closeHistorySession(
    vaultPath: string,
    input: NotesHistoryCloseInput
  ): Promise<void>;
  importAttachment?(
    vaultPath: string,
    input: ImportNoteAttachmentInput,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  importAttachmentPaths(
    vaultPath: string,
    input: ImportNoteAttachmentPathBatchInput,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  importAttachmentBytes(
    vaultPath: string,
    input: ImportNoteAttachmentBytesBatchInput,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  importImageNodePaths?(
    vaultPath: string,
    input: ImportImageNodePathsInput,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  importImageNodeBytes?(
    vaultPath: string,
    input: ImportImageNodeBytesInput,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  openAttachmentOriginal?(
    vaultPath: string,
    attachmentId: string
  ): Promise<void>;
  downloadAttachment?(
    vaultPath: string,
    attachmentId: string
  ): Promise<void>;
  readAttachmentBytes?(
    vaultPath: string,
    attachmentId: string
  ): Promise<Uint8Array>;
  resizeAttachment?(
    vaultPath: string,
    input: ResizeNoteAttachmentInput,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  removeAttachment?(
    vaultPath: string,
    attachmentId: string,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  restoreAttachment?(
    vaultPath: string,
    attachmentId: string,
    historyContext: NotesHistoryContext
  ): Promise<NotesMutationResponse>;
  emptyTrash(
    vaultPath: string,
    input: NotesHistoryResetInput
  ): Promise<NotesWorkspaceResetResult>;
  search(
    vaultPath: string,
    query: string,
    scope?: NoteSearchScope
  ): Promise<NoteSearchResult[]>;
  searchStructured?(
    vaultPath: string,
    query: NoteStructuredSearchQuery
  ): Promise<NoteSearchResult[]>;
  listTags(vaultPath: string): Promise<string[]>;
  listTagsWithCounts(vaultPath: string): Promise<NoteTagSummary[]>;
  deleteDatabase(vaultPath: string): Promise<NotesDeleteDatabaseResult>;
}

export interface NotesDeleteDatabaseResult {
  /**
   * True when the database was removed but one or more attachment files could
   * not be deleted from disk. The deletion still succeeded; this only signals
   * that some orphaned files were left behind.
   */
  attachmentCleanupFailed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isUtf16ScalarBoundary(text: string, offset: unknown): offset is number {
  if (
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > text.length
  ) {
    return false;
  }
  if (offset === 0 || offset === text.length) {
    return true;
  }
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(
    before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function hasExactOwnKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every(
      (key) => typeof key === "string" && expected.includes(key)
    )
  );
}

function hasOwnKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  return expected.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key)
  );
}

function isDenseArray(value: unknown): value is unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === value.length &&
    keys.every((key, index) => key === String(index))
  );
}

function isCanonicalUuidV4(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value
    )
  );
}

function isExactNoteIdArray(value: unknown): value is NoteId[] {
  return (
    isDenseArray(value) &&
    value.every(isCanonicalUuidV4) &&
    new Set(value).size === value.length
  );
}

export function isDeleteReadonlyPreflight(
  value: unknown
): value is DeleteReadonlyPreflight {
  return (
    isRecord(value) &&
    hasExactOwnKeys(value, ["readonlyDescendantIds"]) &&
    isExactNoteIdArray(value.readonlyDescendantIds)
  );
}

export function isConfirmReadonlyDescendants(
  value: unknown
): value is ConfirmReadonlyDescendants {
  return (
    isRecord(value) &&
    hasExactOwnKeys(value, ["expectedReadonlyDescendantIds"]) &&
    isExactNoteIdArray(value.expectedReadonlyDescendantIds)
  );
}

export function isImportNotesMarkdownInput(
  value: unknown
): value is ImportNotesMarkdownInput {
  return (
    isRecord(value) &&
    hasExactOwnKeys(value, ["sourcePath", "parentId", "afterId"]) &&
    typeof value.sourcePath === "string" &&
    value.sourcePath.trim().length > 0 &&
    (value.parentId === null || isCanonicalUuidV4(value.parentId)) &&
    (value.afterId === null || isCanonicalUuidV4(value.afterId))
  );
}

const ATTACHMENT_KEYS = [
  "id",
  "nodeId",
  "sortKey",
  "relativePath",
  "contentHash",
  "originalName",
  "mimeType",
  "byteSize",
  "intrinsicWidth",
  "intrinsicHeight",
  "displayWidth",
  "createdAt",
  "updatedAt"
] as const;

const ATTACHMENT_EXTENSION_BY_MIME = new Map<
  NoteAttachment["mimeType"],
  string
>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"]
]);

export function isNoteAttachment(value: unknown): value is NoteAttachment {
  if (!isRecord(value) || !hasExactKeys(value, ATTACHMENT_KEYS)) {
    return false;
  }
  if (
    !isCanonicalUuidV4(value.id) ||
    !isCanonicalUuidV4(value.nodeId) ||
    !Number.isSafeInteger(value.sortKey) ||
    (value.sortKey as number) <= 0 ||
    typeof value.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.contentHash) ||
    typeof value.originalName !== "string" ||
    value.originalName.trim().length === 0 ||
    new TextEncoder().encode(value.originalName).byteLength > 1024 ||
    typeof value.mimeType !== "string" ||
    !Number.isSafeInteger(value.byteSize) ||
    (value.byteSize as number) <= 0 ||
    (value.byteSize as number) > MAX_NOTE_ATTACHMENT_BYTES ||
    !Number.isSafeInteger(value.intrinsicWidth) ||
    (value.intrinsicWidth as number) <= 0 ||
    !Number.isSafeInteger(value.intrinsicHeight) ||
    (value.intrinsicHeight as number) <= 0 ||
    (value.intrinsicWidth as number) * (value.intrinsicHeight as number) >
      MAX_NOTE_ATTACHMENT_PIXELS ||
    !Number.isSafeInteger(value.displayWidth) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return false;
  }

  const extension = ATTACHMENT_EXTENSION_BY_MIME.get(
    value.mimeType as NoteAttachment["mimeType"]
  );
  if (extension === undefined) {
    return false;
  }

  const intrinsicWidth = value.intrinsicWidth as number;
  const displayWidth = value.displayWidth as number;
  if (displayWidth <= 0 || displayWidth > intrinsicWidth) {
    return false;
  }

  return (
    value.relativePath ===
    `notes-assets/${value.contentHash}.${extension}`
  );
}

const NOTE_NODE_KEYS = [
  "id",
  "nodeKind",
  "markerKind",
  "parentId",
  "sortKey",
  "title",
  "note",
  "imageOffsetUtf16",
  "markdownImageWidth",
  "layoutMode",
  "isCollapsed",
  "isStarred",
  "completedAt",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "archivedAt",
  "archiveRootId",
  "isReadonly",
  "pluginState",
  "pluginMeta"
] as const;

const NOTE_NODE_REQUIRED_KEYS = NOTE_NODE_KEYS.slice(0, -3);

const FORBIDDEN_ATTACHMENT_MAP_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype"
]);

export function isNoteNode(value: unknown): value is NoteNode {
  if (
    !isRecord(value) ||
    !hasOwnKeys(value, NOTE_NODE_REQUIRED_KEYS) ||
    !Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && NOTE_NODE_KEYS.includes(key as never)
    )
  ) {
    return false;
  }
  const isReadonly =
    value.isReadonly === undefined || typeof value.isReadonly === "boolean";
  const hasPluginState = value.pluginState !== undefined;
  const hasPluginMeta = value.pluginMeta !== undefined;
  return (
    typeof value.id === "string" &&
    (value.nodeKind === "text" || value.nodeKind === "image") &&
    (value.markerKind === "bullet" || value.markerKind === "todo") &&
    isNullableString(value.parentId) &&
    Number.isSafeInteger(value.sortKey) &&
    typeof value.title === "string" &&
    typeof value.note === "string" &&
    isUtf16ScalarBoundary(value.title, value.imageOffsetUtf16) &&
    (value.nodeKind === "image" || value.imageOffsetUtf16 === 0) &&
    (value.markdownImageWidth === null ||
      (Number.isSafeInteger(value.markdownImageWidth) &&
        (value.markdownImageWidth as number) > 0 &&
        (value.markdownImageWidth as number) <=
          MAX_NOTE_MARKDOWN_IMAGE_DISPLAY_WIDTH)) &&
    value.layoutMode === "bullets" &&
    typeof value.isCollapsed === "boolean" &&
    typeof value.isStarred === "boolean" &&
    isNullableString(value.completedAt) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    isNullableString(value.deletedAt) &&
    isNullableString(value.archivedAt) &&
    isNullableString(value.archiveRootId) &&
    isReadonly &&
    (!hasPluginState ||
      isGithubNotificationsPluginState(value.pluginState)) &&
    (!hasPluginMeta || isGithubNotificationsPluginMeta(value.pluginMeta)) &&
    !(value.isReadonly !== undefined && (hasPluginState || hasPluginMeta)) &&
    !(hasPluginState && hasPluginMeta)
  );
}

export function normalizeNotesWorkspace(
  value: unknown
): NormalizedNotesWorkspace | null {
  if (!isRecord(value)) {
    return null;
  }
  const hasAttachmentMap = Object.prototype.hasOwnProperty.call(
    value,
    "attachmentsByNodeId"
  );
  if (
    (("nodes" in value &&
      !Object.prototype.hasOwnProperty.call(value, "nodes")) ||
      ("attachmentsByNodeId" in value && !hasAttachmentMap)) ||
    !hasExactKeys(
      value,
      hasAttachmentMap ? ["nodes", "attachmentsByNodeId"] : ["nodes"]
    ) ||
    !isDenseArray(value.nodes) ||
    !value.nodes.every(isNoteNode)
  ) {
    return null;
  }

  if (!hasAttachmentMap) {
    return { nodes: value.nodes, attachmentsByNodeId: {} };
  }
  if (!isRecord(value.attachmentsByNodeId)) {
    return null;
  }

  const attachmentsByNodeId: NoteAttachmentsByNodeId = {};
  const attachmentIds = new Set<string>();
  const nodeIds = new Set(value.nodes.map((node) => node.id));
  let attachmentCount = 0;
  for (const [nodeId, attachments] of Object.entries(
    value.attachmentsByNodeId
  )) {
    if (
      FORBIDDEN_ATTACHMENT_MAP_KEYS.has(nodeId) ||
      !isCanonicalUuidV4(nodeId) ||
      !nodeIds.has(nodeId) ||
      !isDenseArray(attachments) ||
      attachments.length > MAX_NOTE_ATTACHMENTS_PER_NODE
    ) {
      return null;
    }
    attachmentCount += attachments.length;
    if (attachmentCount > MAX_NOTE_ATTACHMENTS_PER_WORKSPACE) {
      return null;
    }
    let previous: NoteAttachment | null = null;
    const normalizedAttachments: NoteAttachment[] = [];
    for (const attachment of attachments) {
      if (
        !isNoteAttachment(attachment) ||
        attachment.nodeId !== nodeId ||
        attachmentIds.has(attachment.id) ||
        (previous !== null &&
          (attachment.sortKey < previous.sortKey ||
            (attachment.sortKey === previous.sortKey &&
              attachment.id <= previous.id)))
      ) {
        return null;
      }
      attachmentIds.add(attachment.id);
      normalizedAttachments.push(attachment);
      previous = attachment;
    }
    attachmentsByNodeId[nodeId] = normalizedAttachments;
  }

  return { nodes: value.nodes, attachmentsByNodeId };
}

export function isNotesWorkspace(value: unknown): value is NotesWorkspace {
  return normalizeNotesWorkspace(value) !== null;
}

const NOTES_HISTORY_STATE_KEYS = [
  "canUndo",
  "canRedo",
  "historyEpoch",
  "nextUndoEntryId",
  "nextRedoEntryId",
  "prunedEntryIds"
] as const;

function hasNotesHistoryState(value: Record<string, unknown>): boolean {
  return (
    NOTES_HISTORY_STATE_KEYS.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key)
    ) &&
    typeof value.canUndo === "boolean" &&
    typeof value.canRedo === "boolean" &&
    typeof value.historyEpoch === "string" &&
    isNullableString(value.nextUndoEntryId) &&
    isNullableString(value.nextRedoEntryId) &&
    isDenseArray(value.prunedEntryIds) &&
    value.prunedEntryIds.every((entryId) => typeof entryId === "string")
  );
}

export function isNotesHistoryState(value: unknown): value is NotesHistoryState {
  return (
    isRecord(value) &&
    hasExactKeys(value, NOTES_HISTORY_STATE_KEYS) &&
    hasNotesHistoryState(value)
  );
}

function isImageAtomHistoryEpoch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    new TextEncoder().encode(value).byteLength <= 128
  );
}

function isLowercaseSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isImageAtomFocusResult(value: unknown): value is ImageAtomFocusResult {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["nodeId", "anchorUtf16", "focusUtf16"]) &&
    isCanonicalUuidV4(value.nodeId) &&
    Number.isSafeInteger(value.anchorUtf16) &&
    (value.anchorUtf16 as number) >= 0 &&
    Number.isSafeInteger(value.focusUtf16) &&
    (value.focusUtf16 as number) >= 0
  );
}

export function isImageAtomOperationReceiptResult(
  value: unknown
): value is ImageAtomOperationReceiptResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "operationId",
      "historyEpoch",
      "postconditionDigest",
      "affectedRootIds",
      "focus"
    ]) ||
    !isCanonicalUuidV4(value.operationId) ||
    !isImageAtomHistoryEpoch(value.historyEpoch) ||
    !isLowercaseSha256(value.postconditionDigest) ||
    !isDenseArray(value.affectedRootIds) ||
    value.affectedRootIds.length === 0 ||
    value.affectedRootIds.length > MAX_NOTE_IMAGE_NODE_IMPORT_BATCH_ITEMS ||
    !value.affectedRootIds.every(isCanonicalUuidV4) ||
    !isImageAtomFocusResult(value.focus)
  ) {
    return false;
  }
  return new Set(value.affectedRootIds).size === value.affectedRootIds.length;
}

export function isImageAtomOperationLookup(
  value: unknown
): value is ImageAtomOperationLookup {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "found") {
    return (
      hasExactKeys(value, ["kind", "receipt"]) &&
      isImageAtomOperationReceiptResult(value.receipt)
    );
  }
  return (
    (value.kind === "missing" || value.kind === "epochMismatch") &&
    hasExactKeys(value, ["kind", "historyEpoch"]) &&
    isImageAtomHistoryEpoch(value.historyEpoch)
  );
}

export function isImageAtomMutationResult(
  value: unknown
): value is ImageAtomMutationResult {
  if (!isRecord(value) || !isImageAtomOperationReceiptResult(value.operation)) {
    return false;
  }
  const { operation, ...mutation } = value;
  return (
    operation !== undefined &&
    isNotesMutationResult(mutation) &&
    mutation.historyEntryId === operation.operationId &&
    mutation.historyEpoch === operation.historyEpoch
  );
}

const NOTES_MUTATION_RESULT_REQUIRED_KEYS = [
  "historyEntryId",
  ...NOTES_HISTORY_STATE_KEYS
] as const;

const NOTES_MUTATION_RESULT_OPTIONAL_KEYS = [
  "workspace",
  "changedNodes",
  "removedNodeIds",
  "changedAttachments",
  "importedRootIds",
  "duplicatedRootIds"
] as const;

const NOTES_MUTATION_RESULT_ALLOWED_KEYS = new Set<string>([
  ...NOTES_MUTATION_RESULT_REQUIRED_KEYS,
  ...NOTES_MUTATION_RESULT_OPTIONAL_KEYS
]);

export function isNotesMutationResult(
  value: unknown
): value is NotesMutationResult {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  const hasWorkspace = Object.prototype.hasOwnProperty.call(value, "workspace");
  const hasCompleteDelta =
    Object.prototype.hasOwnProperty.call(value, "changedNodes") &&
    Object.prototype.hasOwnProperty.call(value, "removedNodeIds") &&
    Object.prototype.hasOwnProperty.call(value, "changedAttachments");
  if (
    !NOTES_MUTATION_RESULT_REQUIRED_KEYS.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key)
    ) ||
    !keys.every((key) => NOTES_MUTATION_RESULT_ALLOWED_KEYS.has(key)) ||
    (hasWorkspace
      ? !isNotesWorkspace(value.workspace)
      : !hasCompleteDelta) ||
    !isNullableString(value.historyEntryId) ||
    !hasNotesHistoryState(value)
  ) {
    return false;
  }
  // The delta fields are optional and additive: reject them only when present
  // with the wrong shape, so payloads that omit them keep validating.
  if (
    Object.prototype.hasOwnProperty.call(value, "changedNodes") &&
    !(isDenseArray(value.changedNodes) && value.changedNodes.every(isNoteNode))
  ) {
    return false;
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "removedNodeIds") &&
    !(
      isDenseArray(value.removedNodeIds) &&
      value.removedNodeIds.every((id) => typeof id === "string")
    )
  ) {
    return false;
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "changedAttachments") &&
    !(
      isDenseArray(value.changedAttachments) &&
      value.changedAttachments.every(isNoteAttachment)
    )
  ) {
    return false;
  }
  if (
    !hasWorkspace &&
    (value.changedNodes as unknown[]).length === 0 &&
    (value.removedNodeIds as unknown[]).length === 0 &&
    (value.changedAttachments as unknown[]).length === 0
  ) {
    return false;
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "importedRootIds") &&
    !(
      isDenseArray(value.importedRootIds) &&
      value.importedRootIds.every((id) => typeof id === "string")
    )
  ) {
    return false;
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "duplicatedRootIds") &&
    !(
      isDenseArray(value.duplicatedRootIds) &&
      value.duplicatedRootIds.every((id) => typeof id === "string")
    )
  ) {
    return false;
  }
  return true;
}

export function isNotesHistoryReplayOutcome(
  value: unknown
): value is NotesHistoryReplayOutcome {
  if (!isRecord(value) || !hasNotesHistoryState(value)) {
    return false;
  }
  if (value.kind === "applied") {
    return (
      hasExactKeys(value, [
        "kind",
        "workspace",
        "replayedEntryId",
        ...NOTES_HISTORY_STATE_KEYS
      ]) &&
      isNotesWorkspace(value.workspace) &&
      typeof value.replayedEntryId === "string"
    );
  }
  return (
    (value.kind === "epochMismatch" ||
      value.kind === "entryMissing" ||
      value.kind === "entryNotNext") &&
    hasExactKeys(value, ["kind", ...NOTES_HISTORY_STATE_KEYS])
  );
}

export function isNotesHistoryResetResult(
  value: unknown
): value is NotesHistoryResetResult {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["historyReset", ...NOTES_HISTORY_STATE_KEYS]) &&
    value.historyReset === true &&
    hasNotesHistoryState(value)
  );
}

export function isNotesWorkspaceResetResult(
  value: unknown
): value is NotesWorkspaceResetResult {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "workspace",
      "historyReset",
      ...NOTES_HISTORY_STATE_KEYS
    ]) &&
    isNotesWorkspace(value.workspace) &&
    value.historyReset === true &&
    hasNotesHistoryState(value)
  );
}

export function isNoteSearchResult(value: unknown): value is NoteSearchResult {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "nodeId",
      "nodeKind",
      "title",
      "imageOffsetUtf16",
      "attachmentName",
      "displayLabel",
      "parentTrail",
      "parentTrailKinds",
      "matchedField"
    ]) &&
    typeof value.nodeId === "string" &&
    (value.nodeKind === "text" || value.nodeKind === "image") &&
    typeof value.title === "string" &&
    isUtf16ScalarBoundary(value.title, value.imageOffsetUtf16) &&
    isNullableString(value.attachmentName) &&
    (value.nodeKind === "image" ||
      (value.imageOffsetUtf16 === 0 && value.attachmentName === null)) &&
    typeof value.displayLabel === "string" &&
    isDenseArray(value.parentTrail) &&
    value.parentTrail.every((item) => typeof item === "string") &&
    isDenseArray(value.parentTrailKinds) &&
    value.parentTrailKinds.length === value.parentTrail.length &&
    value.parentTrailKinds.every(
      (kind) => kind === "text" || kind === "image"
    ) &&
    (value.matchedField === "title" ||
      value.matchedField === "note" ||
      value.matchedField === "date" ||
      (value.matchedField === "attachment" &&
        value.nodeKind === "image" &&
        value.attachmentName !== null))
  );
}

function isNoteSearchTag(value: unknown): value is NoteSearchTag {
  return (
    isRecord(value) &&
    hasOwnKeys(value, ["prefix", "normalizedTag", "displayTag"]) &&
    (value.prefix === "#" || value.prefix === "@") &&
    typeof value.normalizedTag === "string" &&
    typeof value.displayTag === "string"
  );
}

export function isNoteStructuredSearchQuery(
  value: unknown
): value is NoteStructuredSearchQuery {
  return (
    isRecord(value) &&
    hasOwnKeys(value, ["text", "requiredTags", "excludedTags", "orGroups"]) &&
    typeof value.text === "string" &&
    isDenseArray(value.requiredTags) &&
    value.requiredTags.every(isNoteSearchTag) &&
    isDenseArray(value.excludedTags) &&
    value.excludedTags.every(isNoteSearchTag) &&
    isDenseArray(value.orGroups) &&
    value.orGroups.every(
      (group) => isDenseArray(group) && group.every(isNoteSearchTag)
    )
  );
}

export function createNoteId(): NoteId {
  if (
    typeof globalThis.crypto === "undefined" ||
    typeof globalThis.crypto.randomUUID !== "function"
  ) {
    throw new Error(
      "Notes ID creation requires crypto.randomUUID, which is unavailable in this runtime."
    );
  }

  return globalThis.crypto.randomUUID();
}
