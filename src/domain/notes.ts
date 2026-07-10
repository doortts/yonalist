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
}

export interface NotesWorkspace {
  nodes: NoteNode[];
}

export type NotesWorkspaceScope =
  | { kind: "active" }
  | { kind: "starred" }
  | { kind: "recent" }
  | { kind: "tag"; tag: string }
  | { kind: "trash" };

export interface NoteSearchResult {
  nodeId: NoteId;
  title: string;
  parentTrail: string[];
  matchedField: "title" | "note";
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
  createNode(vaultPath: string, input: CreateNoteNodeInput): Promise<NotesWorkspace>;
  updateNode(vaultPath: string, input: UpdateNoteNodeInput): Promise<NotesWorkspace>;
  splitNode(vaultPath: string, input: SplitNoteNodeInput): Promise<NotesWorkspace>;
  moveNode(vaultPath: string, input: MoveNoteNodeInput): Promise<NotesWorkspace>;
  toggleComplete(vaultPath: string, nodeId: NoteId): Promise<NotesWorkspace>;
  toggleCollapsed(vaultPath: string, nodeId: NoteId): Promise<NotesWorkspace>;
  toggleStar?(vaultPath: string, nodeId: NoteId): Promise<NotesWorkspace>;
  duplicateNode(vaultPath: string, nodeId: NoteId): Promise<NotesWorkspace>;
  removeEmptyNode(vaultPath: string, nodeId: NoteId): Promise<NotesWorkspace>;
  softDeleteNode(vaultPath: string, nodeId: NoteId): Promise<NotesWorkspace>;
  restoreNode(vaultPath: string, nodeId: NoteId): Promise<NotesWorkspace>;
  emptyTrash(vaultPath: string): Promise<NotesWorkspace>;
  search?(vaultPath: string, query: string): Promise<NoteSearchResult[]>;
  listTags?(vaultPath: string): Promise<string[]>;
  deleteDatabase?(vaultPath: string): Promise<void>;
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
    isNullableString(value.deletedAt)
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
