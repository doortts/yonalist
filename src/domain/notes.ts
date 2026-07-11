export type NoteId = string;
export type NoteLayoutMode = "bullets";

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

export interface NotesWorkspace {
  nodes: NoteNode[];
}

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

export interface NoteSearchResult {
  nodeId: NoteId;
  title: string;
  parentTrail: string[];
  matchedField: "title" | "note";
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

export interface NotesStore {
  initialize(vaultPath: string): Promise<void>;
  loadWorkspace(vaultPath: string, scope: NotesWorkspaceScope): Promise<NotesWorkspace>;
  createNode(vaultPath: string, input: CreateNoteNodeInput, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResponse>;
  updateNode(vaultPath: string, input: UpdateNoteNodeInput, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResponse>;
  splitNode(vaultPath: string, input: SplitNoteNodeInput, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResponse>;
  moveNode(vaultPath: string, input: MoveNoteNodeInput, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResponse>;
  toggleComplete(vaultPath: string, nodeId: NoteId, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResponse>;
  toggleCollapsed(vaultPath: string, nodeId: NoteId, historyContext?: NotesHistoryContext | null): Promise<NotesMutationResponse>;
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
  emptyTrash(vaultPath: string): Promise<NotesWorkspace>;
  search(vaultPath: string, query: string): Promise<NoteSearchResult[]>;
  searchStructured?(vaultPath: string, query: NoteStructuredSearchQuery): Promise<NoteSearchResult[]>;
  listTags(vaultPath: string): Promise<string[]>;
  listTagsWithCounts(vaultPath: string): Promise<NoteTagSummary[]>;
  deleteDatabase(vaultPath: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

export function isNoteNode(value: unknown): value is NoteNode {
  return (
    isRecord(value) &&
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
    isRecord(value.workspace) &&
    Array.isArray(value.workspace.nodes) &&
    value.workspace.nodes.every(isNoteNode) &&
    isNullableString(value.historyEntryId) &&
    typeof value.canUndo === "boolean" &&
    typeof value.canRedo === "boolean"
  );
}

export function isNoteSearchResult(value: unknown): value is NoteSearchResult {
  return (
    isRecord(value) &&
    typeof value.nodeId === "string" &&
    typeof value.title === "string" &&
    Array.isArray(value.parentTrail) &&
    value.parentTrail.every((item) => typeof item === "string") &&
    (value.matchedField === "title" || value.matchedField === "note")
  );
}

function isNoteSearchTag(value: unknown): value is NoteSearchTag {
  return (
    isRecord(value) &&
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
    typeof value.text === "string" &&
    Array.isArray(value.requiredTags) &&
    value.requiredTags.every(isNoteSearchTag) &&
    Array.isArray(value.excludedTags) &&
    value.excludedTags.every(isNoteSearchTag) &&
    Array.isArray(value.orGroups) &&
    value.orGroups.every(
      (group) => Array.isArray(group) && group.every(isNoteSearchTag)
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
