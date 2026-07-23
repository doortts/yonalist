import type {
  ImageAtomEdit,
  LogicalSelection,
  MoveNoteNodeInput,
  NoteAttachment,
  NoteId,
  NoteImportNode,
  NoteNode,
  NotesHistoryContext,
  NotesMutationResponse,
  NoteSearchResult,
  NotesStore,
  NotesStoreError,
  NotesWorkspace,
  NotesWorkspaceScope,
  NoteTagFilter,
  NoteTagSummary,
  PendingImageNodeByteItem
} from "../../domain/notes";
import type { NotesAttachmentUiBoundary } from "./notesAttachmentController";
import type { ParsedImageAtomPaste } from "./notesImageAtomClipboard";
import type {
  ActiveImageAtomEditor,
  ImageAtomEditorSelectionAuthority,
  NotesImageAtomEditorAuthority,
  NotesImageAtomFlushAdapter
} from "./notesImageAtomEditorRegistry";
import type {
  NotesHistoryFocus,
  NotesHistoryFocusField,
  NotesHistoryPrimarySelection
} from "./notesHistory";
import type {
  NotesBatchCommandSettlement,
  NotesBatchOp,
  NotesChildPlacement
} from "./notesCommands";
import type {
  NotesPendingSelectionPolicy,
  NotesWorkspaceCommandOutcome,
  NotesWorkspaceCoordinatorSession,
  NotesWorkspaceQueueResult
} from "./notesWorkspaceCoordinator";
import type {
  NormalizedNotesWorkspace,
  NotesSelection
} from "./notesWorkspaceReducer";

export interface NotesDeleteAllOptions {
  /** Delete even when pending drafts cannot be written. */
  discardDrafts?: boolean;
}

export interface NotesDeleteAllResult {
  /** The database was deleted, but some attachment files remain on disk. */
  attachmentCleanupFailed: boolean;
}

export type NotesLibraryView =
  | "all"
  | "starred"
  | "recent"
  | "tags"
  | "archive"
  | "trash";

export interface NotesWorkspaceCompoundOptions {
  draft?: Pick<NoteNode, "title" | "note" | "imageOffsetUtf16"> &
    Partial<Pick<NoteNode, "markdownImageWidth">>;
  expandNodeId?: NoteId;
  onSuccess?: () => void;
}

export interface NotesCreateChildOptions {
  readonly newNodeId?: NoteId;
}

export interface UseNotesWorkspaceOptions {
  vaultRoot: string;
  repository: NotesStore;
  attachmentUi?: NotesAttachmentUiBoundary;
  publishFeedback?: (feedback: {
    kind: "status" | "error";
    message: string;
  }) => void;
}

export interface NotesPreparedMove {
  readonly token: number;
  readonly vaultRoot: string;
  readonly scope: NotesWorkspaceScope;
  readonly generation: number;
  readonly sourceId: NoteId;
  readonly nodes: readonly NoteNode[];
}

export interface NotesPreparedSelectionAuthority {
  readonly token: number;
  readonly vaultRoot: string;
  readonly scope: NotesWorkspaceScope;
  readonly generation: number;
  readonly session: NotesWorkspaceCoordinatorSession;
  readonly selectionRevision: number;
  readonly selectedNodeIds: readonly NoteId[];
  readonly workspace: NormalizedNotesWorkspace;
}

export type NotesPreparedMoveCommitResult =
  | { ok: true }
  | { ok: false; error: string };

export interface NotesPendingPrimarySelection {
  readonly requestId: number;
  readonly nodeId: NoteId;
  readonly field: "title";
  readonly selection: NotesHistoryPrimarySelection;
}

export interface NotesStateSlice {
  state: NormalizedNotesWorkspace;
  deletingNotesData: boolean;
  libraryView: NotesLibraryView;
  activeTagFilters: readonly NoteTagFilter[];
  tagSummaries: readonly NoteTagSummary[];
  locallyExpandedNodeIds: ReadonlySet<NoteId>;
  status: NormalizedNotesWorkspace["status"];
  loading: boolean;
  error: string | null;
  canUndo?: boolean;
  canRedo?: boolean;
  pendingPrimarySelection?: NotesPendingPrimarySelection | null;
}

export interface NotesNodeDraft
  extends Pick<NoteNode, "title" | "note" | "imageOffsetUtf16">,
    Partial<Pick<NoteNode, "markerKind" | "markdownImageWidth">> {
  revision: number;
  status: "pending" | "failed";
}

export interface NotesDraftsSlice {
  draftsByNodeId: Readonly<Record<NoteId, NotesNodeDraft>>;
  writeError: NotesStoreError | null;
  attachmentUploadErrorsByNodeId?: Readonly<Record<NoteId, string>>;
  attachmentUploadRetryAttemptIdsByNodeId?: Readonly<Record<NoteId, string>>;
  selection?: NotesSelection | null;
  selectionRevision?: number;
}

declare const notesImageAtomPasteAuthorityBrand: unique symbol;
declare const notesImageAtomCutAuthorityBrand: unique symbol;

export interface NotesImageAtomCutAuthority {
  readonly [notesImageAtomCutAuthorityBrand]: true;
}

