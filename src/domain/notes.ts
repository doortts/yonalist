export type NoteId = string;
export type NoteLayoutMode = "bullets";

export const MAX_NOTE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_NOTE_ATTACHMENT_BATCH_BYTES = 64 * 1024 * 1024;
export const MAX_NOTE_ATTACHMENT_BATCH_METADATA_BYTES = 256 * 1024;
export const MAX_NOTE_ATTACHMENT_PIXELS = 40_000_000;
export const MIN_NOTE_ATTACHMENT_DISPLAY_WIDTH = 160;
export const MAX_NOTE_ATTACHMENTS_PER_NODE = 128;
export const MAX_NOTE_ATTACHMENTS_PER_WORKSPACE = 512;

export interface NoteNode {
  id: NoteId;
  parentId: NoteId | null;
  sortKey: number;
  title: string;
  note: string;
  layoutMode: NoteLayoutMode;
  isCollapsed: boolean;
  isStarred: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  archivedAt: string | null;
  archiveRootId: NoteId | null;
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

export type NormalizedNotesWorkspace = NotesWorkspace & {
  attachmentsByNodeId: NoteAttachmentsByNodeId;
};

export interface NotesHistoryContext {
  sessionId: string;
  entryId: string;
  commandKind: string;
}

export interface NotesHistoryStatus {
  canUndo: boolean;
  canRedo: boolean;
}

export interface NotesMutationResult extends NotesHistoryStatus {
  workspace: NotesWorkspace;
  historyEntryId: string | null;
}

export type NotesMutationResponse = NotesWorkspace | NotesMutationResult;

export interface NotesHistoryReplayResult extends NotesHistoryStatus {
  workspace: NotesWorkspace;
  replayedEntryId: string | null;
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
  title: string;
  parentTrail: string[];
  matchedField: "title" | "note" | "date";
}

export interface NotesStoreError extends Error {
  operation: "load" | "write" | "search" | "deleteData";
  retryable: boolean;
}

export interface CreateNoteNodeInput {
  id: NoteId;
  parentId: NoteId | null;
  afterId: NoteId | null;
  title: string;
  note: string;
}

export interface UpdateNoteNodeInput {
  id: NoteId;
  title: string;
  note: string;
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

export interface ResizeNoteAttachmentInput {
  id: string;
  displayWidth: number;
}

export interface NotesStore {
  initialize(vaultPath: string): Promise<void>;
  loadWorkspace(vaultPath: string, scope: NotesWorkspaceScope): Promise<NotesWorkspace>;
  createNode(vaultPath: string, input: CreateNoteNodeInput, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResponse>;
  updateNode(vaultPath: string, input: UpdateNoteNodeInput, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResponse>;
  splitNode(vaultPath: string, input: SplitNoteNodeInput, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResponse>;
  moveNode(vaultPath: string, input: MoveNoteNodeInput, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResponse>;
  toggleComplete(vaultPath: string, nodeId: NoteId, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResponse>;
  toggleCollapsed(vaultPath: string, nodeId: NoteId, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResponse>;
  expandAll?(vaultPath: string, nodeId: NoteId, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResult>;
  collapseAll?(vaultPath: string, nodeId: NoteId, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResult>;
  sortSubtreeAscending?(vaultPath: string, nodeId: NoteId, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResult>;
  sortSubtreeDescending?(vaultPath: string, nodeId: NoteId, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResult>;
  toggleStar(vaultPath: string, nodeId: NoteId, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResponse>;
  duplicateNode(vaultPath: string, nodeId: NoteId, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResponse>;
  removeEmptyNode(vaultPath: string, nodeId: NoteId, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResponse>;
  softDeleteNode(vaultPath: string, nodeId: NoteId, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResponse>;
  restoreNode(vaultPath: string, nodeId: NoteId, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResponse>;
  archiveNode(vaultPath: string, nodeId: NoteId, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResponse>;
  unarchiveNode(vaultPath: string, nodeId: NoteId, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResponse>;
  undo?(vaultPath: string, sessionId: string, scope: NotesWorkspaceScope): Promise<NotesHistoryReplayResult>;
  redo?(vaultPath: string, sessionId: string, scope: NotesWorkspaceScope): Promise<NotesHistoryReplayResult>;
  historyStatus?(vaultPath: string, sessionId: string): Promise<NotesHistoryStatus>;
  clearHistory?(vaultPath: string, sessionId: string): Promise<NotesHistoryStatus>;
  importAttachment?(
    vaultPath: string,
    input: ImportNoteAttachmentInput,
    historyContext?: NotesHistoryContext | null
  ): Promise<NotesMutationResponse>;
  importAttachmentPaths?(
    vaultPath: string,
    input: ImportNoteAttachmentPathBatchInput,
    historyContext?: NotesHistoryContext | null
  ): Promise<NotesMutationResponse>;
  importAttachmentBytes?(
    vaultPath: string,
    input: ImportNoteAttachmentBytesBatchInput,
    historyContext?: NotesHistoryContext | null
  ): Promise<NotesMutationResponse>;
  readAttachmentBytes?(
    vaultPath: string,
    attachmentId: string
  ): Promise<Uint8Array>;
  resizeAttachment?(
    vaultPath: string,
    input: ResizeNoteAttachmentInput,
    historyContext?: NotesHistoryContext | null
  ): Promise<NotesMutationResponse>;
  removeAttachment?(
    vaultPath: string,
    attachmentId: string,
    historyContext?: NotesHistoryContext | null
  ): Promise<NotesMutationResponse>;
  restoreAttachment?(
    vaultPath: string,
    attachmentId: string,
    historyContext?: NotesHistoryContext | null
  ): Promise<NotesMutationResponse>;
  emptyTrash(vaultPath: string): Promise<NotesWorkspace>;
  search(vaultPath: string, query: string, scope?: NoteSearchScope): Promise<NoteSearchResult[]>;
  searchStructured?(vaultPath: string, query: NoteStructuredSearchQuery): Promise<NoteSearchResult[]>;
  listTags(vaultPath: string): Promise<string[]>;
  listTagsWithCounts(vaultPath: string): Promise<NoteTagSummary[]>;
  deleteDatabase(vaultPath: string): Promise<void>;
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
  "parentId",
  "sortKey",
  "title",
  "note",
  "layoutMode",
  "isCollapsed",
  "isStarred",
  "completedAt",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "archivedAt",
  "archiveRootId"
] as const;

const FORBIDDEN_ATTACHMENT_MAP_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype"
]);

export function isNoteNode(value: unknown): value is NoteNode {
  return (
    isRecord(value) &&
    hasOwnKeys(value, NOTE_NODE_KEYS) &&
    typeof value.id === "string" &&
    isNullableString(value.parentId) &&
    Number.isSafeInteger(value.sortKey) &&
    typeof value.title === "string" &&
    typeof value.note === "string" &&
    value.layoutMode === "bullets" &&
    typeof value.isCollapsed === "boolean" &&
    typeof value.isStarred === "boolean" &&
    isNullableString(value.completedAt) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    isNullableString(value.deletedAt) &&
    isNullableString(value.archivedAt) &&
    isNullableString(value.archiveRootId)
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

export function isNotesMutationResult(value: unknown): value is NotesMutationResult {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === 4 &&
    keys.every((key) =>
      ["workspace", "historyEntryId", "canUndo", "canRedo"].includes(key)
    ) &&
    isNotesWorkspace(value.workspace) &&
    isNullableString(value.historyEntryId) &&
    typeof value.canUndo === "boolean" &&
    typeof value.canRedo === "boolean"
  );
}

export function isNotesHistoryReplayResult(
  value: unknown
): value is NotesHistoryReplayResult {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "workspace",
      "replayedEntryId",
      "canUndo",
      "canRedo"
    ]) &&
    isNotesWorkspace(value.workspace) &&
    isNullableString(value.replayedEntryId) &&
    typeof value.canUndo === "boolean" &&
    typeof value.canRedo === "boolean"
  );
}

export function isNoteSearchResult(value: unknown): value is NoteSearchResult {
  return (
    isRecord(value) &&
    hasOwnKeys(value, ["nodeId", "title", "parentTrail", "matchedField"]) &&
    typeof value.nodeId === "string" &&
    typeof value.title === "string" &&
    isDenseArray(value.parentTrail) &&
    value.parentTrail.every((item) => typeof item === "string") &&
    (value.matchedField === "title" ||
      value.matchedField === "note" ||
      value.matchedField === "date")
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