export interface NotesImageAtomPasteAuthority {
  readonly [notesImageAtomPasteAuthorityBrand]: true;
}

export interface NotesPreparedSelectionBatchOptions {
  readonly focusNodeId?: NoteId | null;
  readonly expandNodeId?: NoteId;
  readonly expectedNavigationVersion?: number;
}

export interface NotesWorkspaceActions {
  setOutlineCompositionActive?(active: boolean): void;
  acknowledgeFocus(nodeId: NoteId, requestId?: number): Promise<void>;
  focusNode(
    nodeId: NoteId,
    selection?: NotesHistoryPrimarySelection
  ): Promise<void>;
  markEditingFocus?(nodeId: NoteId, field: NotesHistoryFocusField): void;
  getNavigationVersion?(): number;
  createRoot(): Promise<NotesWorkspaceCommandOutcome>;
  createNextTextSibling(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  splitNode(
    nodeId: NoteId,
    newNodeId: NoteId,
    prefix: string,
    suffix: string,
    options?: NotesWorkspaceCompoundOptions
  ): Promise<NotesWorkspaceCommandOutcome>;
  createChild(
    nodeId: NoteId,
    placement?: NotesChildPlacement,
    options?: NotesCreateChildOptions
  ): Promise<NotesWorkspaceCommandOutcome>;
  updateNode(
    nodeId: NoteId,
    patch: Pick<NoteNode, "title" | "note"> &
      Partial<Pick<NoteNode, "markerKind" | "markdownImageWidth">>
  ): Promise<NotesWorkspaceCommandOutcome>;
  updateNodeDraft(
    nodeId: NoteId,
    patch: Pick<NoteNode, "title" | "note" | "imageOffsetUtf16"> &
      Partial<Pick<NoteNode, "markerKind" | "markdownImageWidth">>,
    field?: NotesHistoryFocusField
  ): void;
  registerImageAtomFlushAdapter?(
    adapter: NotesImageAtomFlushAdapter
  ): () => void;
  flushNodeDraft(nodeId: NoteId): Promise<boolean>;
  flushAllDrafts(): Promise<boolean>;
  applyImageAtomEdit(
    nodeId: NoteId,
    selection: LogicalSelection,
    edit: ImageAtomEdit
  ): Promise<NotesWorkspaceCommandOutcome>;
  applyImageAtomPaste(
    nodeId: NoteId,
    selection: LogicalSelection,
    fragment: ParsedImageAtomPaste
  ): Promise<NotesWorkspaceCommandOutcome>;
  moveNode(
    input: MoveNoteNodeInput,
    focusNodeId?: NoteId | null,
    options?: NotesWorkspaceCompoundOptions
  ): Promise<NotesWorkspaceCommandOutcome>;
  applyBatch(
    nodeIds: readonly NoteId[],
    op: NotesBatchOp,
    options?: { focusNodeId?: NoteId | null }
  ): Promise<NotesWorkspaceCommandOutcome>;
  importSubtree(
    parentId: NoteId | null,
    afterId: NoteId | null,
    nodes: readonly NoteImportNode[]
  ): Promise<NotesWorkspaceCommandOutcome>;
  toggleComplete(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  toggleCollapsed(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  expandAll(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  collapseAll(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  sortSubtreeAscending(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  sortSubtreeDescending(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  toggleStar(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  duplicateNode(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  removeEmptyNode(
    nodeId: NoteId,
    focusNodeId?: NoteId | null,
    options?: NotesWorkspaceCompoundOptions
  ): Promise<NotesWorkspaceCommandOutcome>;
  deleteNode(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  restoreNode(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  archiveNode(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  unarchiveNode(nodeId: NoteId): Promise<NotesWorkspaceCommandOutcome>;
  emptyTrash(): Promise<NotesWorkspaceCommandOutcome>;
  selectLibraryView(view: NotesLibraryView): Promise<void>;
  toggleTagFilter(filter: NoteTagFilter): Promise<void>;
  searchNotes(query: string): Promise<NoteSearchResult[]>;
  openSearchResult(nodeId: NoteId): Promise<void>;
  deleteAllNotesData(
    options?: NotesDeleteAllOptions
  ): Promise<NotesDeleteAllResult>;
  zoomTo(nodeId: NoteId | null): Promise<void>;
  uploadImage?(nodeId: NoteId): Promise<void>;
  importDroppedImagePaths?(
    nodeId: NoteId,
    paths: readonly string[]
  ): Promise<void>;
  importClipboardImages?(
    nodeId: NoteId,
    items: readonly PendingImageNodeByteItem[]
  ): Promise<void>;
  retryImageUpload?(nodeId: NoteId, attemptId?: string): Promise<void>;
  loadAttachmentBytes?(attachmentId: string): Promise<Uint8Array>;
  viewImageOriginal?(attachmentId: string): Promise<void>;
  downloadImage?(
    attachmentId: string,
    originalName: string,
    mimeType: NoteAttachment["mimeType"]
  ): Promise<void>;
  resizeImage?(attachmentId: string, displayWidth: number): Promise<void>;
  removeImage?(attachmentId: string): Promise<void>;
  undo?(): Promise<void>;
  redo?(): Promise<void>;
  setImageImportMaxDisplayWidth(displayWidth: number | null): void;
  setSelectionAnchor(anchorId: NoteId): void;
  extendSelectionTo(headId: NoteId): void;
  toggleSelectionNode(
    nodeId: NoteId,
    visibleNodeIds: readonly NoteId[]
  ): void;
  clearSelection(): void;
  replaceSelection?(
    selection: NotesSelection | null,
    expectedRevision?: number
  ): boolean;
  getSelectionSnapshot?(): Readonly<{
    selection: NotesSelection | null;
    revision: number;
  }>;
}

export interface NotesActionsSlice {
  actions: NotesWorkspaceActions;
  registerActiveImageAtomEditor?(editor: ActiveImageAtomEditor): () => void;
  claimActiveImageAtomPaste?(event: ClipboardEvent): boolean;
  captureActiveImageAtomEditorAuthority?(
    nodeId: NoteId,
    selectionAuthority: ImageAtomEditorSelectionAuthority
  ): NotesImageAtomEditorAuthority | null;
  captureImageAtomCutAuthority?(
    nodeId: NoteId,
    editorAuthority: NotesImageAtomEditorAuthority
  ): NotesImageAtomCutAuthority | null;
  applyImageAtomCutWithAuthority?(
    authority: NotesImageAtomCutAuthority,
    nodeId: NoteId,
    selection: LogicalSelection
  ): Promise<NotesWorkspaceCommandOutcome>;
  captureImageAtomPasteAuthority?(
    nodeId: NoteId,
    editorAuthority: NotesImageAtomEditorAuthority
  ): NotesImageAtomPasteAuthority | null;
  isImageAtomPasteAuthorityCurrent?(
    authority: NotesImageAtomPasteAuthority
  ): boolean;
  applyImageAtomPasteWithAuthority?(
    authority: NotesImageAtomPasteAuthority,
    nodeId: NoteId,
    selection: LogicalSelection,
    fragment: ParsedImageAtomPaste
  ): Promise<NotesWorkspaceCommandOutcome>;
  retryFailedDraft(nodeId: NoteId): Promise<void>;
  retryLastFailedWrite(): Promise<void>;
  loadActiveNodesForMove?(): Promise<readonly NoteNode[]>;
  prepareMoveNode?(nodeId: NoteId): Promise<NotesPreparedMove>;
  commitPreparedMove?(
    prepared: NotesPreparedMove,
    destinationId: NoteId | null
  ): Promise<NotesPreparedMoveCommitResult>;
  prepareSelectionAuthority?(
    selectedNodeIds: readonly NoteId[]
  ): Promise<NotesPreparedSelectionAuthority>;
  isPreparedSelectionAuthorityCurrent?(
    prepared: NotesPreparedSelectionAuthority
  ): boolean;
  applyPreparedSelectionBatch?(
    prepared: NotesPreparedSelectionAuthority,
    op: NotesBatchOp,
    options?: NotesPreparedSelectionBatchOptions
  ): Promise<NotesBatchCommandSettlement>;
}

export interface UseNotesWorkspaceResult
  extends NotesStateSlice,
    NotesDraftsSlice,
    NotesActionsSlice {}

export interface UseNotesWorkspaceHookResult extends UseNotesWorkspaceResult {
  stateSlice: NotesStateSlice;
  draftsSlice: NotesDraftsSlice;
  actionsSlice: NotesActionsSlice;
}

export interface StructuralCommandOptions {
  readonly historyContext?: NotesHistoryContext | null;
  readonly retainHistoryOnFailure?: boolean;
  readonly selectionPolicy?: NotesPendingSelectionPolicy;
  readonly historyFocus?: NotesHistoryFocus | null;
}

export interface ProjectedNotesMutation {
  workspace: NotesWorkspace;
  projectionError?: string;
}

export interface NotesWorkspaceQueueStep {
  run(): Promise<NotesMutationResponse | NotesWorkspaceQueueResult>;
  historyEntryId?: string;
}

export interface LiveNotesNavigation {
  selectedId: NoteId | null;
  zoomRootId: NoteId | null;
  editingNoteId: NoteId | null;
  pendingFocusId: NoteId | null;
  pendingFocusField: NotesHistoryFocusField | null;
}

export interface TagFilterOrigin {
  scope: NotesWorkspaceScope;
  libraryView: Exclude<NotesLibraryView, "tags">;
  navigation: LiveNotesNavigation;
  locallyExpandedNodeIds: ReadonlySet<NoteId>;
}

export interface NotesLifecycleNavigationSnapshot {
  selectedId: NoteId | null;
  zoomRootId: NoteId | null;
  editingNoteId: NoteId | null;
  pendingFocusId: NoteId | null;
  pendingFocusField: NotesHistoryFocusField | null;
  locallyExpandedNodeIds: ReadonlySet<NoteId>;
  scope: NotesWorkspaceScope;
}

export interface NotesLifecycleNavigationTransition {
  before: NotesLifecycleNavigationSnapshot;
  after: NotesLifecycleNavigationSnapshot;
}
