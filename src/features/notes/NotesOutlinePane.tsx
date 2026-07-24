import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import {
  ChevronRight,
  Home,
  ListChecks,
  Maximize2,
  Minimize2,
  Trash2
} from "lucide-react";
import {
  Fragment,
  type CSSProperties,
  type ClipboardEvent,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import {
  IconTooltip,
  TooltipProvider
} from "../../components/ui/Tooltip";
import type {
  NoteId,
  NoteImportNode,
  NoteNode,
  NoteSearchTag
} from "../../domain/notes";
import {
  serializeExternalBulletKey,
  type ExternalBullet
} from "../../domain/externalSources";
import {
  useExternalSources,
  type GithubMaterializedRefreshOutcome,
  type GithubMaterializedRefreshRequest
} from "../../ExternalSourcesContext";
import { PaneLayoutContext } from "../../PaneLayoutContext";
import {
  GITHUB_NOTIFICATIONS_PROVIDER_ID,
  GITHUB_NOTIFICATIONS_ROOT_ID,
  githubNotificationSnapshot
} from "../../services/githubNotificationsProvider";
import { VaultRootContext } from "../../VaultRootContext";
import { NotesChildComposer } from "./NotesChildComposer";
import { NotesAttachmentDragPreview } from "./NotesAttachmentDragPreview";
import { NotesExportMenu } from "./NotesExportMenu";
import { NotesExportControllerProvider } from "./NotesExportController";
import { useNotesFeedback } from "./NotesFeedbackContext";
import { useNotesAttachmentUi } from "./NotesAttachmentUiContext";
import type { NotesNativeImageDropEvent } from "./notesAttachmentController";
import {
  attachmentTargetFromPaste,
  attachmentTargetFromPoint
} from "./notesAttachmentTargets";
import { extractClipboardImages } from "./notesClipboardImages";
import { NotesPageHeader } from "./NotesPageHeader";
import { NotesExternalOutlinePane } from "./NotesExternalOutlinePane";
import { NotesExternalBulletRow } from "./NotesExternalBulletRow";
import {
  githubNotificationSnapshotFromBullet,
  projectGithubNotificationsOutline,
  resolveGithubEditorFocusFallback,
  storedGithubNotificationBullet,
  type GithubEditorFocusKey
} from "./githubNotificationsOutline";
import { githubProjectionLeaseRequested } from "./githubProjectionLease";
import {
  noteNodeNavigationLabel,
  noteNodePresentationLabel
} from "./notesPresentation";
import { NotesQuickJump } from "./NotesQuickJump";
import { NotesSyncStatusBadge } from "./NotesSyncStatusBadge";
import type {
  NotesBulletMenuSelectionBridge,
  NotesBulletMenuSelectionState
} from "./NotesBulletMenu";
import { NotesMoveChooser } from "./NotesMoveChooser";
import { NotesTagChooser } from "./NotesTagChooser";
import type { NotesFrozenSelectionSnapshot } from "./notesSelectionChooser";
import {
  NotesSelectionActionBar,
  type NotesSelectionActionBarAction
} from "./NotesSelectionActionBar";
import { NotesSelectionDragPreview } from "./NotesSelectionDragPreview";
import {
  useNotesActions,
  useNotesDrafts,
  useNotesState
} from "./NotesWorkspaceContext";
import { writeNotesClipboardText } from "./notesClipboard";
import { createNotesSelectionNativeClipboardController } from "./notesSelectionNativeClipboard";
import { deriveNotesSelectionActionSnapshot } from "./notesSelectionActions";
import {
  notesSelectionMutationDisabledReason as deriveSelectionMutationDisabledReason,
  notesSelectionOperationDisabledReason
} from "./notesSelectionMutationAvailability";
import {
  buildNotesMoveDestinations,
  protectedNotesMoveRootIds
} from "./notesMoveTargets";
import { tokenizeNoteText } from "./noteTokens";
import {
  derivePreparedOutlineSelectionDropPreview,
  deriveOutlineDropPreview,
  OUTLINE_INDENT_PX,
  OUTLINE_NARROW_INDENT_PX,
  OUTLINE_NARROW_MEDIA_QUERY,
  prepareOutlineSelectionDrag,
  preparedOutlineSelectionDragContainsNode,
  preparedOutlineSelectionDragForestNodeIds,
  projectPreparedOutlineSelectionDrop,
  projectPreparedOutlineSelectionDropAtBoundary,
  projectOutlineDrop,
  projectOutlineDropAtBoundary,
  type OutlineDropProjection,
  type OutlineDropPreview,
  type OutlineSelectionDropResult,
  type PreparedOutlineSelectionDrag
} from "./outlineDrag";
import { NOTES_DRAG_OVERLAY_MODIFIERS } from "./notesDragOverlay";
import {
  resolveOutlinePointerBoundary,
  type OutlinePointerBoundary
} from "./outlinePointerDrop";
import {
  projectOutlineSelectionDragSession,
  startOutlineSelectionDragSession,
  type OutlineSelectionDragFrozenContext,
  type OutlineSelectionDragProjection,
  type OutlineSelectionDragSession
} from "./outlineSelectionDragSession";
import {
  selectionSubtreeIds,
  type NormalizedNotesWorkspace
} from "./notesWorkspaceReducer";
import {
  deriveOutlineBodyRows,
  flattenVisibleOutlineRows,
  parentTrail,
  type FlattenedOutlineRow
} from "./outlineTree";
import {
  detectOutlineShortcutPlatform,
  resolveExternalEditorKey,
  resolveNotesHistoryShortcut
} from "./outlineKeyboard";
import {
  isOutlineSelectionInteractiveTarget,
  isOutlineSelectionTextSurface,
  isOutlineSelectionToggleModifier,
  OutlineNodeRow
} from "./OutlineNodeRow";
import {
  useNotesSelectionCommandRouter,
  type NotesSelectionCommandOwnership,
  type NotesSelectionCommandIntent
} from "./useNotesSelectionCommandRouter";
import type {
  NotesPreparedSelectionAuthority,
  UseNotesWorkspaceResult
} from "./useNotesWorkspace";

const outlineScreenReaderInstructions = {
  draggable:
    "To pick up a note, press Space or Enter. Use Arrow Up and Arrow Down to choose a visible row. Press Space or Enter to drop, or Escape to cancel."
};

const EMPTY_GITHUB_COLLAPSED_GROUPS: readonly string[] = [];

const selectionDragRejectedMessage =
  "Can't move selection: the selected rows cannot be moved together.";
const filteredDragPreparingMessage =
  "Notes are still preparing for drag. Try again.";
const filteredDragUnavailableMessage =
  "Can't move notes: the full outline couldn't be prepared. Try again.";

type FilteredDragAuthorityPreparation = Readonly<{
  status: "idle" | "preparing" | "ready" | "error";
  authority: NotesPreparedSelectionAuthority | null;
}>;

interface ImageIngestError {
  readonly label: "Image drop failed" | "Image paste failed";
  readonly message: string;
}

interface ImageDropPreview {
  readonly paths: readonly string[];
  readonly position: Extract<
    NotesNativeImageDropEvent,
    { position: unknown }
  >["position"];
}

type SelectionChooserOwnership = NotesSelectionCommandOwnership<
  NotesPreparedSelectionAuthority
>;
type SelectionChooserRequestOrigin = "menu" | "toolbar";
type SelectionChooserSnapshot = NotesFrozenSelectionSnapshot<
  SelectionChooserOwnership
>;
type SelectionChooserSession =
  | Readonly<{
      kind: "move";
      snapshot: SelectionChooserSnapshot;
    }>
  | Readonly<{
      kind: "tags";
      snapshot: SelectionChooserSnapshot;
      selectedTagUnion: readonly NoteSearchTag[];
    }>;

type PaneDragProjection =
  | Readonly<{
      kind: "ordinary-move";
      projection: OutlineDropProjection;
    }>
  | Readonly<{
      kind: "ordinary-preview";
      projection: OutlineDropProjection;
    }>
  | Readonly<{
      kind: "selected-preview";
      prepared: PreparedOutlineSelectionDrag;
      result: OutlineSelectionDropResult;
    }>
  | OutlineSelectionDragProjection;
type PendingPaneSelectionDragPreparation = {
  /** `undefined` is still loading, `null` is a rejected/stale ownership. */
  current: OutlineSelectionDragFrozenContext | null | undefined;
  promise: Promise<OutlineSelectionDragFrozenContext | null>;
};
type PendingPaneSelectionDragSession = Readonly<{
  kind: "selected-pending";
  attemptEpoch: number;
  activeId: NoteId;
  selectedNodeIds: readonly NoteId[];
  selectionRevision: number;
  rows: readonly FlattenedOutlineRow[];
  zoomRootId: NoteId | null;
  preview: PreparedOutlineSelectionDrag;
  preparation: PendingPaneSelectionDragPreparation;
}>;
type PaneDragSession =
  | OutlineSelectionDragSession
  | PendingPaneSelectionDragSession;
type PanePointerDropBoundary = OutlinePointerBoundary &
  Readonly<{ activeId: NoteId }>;
type GithubProjectionDrop = Readonly<{
  activeId: NoteId;
  serializedKey: string;
}>;

interface NotesDragPresentationSnapshot {
  readonly forestNodeIds: readonly NoteId[];
  readonly representativeLabel: string;
  readonly representativeThumbnailSrc?: string;
}

function renderedDragImageSource(
  root: ParentNode | null,
  nodeId: NoteId
): string | undefined {
  const row = Array.from(
    root?.querySelectorAll<HTMLElement>("[data-outline-id]") ?? []
  ).find((candidate) => candidate.dataset.outlineId === nodeId);
  const rowBounds = row?.getBoundingClientRect();
  const rootBounds =
    root instanceof Element ? root.getBoundingClientRect() : undefined;
  if (
    !rowBounds ||
    !rootBounds ||
    rowBounds.bottom <= rootBounds.top ||
    rowBounds.top >= rootBounds.bottom ||
    rowBounds.right <= rootBounds.left ||
    rowBounds.left >= rootBounds.right
  ) {
    return undefined;
  }
  const image = row?.querySelector<HTMLImageElement>(
    ".notes-image-node-content img"
  );
  return image?.currentSrc || image?.src || undefined;
}

function notesDragPresentationSnapshot(
  prepared: PreparedOutlineSelectionDrag,
  workspace: Pick<NormalizedNotesWorkspace, "nodesById">,
  representativeTitle?: string,
  representativeThumbnailSrc?: string
): NotesDragPresentationSnapshot {
  const representativeNode = workspace.nodesById[prepared.nodeIds[0]];
  return Object.freeze({
    forestNodeIds: preparedOutlineSelectionDragForestNodeIds(prepared),
    representativeLabel: representativeNode
      ? noteNodeNavigationLabel(
          representativeNode,
          representativeTitle ?? representativeNode.title,
          "Untitled"
        )
      : "Untitled",
    representativeThumbnailSrc:
      representativeNode?.nodeKind === "image"
        ? representativeThumbnailSrc
        : undefined
  });
}

function trackPendingSelectionDragPreparation(
  promise: Promise<OutlineSelectionDragFrozenContext | null>
): PendingPaneSelectionDragPreparation {
  const preparation: PendingPaneSelectionDragPreparation = {
    current: undefined,
    promise: Promise.resolve(null)
  };
  preparation.promise = promise.then(
    (context) => {
      preparation.current = context;
      return context;
    },
    () => {
      preparation.current = null;
      return null;
    }
  );
  return preparation;
}

function exactNoteIds(
  left: readonly NoteId[],
  right: readonly NoteId[]
): boolean {
  return (
    left.length === right.length &&
    left.every((nodeId, index) => nodeId === right[index])
  );
}

function selectedTagUnion(
  workspace: NormalizedNotesWorkspace,
  nodeIds: readonly NoteId[]
): readonly NoteSearchTag[] {
  const tags = new Map<string, NoteSearchTag>();
  for (const nodeId of nodeIds) {
    const node = workspace.nodesById[nodeId];
    if (!node) {
      continue;
    }
    for (const token of tokenizeNoteText(`${node.title}\n${node.note}`)) {
      if (token.kind !== "tag") {
        continue;
      }
      const key = `${token.prefix}\u0000${token.normalized}`;
      if (!tags.has(key)) {
        tags.set(key, {
          prefix: token.prefix,
          normalizedTag: token.normalized,
          displayTag: token.display
        });
      }
    }
  }
  return Object.freeze([...tags.values()]);
}

function frozenMoveTarget(
  workspace: NormalizedNotesWorkspace,
  rootIds: readonly NoteId[],
  destinationId: NoteId | null
): { parentId: NoteId | null; afterId: NoteId | null } | null {
  if (
    !buildNotesMoveDestinations(workspace.nodesById, rootIds).some(
      (destination) => destination.id === destinationId
    )
  ) {
    return null;
  }
  const selected = new Set(rootIds);
  const siblings =
    destinationId === null
      ? workspace.rootIds
      : (workspace.childIdsByParent[destinationId] ?? []);
  return {
    parentId: destinationId,
    afterId:
      [...siblings].reverse().find((nodeId) => !selected.has(nodeId)) ?? null
  };
}

interface ImagePasteExecutionScope {
  readonly vaultRoot: string;
  readonly libraryView: UseNotesWorkspaceResult["libraryView"];
  readonly status: UseNotesWorkspaceResult["state"]["status"];
  readonly deletingNotesData: boolean;
  readonly importClipboardImages: UseNotesWorkspaceResult["actions"]["importClipboardImages"];
}

interface NotesBreadcrumbProps {
  disabled: boolean;
  trashView: boolean;
  onRequestEmptyTrash(): void;
}

interface ImageDropMarkerBoundary {
  readonly afterId: NoteId;
  readonly depth: number;
}

function breadcrumbLabel(
  node: NoteNode,
  attachments: readonly { originalName: string }[]
): string {
  return noteNodeNavigationLabel(
    node,
    node.title,
    "Untitled page",
    node.nodeKind === "image" && attachments.length === 1
      ? attachments[0]?.originalName
      : undefined
  );
}

function optionalNodeLabel(
  node: NoteNode | undefined,
  title: string | undefined,
  emptyLabel = "Untitled node"
): string | undefined {
  return node
    ? noteNodePresentationLabel(node, title ?? node.title, emptyLabel)
    : undefined;
}

function NotesBreadcrumb({
  disabled,
  trashView,
  onRequestEmptyTrash
}: NotesBreadcrumbProps) {
  const { actions } = useNotesActions();
  const { state } = useNotesState();
  const trail = state.zoomRootId ? parentTrail(state, state.zoomRootId) : [];

  return (
    <nav className="notes-breadcrumb" aria-label="Notes breadcrumb">
      <IconTooltip label="All notes" side="bottom">
        <button
          className="notes-breadcrumb-button notes-breadcrumb-home"
          type="button"
          aria-label="All notes"
          aria-current={state.zoomRootId === null ? "page" : undefined}
          disabled={disabled}
          onClick={() => void actions.zoomTo(null)}
        >
          <Home size={15} aria-hidden="true" />
        </button>
      </IconTooltip>
      {trail.map((nodeId) => {
        const node = state.nodesById[nodeId];
        if (!node) {
          return null;
        }
        const label = breadcrumbLabel(
          node,
          state.attachmentsByNodeId[node.id] ?? []
        );
        return (
          <span className="notes-breadcrumb-segment" key={nodeId}>
            <ChevronRight size={14} aria-hidden="true" />
            <button
              className="notes-breadcrumb-button"
              type="button"
              aria-current={state.zoomRootId === nodeId ? "page" : undefined}
              disabled={disabled}
              onClick={() => void actions.zoomTo(nodeId)}
            >
              {label}
            </button>
          </span>
        );
      })}
      {trashView && (
        <button
          className="notes-empty-trash-button"
          type="button"
          disabled={disabled}
          onClick={onRequestEmptyTrash}
        >
          <Trash2 size={15} aria-hidden="true" />
          <span>Empty trash</span>
        </button>
      )}
    </nav>
  );
}

function DropPreviewLine({ preview }: { preview: OutlineDropPreview }) {
  return (
    <span
      className="notes-outline-drop-preview"
      aria-hidden="true"
      data-before-id={preview.beforeId ?? undefined}
      data-parent-id={preview.parentId ?? undefined}
      data-depth={preview.depth}
      style={
        {
          "--notes-drop-depth": preview.depth,
        } as CSSProperties
      }
    />
  );
}

function hideCompletedSubtrees<Row extends { depth: number; id: NoteId }>(
  rows: readonly Row[],
  nodesById: UseNotesWorkspaceResult["state"]["nodesById"],
  zoomRootId: NoteId | null
): Row[] {
  let hiddenDepth: number | null = null;
  return rows.filter((row) => {
    if (hiddenDepth !== null) {
      if (row.depth > hiddenDepth) {
        return false;
      }
      hiddenDepth = null;
    }
    const node = nodesById[row.id];
    if (!node || node.completedAt === null) {
      return true;
    }
    hiddenDepth = row.depth;
    return row.id === zoomRootId;
  });
}

function useOutlineIndentPx(): number {
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia(OUTLINE_NARROW_MEDIA_QUERY).matches
      : false
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia(OUTLINE_NARROW_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsNarrow(event.matches);
    };
    setIsNarrow(media.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  return isNarrow ? OUTLINE_NARROW_INDENT_PX : OUTLINE_INDENT_PX;
}

const pointerSensorOptions = { activationConstraint: { distance: 4 } };
const keyboardSensorOptions = { coordinateGetter: sortableKeyboardCoordinates };

interface MouseSelectionGesture {
  readonly pointerId: number;
  readonly anchorId: NoteId;
  promoted: boolean;
}

function rowIdFromPointerTarget(target: EventTarget | null): NoteId | null {
  if (!(target instanceof Element)) return null;
  const row =
    target.closest<HTMLElement>("[data-outline-id]") ??
    target
      .closest<HTMLElement>(".notes-outline-item")
      ?.querySelector<HTMLElement>("[data-outline-id]");
  return row?.dataset.outlineId ?? null;
}

function rowIdFromPointerCoordinates(
  clientX: number,
  clientY: number
): NoteId | null {
  return typeof document.elementFromPoint === "function"
    ? rowIdFromPointerTarget(document.elementFromPoint(clientX, clientY))
    : null;
}

export function NotesOutlinePane() {
  const attachmentUi = useNotesAttachmentUi();
  const paneLayout = useContext(PaneLayoutContext);
  const externalSources = useExternalSources();
  const {
    actions,
    applyPreparedSelectionBatch,
    claimActiveImageAtomPaste,
    isPreparedSelectionAuthorityCurrent,
    prepareSelectionAuthority,
    retryLastFailedWrite
  } = useNotesActions();
  const vaultRoot = useContext(VaultRootContext);
  const {
    activeTagFilters,
    deletingNotesData,
    libraryView,
    locallyExpandedNodeIds,
    state,
    tagSummaries
  } = useNotesState();
  const {
    attachmentUploadErrorsByNodeId,
    attachmentUploadRetryAttemptIdsByNodeId,
    draftsByNodeId,
    selection,
    selectionRevision = 0,
    writeError
  } = useNotesDrafts();
  const selectionChooserScopeKey = `${vaultRoot}\u0000${libraryView}\u0000${activeTagFilters
    .map((filter) => `${filter.prefix}\u0000${filter.normalizedTag}`)
    .join("\u0001")}`;
  const selectionChooserLifecycleKey = `${selectionRevision}\u0002${selectionChooserScopeKey}`;
  const getLiveSelectionSnapshot = actions.getSelectionSnapshot;
  const [activeDragId, setActiveDragId] = useState<NoteId | null>(null);
  const [dragPresentation, setDragPresentation] =
    useState<NotesDragPresentationSnapshot | null>(null);
  const dragSourceNodeIdSet = useMemo(
    () => new Set(dragPresentation?.forestNodeIds ?? []),
    [dragPresentation]
  );
  const draggedNodeLabels = useMemo(
    () =>
      dragPresentation === null
        ? []
        : [dragPresentation.representativeLabel],
    [dragPresentation]
  );
  const [dropPreview, setDropPreview] = useState<OutlineDropPreview | null>(null);
  const [emptyTrashConfirmOpen, setEmptyTrashConfirmOpen] = useState(false);
  const [quickJumpOpen, setQuickJumpOpen] = useState(false);
  const [showCompleted, setShowCompleted] = useState(true);
  const [imageDropTargetId, setImageDropTargetId] =
    useState<NoteId | null>(null);
  const [imageDropPreview, setImageDropPreview] =
    useState<ImageDropPreview | null>(null);
  const [imageIngestError, setImageIngestError] =
    useState<ImageIngestError | null>(null);
  const [preparedSelectionAuthority, setPreparedSelectionAuthority] =
    useState<NotesPreparedSelectionAuthority | null>(null);
  const [selectionAuthorityFailureKey, setSelectionAuthorityFailureKey] =
    useState<string | null>(null);
  const [filteredDragAuthorityRetryNonce, setFilteredDragAuthorityRetryNonce] =
    useState(0);
  const [filteredDragAuthorityPreparation, setFilteredDragAuthorityPreparation] =
    useState<FilteredDragAuthorityPreparation>({
      status: "idle",
      authority: null
    });
  const [selectionDragContext, setSelectionDragContext] =
    useState<OutlineSelectionDragFrozenContext | null>(null);
  const [selectionDragContextFailureKey, setSelectionDragContextFailureKey] =
    useState<string | null>(null);
  const [selectionDragContextRetryNonce, setSelectionDragContextRetryNonce] =
    useState(0);
  const [selectionChooser, setSelectionChooser] =
    useState<SelectionChooserSession | null>(null);
  const [selectionChooserFeedback, setSelectionChooserFeedback] = useState({
    busy: false,
    error: null as string | null
  });
  const [selectionClipboardError, setSelectionClipboardError] = useState<
    string | null
  >(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dropSurfaceRef = useRef<HTMLDivElement>(null);
  const selectionToolbarRef = useRef<HTMLDivElement>(null);
  const mouseSelectionGestureRef = useRef<MouseSelectionGesture | null>(null);
  const lastSelectionHeadRef = useRef<NoteId | null>(null);
  const selectionAuthorityRequestRef = useRef(0);
  const selectionChooserPreparationRequestRef = useRef(0);
  const selectionChooserPreparingRef = useRef(false);
  const selectionChooserLifecycleRef = useRef(selectionChooserLifecycleKey);
  const selectionClipboardLifecycleRef = useRef(0);
  const filteredDragAuthorityRequestRef = useRef(0);
  const selectionDragContextRequestRef = useRef(0);
  const selectionDragContextRef =
    useRef<OutlineSelectionDragFrozenContext | null>(null);
  const outlineDragAttemptEpochRef = useRef(0);
  const outlineDragSessionRef = useRef<PaneDragSession | null>(null);
  const pointerDropBoundaryRef = useRef<PanePointerDropBoundary | null>(null);
  const githubProjectionDropRef = useRef<GithubProjectionDrop | null>(null);
  const structuralRowsRef = useRef<readonly FlattenedOutlineRow[]>([]);
  const selectedDragNodeIdsRef = useRef<readonly NoteId[] | null>(null);
  const selectionDragRejectionPublishedRef = useRef(false);
  const imageDropPathsRef = useRef<readonly string[]>([]);
  const imageDropAvailableRef = useRef(false);
  const imageDropFallbackTargetIdRef = useRef(state.zoomRootId);
  const imageDropTargetIdRef = useRef<NoteId | null>(null);
  const importDroppedImagePathsRef = useRef(actions.importDroppedImagePaths);
  const imagePasteLifecycleRef = useRef({ mounted: true, generation: 0 });
  const outlineIndentPx = useOutlineIndentPx();
  const imagePasteExecutionScope = useMemo<ImagePasteExecutionScope>(
    () => ({
      vaultRoot,
      libraryView,
      status: state.status,
      deletingNotesData,
      importClipboardImages: actions.importClipboardImages
    }),
    [
      actions.importClipboardImages,
      deletingNotesData,
      libraryView,
      state.status,
      vaultRoot
    ]
  );
  const imagePasteExecutionScopeRef = useRef(imagePasteExecutionScope);
  imagePasteExecutionScopeRef.current = imagePasteExecutionScope;
  const trashView = libraryView === "trash";
  const lifecycleReadOnly = trashView || libraryView === "archive";
  const lifecycleMode =
    libraryView === "archive"
      ? "archive"
      : trashView
        ? "trash"
        : "standard";
  const hasVaultRoot = vaultRoot.trim().length > 0;
  const selectionMutationDisabledReason =
    deriveSelectionMutationDisabledReason({
      deletingNotesData,
      lifecycleReadOnly,
      loading: state.status === "loading",
      writeError: writeError !== null
    });
  const selectionMutationDisabledReasonRef = useRef(
    selectionMutationDisabledReason
  );
  selectionMutationDisabledReasonRef.current =
    selectionMutationDisabledReason;
  const imageDropAvailable =
    hasVaultRoot &&
    !deletingNotesData &&
    !lifecycleReadOnly &&
    state.status !== "loading" &&
    actions.importDroppedImagePaths !== undefined;
  const imagePasteAvailable =
    hasVaultRoot &&
    !imagePasteExecutionScope.deletingNotesData &&
    !lifecycleReadOnly &&
    imagePasteExecutionScope.status !== "loading" &&
    imagePasteExecutionScope.importClipboardImages !== undefined;
  imageDropAvailableRef.current = imageDropAvailable;
  imageDropFallbackTargetIdRef.current = state.zoomRootId;
  importDroppedImagePathsRef.current = actions.importDroppedImagePaths;
  useLayoutEffect(() => {
    setImageIngestError(null);
  }, [imagePasteExecutionScope]);
  useEffect(() => {
    // The lifecycle ref object is created once and never reassigned, so
    // capturing it here keeps the cleanup pointed at the same instance
    // (satisfies react-hooks/exhaustive-deps, which OURS enforces).
    const lifecycle = imagePasteLifecycleRef.current;
    lifecycle.mounted = true;
    return () => {
      lifecycle.mounted = false;
      lifecycle.generation += 1;
    };
  }, []);
  const handlePasteCapture = (event: ClipboardEvent<HTMLDivElement>) => {
    if (claimActiveImageAtomPaste?.(event.nativeEvent)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    let clipboardItems: DataTransferItemList;
    try {
      clipboardItems = event.clipboardData.items;
    } catch {
      return;
    }
    let hasImageCandidate = false;
    for (let index = 0; index < clipboardItems.length; index += 1) {
      const item = clipboardItems[index];
      if (item.kind === "file" && item.type.startsWith("image/")) {
        hasImageCandidate = true;
        break;
      }
    }
    // Only a real image *file* paste is owned by the pane. Plain text — or a
    // string item merely tagged with an image MIME type — bubbles on to the
    // row editors' own paste handling (Phase 4.4 subtree import / default).
    if (!hasImageCandidate) return;

    // The pane owns image-file pastes end to end, so stop the row-level paste
    // handlers from also processing this event: without this they would
    // double-import and, on minimal synthetic clipboard events, throw.
    event.stopPropagation();

    const lifecycle = imagePasteLifecycleRef.current;
    const executionScope = imagePasteExecutionScopeRef.current;
    const attemptGeneration = ++lifecycle.generation;
    const isCurrentAttempt = (): boolean =>
      lifecycle.mounted &&
      lifecycle.generation === attemptGeneration &&
      imagePasteExecutionScopeRef.current === executionScope;
    const setCurrentPasteError = (message: string): void => {
      if (!isCurrentAttempt()) return;
      setImageIngestError({ label: "Image paste failed", message });
    };
    const reportCurrentPasteError = (cause: unknown): void => {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setCurrentPasteError(`Image paste failed: ${detail}`);
    };

    let extraction: ReturnType<typeof extractClipboardImages>;
    try {
      extraction = extractClipboardImages(clipboardItems);
    } catch {
      // The clipboard items could not be read at all; leave the paste
      // browser/editor-owned rather than silently swallowing it.
      return;
    }
    if (extraction.kind === "error") {
      event.preventDefault();
      setCurrentPasteError(extraction.message);
      return;
    }
    if (extraction.kind === "none") return;

    const pasteTarget = event.target;
    const targetIsEditableField =
      pasteTarget instanceof HTMLElement &&
      (pasteTarget.tagName === "TEXTAREA" ||
        pasteTarget.tagName === "INPUT" ||
        pasteTarget.isContentEditable);
    if (!imagePasteAvailable) {
      // A blocked image paste on the bare outline surface is claimed so it
      // does nothing; inside an editor field it stays field/browser-owned.
      if (!targetIsEditableField) event.preventDefault();
      return;
    }

    event.preventDefault();
    if (isCurrentAttempt()) setImageIngestError(null);
    const selectedId =
      state.selectedId !== null && state.nodesById[state.selectedId]
        ? state.selectedId
        : null;
    const targetId = attachmentTargetFromPaste(
      event.currentTarget,
      event.target,
      selectedId
    );
    if (targetId === null) {
      setCurrentPasteError("Select a note before pasting images.");
      return;
    }

    const importClipboardImages = executionScope.importClipboardImages;
    if (!importClipboardImages) return;
    try {
      void Promise.resolve(
        importClipboardImages(targetId, extraction.items)
      ).catch(reportCurrentPasteError);
    } catch (cause) {
      reportCurrentPasteError(cause);
    }
  };
  // dnd-kit invokes onDragEnd before its announcement monitor, which omits delta.
  const dragEndProjection = useRef<{
    activeId: NoteId;
    overId: NoteId | null;
    projection: PaneDragProjection | null;
  } | null>(null);
  const measureDragOverlay = useCallback(
    (overlayNode: HTMLElement) => {
      const sourceNode = Array.from(
        dropSurfaceRef.current?.querySelectorAll<HTMLElement>(
          "[data-outline-id]"
        ) ?? []
      ).find((node) => node.dataset.outlineId === activeDragId);
      return (sourceNode ?? overlayNode).getBoundingClientRect();
    },
    [activeDragId]
  );
  const detectOutlineCollisions = useCallback<CollisionDetection>((args) => {
    if (args.pointerCoordinates === null) {
      pointerDropBoundaryRef.current = null;
      githubProjectionDropRef.current = null;
      return closestCenter(args);
    }

    const activeId = String(args.active.id);
    const session = outlineDragSessionRef.current;
    const prepared =
      session?.kind === "selected-ready"
        ? session.prepared
        : session?.kind === "selected-pending"
          ? session.preview
          : null;
    const selectedCount = prepared?.nodeIds.length ?? 1;
    const projectionTarget =
      activeId === GITHUB_NOTIFICATIONS_ROOT_ID || selectedCount !== 1
        ? undefined
        : args.droppableContainers.find((container) => {
            const data = container.data.current;
            const rect = args.droppableRects.get(container.id);
            return (
              data?.kind === "github-notification-projection" &&
              typeof data.serializedKey === "string" &&
              rect !== undefined &&
              args.pointerCoordinates!.x >= rect.left &&
              args.pointerCoordinates!.x < rect.right &&
              args.pointerCoordinates!.y >= rect.top &&
              args.pointerCoordinates!.y < rect.bottom
            );
          });
    if (projectionTarget) {
      pointerDropBoundaryRef.current = null;
      githubProjectionDropRef.current = {
        activeId,
        serializedKey: projectionTarget.data.current!.serializedKey as string
      };
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          ({ id }) => id === projectionTarget.id
        )
      });
    }
    githubProjectionDropRef.current = null;
    const measuredRows = structuralRowsRef.current.flatMap((row) => {
      const dragged =
        prepared !== null
          ? preparedOutlineSelectionDragContainsNode(prepared, row.id)
          : row.id === activeId || row.ancestorIds.includes(activeId);
      const rect = args.droppableRects.get(row.id);
      return dragged || !rect
        ? []
        : [{ id: row.id, top: rect.top, bottom: rect.bottom }];
    });
    const boundary = resolveOutlinePointerBoundary(
      args.pointerCoordinates.y,
      measuredRows
    );
    pointerDropBoundaryRef.current = { activeId, ...boundary };
    if (boundary.overId === null) {
      return [];
    }
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        ({ id }) => String(id) === boundary.overId
      )
    });
  }, []);
  const sensors = useSensors(
    useSensor(PointerSensor, pointerSensorOptions),
    useSensor(KeyboardSensor, keyboardSensorOptions)
  );

  // Finder image drops stay on the Tauri boundary: browser DragEvents cannot
  // provide durable native paths or vault-backed storage for this import path.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void | Promise<void>) | undefined;
    const disposeSubscription = (nextUnlisten: () => void | Promise<void>) => {
      try {
        void Promise.resolve(nextUnlisten()).catch(() => {});
      } catch {
        // Native subscription teardown is best-effort during React cleanup.
      }
    };
    const clearPreview = () => {
      imageDropPathsRef.current = [];
      imageDropTargetIdRef.current = null;
      setImageDropTargetId(null);
      setImageDropPreview(null);
    };
    const updateDropTarget = (targetId: NoteId | null) => {
      imageDropTargetIdRef.current = targetId;
      setImageDropTargetId(targetId);
    };
    const targetFromEvent = (
      event: Extract<NotesNativeImageDropEvent, { position: unknown }>
    ) => {
      const surface = dropSurfaceRef.current;
      return surface
        ? attachmentTargetFromPoint(
            surface,
            event.position,
            imageDropFallbackTargetIdRef.current
          )
        : null;
    };
    const reportDropError = (cause: unknown) => {
      if (disposed) return;
      const detail = cause instanceof Error ? cause.message : String(cause);
      setImageIngestError({
        label: "Image drop failed",
        message: `Image drop failed: ${detail}`
      });
    };
    const listener = (event: NotesNativeImageDropEvent) => {
      if (disposed) return;
      if (!imageDropAvailableRef.current) {
        clearPreview();
        return;
      }
      if (event.type === "leave") {
        clearPreview();
        return;
      }
      const surface = dropSurfaceRef.current;
      if (!surface || surface.closest("[hidden]")) {
        clearPreview();
        return;
      }
      if (event.type === "enter") {
        imageDropPathsRef.current = event.paths;
        setImageIngestError(null);
        setImageDropPreview(
          event.paths.length > 0
            ? { paths: event.paths, position: event.position }
            : null
        );
        updateDropTarget(
          event.paths.length > 0 ? targetFromEvent(event) : null
        );
        return;
      }
      if (event.type === "over") {
        setImageDropPreview(
          imageDropPathsRef.current.length > 0
            ? {
                paths: imageDropPathsRef.current,
                position: event.position
              }
            : null
        );
        updateDropTarget(
          imageDropPathsRef.current.length > 0 ? targetFromEvent(event) : null
        );
        return;
      }

      const targetId =
        event.paths.length > 0
          ? targetFromEvent(event) ?? imageDropTargetIdRef.current
          : null;
      clearPreview();
      setImageIngestError(null);
      const importDroppedImagePaths = importDroppedImagePathsRef.current;
      if (!targetId || !importDroppedImagePaths) return;
      try {
        void importDroppedImagePaths(targetId, event.paths).catch(reportDropError);
      } catch (cause) {
        reportDropError(cause);
      }
    };

    void attachmentUi.subscribeToImageDrop(listener).then(
      (nextUnlisten) => {
        if (disposed) {
          disposeSubscription(nextUnlisten);
          return;
        }
        unlisten = nextUnlisten;
      },
      (cause) => {
        if (disposed) return;
        clearPreview();
        reportDropError(cause);
      }
    );

    return () => {
      disposed = true;
      imageDropPathsRef.current = [];
      if (unlisten) disposeSubscription(unlisten);
    };
  }, [attachmentUi]);

  useEffect(() => {
    const featureSlot = contentRef.current?.closest<HTMLElement>(
      ".feature-pane-slot"
    );
    if (!featureSlot || typeof MutationObserver === "undefined") return;

    const clearWhenHidden = () => {
      if (!featureSlot.hidden) return;
      imageDropPathsRef.current = [];
      setImageDropTargetId(null);
      setImageDropPreview(null);
    };
    clearWhenHidden();
    const observer = new MutationObserver(clearWhenHidden);
    observer.observe(featureSlot, {
      attributes: true,
      attributeFilter: ["hidden"]
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (imageDropAvailable) return;
    imageDropPathsRef.current = [];
    setImageDropTargetId(null);
    setImageDropPreview(null);
  }, [imageDropAvailable]);

  // Global Notes shortcuts are active only while this mounted pane is visible.
  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.key === "Process" ||
        contentRef.current?.closest("[hidden]")
      ) {
        return;
      }
      const target = event.target;
      const editable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (!editable) {
        const historyShortcut = resolveNotesHistoryShortcut({
          key: event.key,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          isComposing: event.isComposing,
          platform: detectOutlineShortcutPlatform()
        });
        if (historyShortcut) {
          event.preventDefault();
          void actions[historyShortcut]?.();
          return;
        }
      }
      if (event.key.toLowerCase() !== "k") {
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      setQuickJumpOpen(true);
    };
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, [actions]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const publishWidth = (
      measuredWidth = content.getBoundingClientRect().width
    ) => {
      const initialMaxDisplayWidth = Math.floor(
        Math.min(measuredWidth, window.innerWidth)
      );
      actions.setImageImportMaxDisplayWidth(
        Number.isSafeInteger(initialMaxDisplayWidth) &&
          initialMaxDisplayWidth > 0
          ? initialMaxDisplayWidth
          : null
      );
    };

    publishWidth();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            const entry = entries.find(({ target }) => target === content);
            publishWidth(entry?.contentRect.width);
          });
    resizeObserver?.observe(content);
    const handleWindowResize = () => publishWidth();
    window.addEventListener("resize", handleWindowResize);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", handleWindowResize);
      actions.setImageImportMaxDisplayWidth(null);
    };
  }, [actions]);
  // Recomputing the visible-row projection on every render (including draft
  // keystrokes) would hand each row a fresh `ancestorGuideDepths` array and
  // defeat OutlineNodeRow's memo. Memoizing keyed on the structural inputs keeps
  // the row objects referentially stable across keystrokes (which only touch the
  // drafts slice, never `state`).
  const allStructuralRows = useMemo(
    () =>
      flattenVisibleOutlineRows(
        state,
        state.zoomRootId,
        locallyExpandedNodeIds
      ),
    [state, locallyExpandedNodeIds]
  );
  const structuralRows = useMemo(
    () =>
      showCompleted
        ? allStructuralRows
        : hideCompletedSubtrees(
            allStructuralRows,
            state.nodesById,
            state.zoomRootId
          ),
    [allStructuralRows, showCompleted, state.nodesById, state.zoomRootId]
  );
  structuralRowsRef.current = structuralRows;
  const bodyRows = useMemo(
    () => deriveOutlineBodyRows(structuralRows, state.zoomRootId),
    [structuralRows, state.zoomRootId]
  );
  const githubPage = useMemo(
    () =>
      externalSources.pages.find(
        (page) => page.providerId === GITHUB_NOTIFICATIONS_PROVIDER_ID
      ) ?? null,
    [externalSources.pages]
  );
  const githubRoot = state.nodesById[GITHUB_NOTIFICATIONS_ROOT_ID];
  const githubZoomed = state.zoomRootId === GITHUB_NOTIFICATIONS_ROOT_ID;
  const persistedGithubCollapsedGroups =
    githubRoot?.pluginState?.collapsedGroups ?? EMPTY_GITHUB_COLLAPSED_GROUPS;
  const persistedGithubCollapsedGroupSet = useMemo(
    () => new Set(persistedGithubCollapsedGroups),
    [persistedGithubCollapsedGroups]
  );
  const [githubCollapsedGroupIntents, setGithubCollapsedGroupIntents] = useState<
    ReadonlyMap<string, { readonly generation: number; readonly collapsed: boolean }>
  >(() => new Map());
  const githubCollapsedGroupGenerationRef = useRef(new Map<string, number>());
  useEffect(() => {
    setGithubCollapsedGroupIntents((current) => {
      let next: Map<
        string,
        { readonly generation: number; readonly collapsed: boolean }
      > | null = null;
      for (const [dateKey, intent] of current) {
        if (persistedGithubCollapsedGroupSet.has(dateKey) === intent.collapsed) {
          if (next === null) next = new Map(current);
          next.delete(dateKey);
        }
      }
      return next ?? current;
    });
  }, [persistedGithubCollapsedGroupSet]);
  const githubCollapsedGroups = useMemo(
    () => {
      const next = new Set(persistedGithubCollapsedGroupSet);
      githubCollapsedGroupIntents.forEach(({ collapsed }, dateKey) => {
        if (collapsed) next.add(dateKey);
        else next.delete(dateKey);
      });
      return next;
    },
    [githubCollapsedGroupIntents, persistedGithubCollapsedGroupSet]
  );
  const githubProjectionNow = useMemo(
    () => new Date(externalSources.projectionNowMs ?? Date.now()),
    [externalSources.projectionNowMs]
  );
  const githubProjection = useMemo(
    () =>
      projectGithubNotificationsOutline({
        workspace: state,
        page: githubPage,
        showCompleted,
        now: githubProjectionNow,
        locallyExpandedNodeIds,
        collapsedGroups: githubCollapsedGroups
      }),
    [
      githubPage,
      githubProjectionNow,
      githubCollapsedGroups,
      locallyExpandedNodeIds,
      showCompleted,
      state
    ]
  );
  const githubProjectionRef = useRef(githubProjection);
  githubProjectionRef.current = githubProjection;
  const lastGithubEditorFocusRef =
    useRef<GithubEditorFocusKey | null>(null);
  const previousGithubFocusOrderRef = useRef(
    githubProjection.editorFocusKeys
  );
  const githubEditorElement = useCallback(
    (key: GithubEditorFocusKey): HTMLTextAreaElement | undefined => {
      const editors = Array.from(
        contentRef.current?.querySelectorAll<HTMLTextAreaElement>(
          ".notes-external-children textarea"
        ) ?? []
      );
      return (
        key.kind === "stored"
          ? editors.find(
              (candidate) =>
                candidate.dataset.githubEditorNodeId === key.nodeId &&
                candidate.dataset.githubEditorField === key.field
            )
          : editors.find(
              (candidate) =>
                candidate.dataset.githubEditorKey === key.key &&
                candidate.dataset.githubEditorField === key.field
            )
      );
    },
    []
  );
  const focusGithubEditor = useCallback(
    (key: GithubEditorFocusKey): boolean => {
      const editor = githubEditorElement(key);
      editor?.focus();
      return editor !== undefined;
    },
    [githubEditorElement]
  );
  useLayoutEffect(() => {
    const previous = previousGithubFocusOrderRef.current;
    previousGithubFocusOrderRef.current =
      githubProjection.editorFocusKeys;
    const focused = lastGithubEditorFocusRef.current;
    if (focused === null) {
      return;
    }
    const stillVisible = githubEditorElement(focused) !== undefined;
    if (stillVisible) {
      return;
    }
    if (
      document.activeElement !== null &&
      document.activeElement !== document.body
    ) {
      return;
    }
    const fallback = resolveGithubEditorFocusFallback(
      previous,
      githubProjection.editorFocusKeys,
      focused
    );
    if (fallback && focusGithubEditor(fallback)) {
      lastGithubEditorFocusRef.current = fallback;
      return;
    }
    const rootActivator =
      contentRef.current?.querySelector<HTMLElement>(
        `[data-outline-id="${GITHUB_NOTIFICATIONS_ROOT_ID}"] ` +
          "[data-sortable-activator]"
      ) ?? null;
    if (rootActivator) {
      rootActivator.focus();
    } else {
      contentRef.current
        ?.closest(".notes-outline")
        ?.querySelector<HTMLElement>(
          ".notes-breadcrumb-button[aria-current='page']"
        )
        ?.focus();
    }
    lastGithubEditorFocusRef.current = null;
  }, [
    focusGithubEditor,
    githubEditorElement,
    githubProjection.editorFocusKeys
  ]);
  const requestGithubProjection = externalSources.requestGithubProjection;
  const githubProjectionRequested = githubProjectionLeaseRequested({
    githubRootId: GITHUB_NOTIFICATIONS_ROOT_ID,
    libraryView,
    zoomRootId: state.zoomRootId,
    githubRoot
  });
  useEffect(() => {
    if (requestGithubProjection === undefined) return;
    requestGithubProjection(githubProjectionRequested);
    return () => requestGithubProjection(false);
  }, [githubProjectionRequested, requestGithubProjection]);
  const refreshMaterializedGithubNotificationsAction =
    actions.refreshMaterializedGithubNotifications;
  const setGithubGroupCollapsedAction = actions.setGithubGroupCollapsed;
  const refreshMaterializedGithubNotificationsActionRef = useRef(
    refreshMaterializedGithubNotificationsAction
  );
  refreshMaterializedGithubNotificationsActionRef.current =
    refreshMaterializedGithubNotificationsAction;
  const githubProjectionNowRef = useRef(githubProjectionNow);
  githubProjectionNowRef.current = githubProjectionNow;
  const refreshMaterializedGithubNotifications = useCallback(
    async ({
      connectionId,
      webBaseUrl,
      items
    }: GithubMaterializedRefreshRequest): Promise<GithubMaterializedRefreshOutcome> => {
      return refreshMaterializedGithubNotificationsActionRef.current(
        items.map((item) =>
          githubNotificationSnapshot(
            item,
            connectionId,
            webBaseUrl,
            githubProjectionNowRef.current
          )
        )
      );
    },
    []
  );
  const registerGithubMaterializedRefresh =
    externalSources.registerGithubMaterializedRefresh;
  useEffect(() => {
    if (registerGithubMaterializedRefresh === undefined) {
      return;
    }
    return registerGithubMaterializedRefresh(
      refreshMaterializedGithubNotifications
    );
  }, [
    refreshMaterializedGithubNotifications,
    registerGithubMaterializedRefresh
  ]);
  const toggleGithubDateGroup = useCallback(
    (dateKey: string, collapsed: boolean) => {
      const generation =
        (githubCollapsedGroupGenerationRef.current.get(dateKey) ?? 0) + 1;
      githubCollapsedGroupGenerationRef.current.set(dateKey, generation);
      setGithubCollapsedGroupIntents((current) => {
        const next = new Map(current);
        next.set(dateKey, { generation, collapsed });
        return next;
      });
      const removeIntent = () => {
        setGithubCollapsedGroupIntents((current) => {
          if (current.get(dateKey)?.generation !== generation) return current;
          const next = new Map(current);
          next.delete(dateKey);
          return next;
        });
      };
      void setGithubGroupCollapsedAction(dateKey, collapsed).then(
        (outcome) => {
          if (outcome !== "committed") removeIntent();
        },
        removeIntent
      );
    },
    [setGithubGroupCollapsedAction]
  );
  const retryGithubNotifications = useCallback(() => {
    void externalSources
      .refresh(GITHUB_NOTIFICATIONS_PROVIDER_ID)
      .catch(() => undefined);
  }, [externalSources]);
  const createGithubNotificationSibling = useCallback(
    async (bullet: ExternalBullet) => {
      const snapshot = githubNotificationSnapshotFromBullet(bullet);
      if (snapshot === null) {
        return;
      }
      actions.clearSelection();
      await actions.materializeGithubNotification(snapshot, {
        kind: "sibling"
      });
    },
    [actions]
  );
  const importGithubNotificationChildren = useCallback(
    async (
      bullet: ExternalBullet,
      nodes: readonly NoteImportNode[]
    ) => {
      const snapshot = githubNotificationSnapshotFromBullet(bullet);
      if (snapshot === null) {
        return;
      }
      actions.clearSelection();
      await actions.materializeGithubNotification(snapshot, {
        kind: "children",
        nodes
      });
    },
    [actions]
  );
  const githubDescendantIds = useMemo(() => {
    const descendants = new Set<NoteId>();
    const pending = [
      ...(state.childIdsByParent[GITHUB_NOTIFICATIONS_ROOT_ID] ?? [])
    ];
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      if (descendants.has(nodeId)) {
        continue;
      }
      descendants.add(nodeId);
      pending.push(...(state.childIdsByParent[nodeId] ?? []));
    }
    return descendants;
  }, [state.childIdsByParent]);
  const ordinaryBodyRows = useMemo(
    () => bodyRows.filter((row) => !githubDescendantIds.has(row.id)),
    [bodyRows, githubDescendantIds]
  );
  const completedItemsHidden =
    !showCompleted &&
    allStructuralRows.length > structuralRows.length &&
    bodyRows.length === 0;
  const structuralVisibleIds = useMemo(
    () => structuralRows.map((row) => row.id),
    [structuralRows]
  );
  // Rows resolve prev/next-row neighbours (keyboard nav) through this stable
  // accessor instead of receiving the visible-id array by value — passing the
  // array as a prop would churn its identity every render and defeat row memo.
  // The ref keeps a live pointer so the callback identity never changes.
  const structuralVisibleIdsRef = useRef(structuralVisibleIds);
  structuralVisibleIdsRef.current = structuralVisibleIds;
  const getVisibleNodeIds = useCallback(
    () => structuralVisibleIdsRef.current,
    []
  );
  // Selection is a body-row concept. While zoomed, the page header remains in
  // the structural order for ordinary Arrow navigation and drag geometry, but
  // it must never become an invisible member of a selected range.
  const bodyVisibleIds = useMemo(() => {
    if (githubZoomed) {
      return [...githubProjection.selectableUserNodeIds];
    }
    const visibleIds: NoteId[] = [];
    for (const row of ordinaryBodyRows) {
      if (row.id === GITHUB_NOTIFICATIONS_ROOT_ID) {
        if (!row.isCollapsed) {
          visibleIds.push(...githubProjection.selectableUserNodeIds);
        }
      } else {
        visibleIds.push(row.id);
      }
    }
    return visibleIds;
  }, [
    githubProjection.selectableUserNodeIds,
    githubZoomed,
    ordinaryBodyRows
  ]);
  const sortableVisibleIds = useMemo(() => {
    if (githubZoomed) {
      return [...githubProjection.sortableIds];
    }
    const visibleIds: NoteId[] = [];
    for (const row of ordinaryBodyRows) {
      visibleIds.push(row.id);
      if (
        row.id === GITHUB_NOTIFICATIONS_ROOT_ID &&
        !row.isCollapsed
      ) {
        visibleIds.push(...githubProjection.sortableIds);
      }
    }
    return visibleIds;
  }, [githubProjection.sortableIds, githubZoomed, ordinaryBodyRows]);
  const bodyVisibleIdsRef = useRef(bodyVisibleIds);
  bodyVisibleIdsRef.current = bodyVisibleIds;
  const getSelectionVisibleNodeIds = useCallback(
    () => bodyVisibleIdsRef.current,
    []
  );
  const materializedSelectionIds = useMemo(
    () => selectionSubtreeIds(selection ?? null, bodyVisibleIds, state),
    [bodyVisibleIds, selection, state]
  );
  // Hand each memoized row only an atomic membership bit. Rows that stay in or
  // out of the range retain every prop identity across a selection update.
  const selectedIdSet = useMemo(
    () => new Set(materializedSelectionIds),
    [materializedSelectionIds]
  );
  // Rows read the live selection at keydown time (to extend the head) through
  // this stable accessor, mirroring getVisibleNodeIds — the row never subscribes
  // to the selection, so its memo is preserved.
  const selectionRef = useRef(selection ?? null);
  selectionRef.current = selection ?? null;
  const getSelection = useCallback(
    () => getLiveSelectionSnapshot?.().selection ?? selectionRef.current,
    [getLiveSelectionSnapshot]
  );
  const handleMouseSelectionPointerDownCapture = (
    event: ReactPointerEvent<HTMLOListElement>
  ): void => {
    mouseSelectionGestureRef.current = null;
    if (
      event.button !== 0 ||
      event.shiftKey ||
      isOutlineSelectionToggleModifier(event) ||
      !isOutlineSelectionTextSurface(event.target)
    ) {
      return;
    }
    const anchorId = rowIdFromPointerTarget(event.target);
    if (anchorId && bodyVisibleIdsRef.current.includes(anchorId)) {
      mouseSelectionGestureRef.current = {
        pointerId: event.pointerId,
        anchorId,
        promoted: false
      };
    }
  };
  const handleMouseSelectionPointerMoveCapture = (
    event: ReactPointerEvent<HTMLOListElement>
  ): void => {
    const gesture = mouseSelectionGestureRef.current;
    if (
      !gesture ||
      event.pointerId !== gesture.pointerId ||
      event.buttons !== 1 ||
      isOutlineSelectionInteractiveTarget(event.target)
    ) {
      return;
    }
    const targetRowId = rowIdFromPointerTarget(event.target);
    const currentRowId =
      targetRowId === gesture.anchorId
        ? rowIdFromPointerCoordinates(event.clientX, event.clientY) ?? targetRowId
        : targetRowId;
    if (
      !currentRowId ||
      !bodyVisibleIdsRef.current.includes(currentRowId) ||
      (!gesture.promoted && currentRowId === gesture.anchorId)
    ) {
      return;
    }
    if (!gesture.promoted) {
      window.getSelection()?.removeAllRanges();
      const active = document.activeElement;
      if (
        active instanceof HTMLTextAreaElement &&
        event.currentTarget.contains(active)
      ) {
        active.setSelectionRange(active.selectionStart, active.selectionStart);
        active.blur();
      }
      actions.setSelectionAnchor(gesture.anchorId);
      gesture.promoted = true;
    }
    actions.extendSelectionTo(currentRowId);
    event.preventDefault();
  };
  const provisionalSelectionSnapshot = useMemo(
    () =>
      deriveNotesSelectionActionSnapshot({
        selection: selection ?? null,
        visibleNodeIds: bodyVisibleIds,
        workspace: state,
        authoritativeWorkspace: libraryView === "all" ? state : undefined
      }),
    [bodyVisibleIds, libraryView, selection, state]
  );
  const currentPreparedAuthority =
    preparedSelectionAuthority &&
    exactNoteIds(
      preparedSelectionAuthority.selectedNodeIds,
      materializedSelectionIds
    ) &&
    isPreparedSelectionAuthorityCurrent?.(preparedSelectionAuthority)
      ? preparedSelectionAuthority
      : null;
  const selectionSnapshot = useMemo(
    () =>
      deriveNotesSelectionActionSnapshot({
        selection: selection ?? null,
        visibleNodeIds: bodyVisibleIds,
        workspace: state,
        authoritativeWorkspace:
          libraryView === "all"
            ? state
            : currentPreparedAuthority?.workspace
      }),
    [bodyVisibleIds, currentPreparedAuthority, libraryView, selection, state]
  );
  const currentSelectionDragContext =
    selectionDragContext &&
    selectionSnapshot &&
    selectionDragContext.ownership.authority.selectionRevision ===
      selectionRevision &&
    exactNoteIds(
      selectionDragContext.ownership.actionSnapshot.selectedNodeIds,
      selectionSnapshot.selectedNodeIds
    ) &&
    exactNoteIds(
      selectionDragContext.nodeIds,
      selectionSnapshot.structuralRootIds
    ) &&
    (isPreparedSelectionAuthorityCurrent?.(
      selectionDragContext.ownership.authority
    ) ?? false)
      ? selectionDragContext
      : null;
  selectionDragContextRef.current = currentSelectionDragContext;
  if (selectionSnapshot) {
    lastSelectionHeadRef.current = selectionSnapshot.selection.headId;
  }

  // The preparation API intentionally allows overlapping callers. This pane
  // adds latest-request ownership so a late result for an older visible range
  // can never hydrate the current toolbar.
  useEffect(() => {
    const requestId = ++selectionAuthorityRequestRef.current;
    setPreparedSelectionAuthority(null);
    setSelectionAuthorityFailureKey(null);
    if (
      !provisionalSelectionSnapshot ||
      materializedSelectionIds.length === 0 ||
      !prepareSelectionAuthority ||
      !isPreparedSelectionAuthorityCurrent
    ) {
      return;
    }
    const expectedIds = [...materializedSelectionIds];
    const expectedRevision = selectionRevision;
    void (async () => {
      if (!(await actions.flushAllDrafts())) {
        if (selectionAuthorityRequestRef.current === requestId) {
          setSelectionAuthorityFailureKey(selectionChooserLifecycleKey);
        }
        return;
      }
      if (
        selectionAuthorityRequestRef.current !== requestId ||
        selectionRevisionRef.current !== expectedRevision ||
        !exactNoteIds(selectionIdsRef.current, expectedIds)
      ) {
        return;
      }
      const prepared = await prepareSelectionAuthority(expectedIds);
      if (
        selectionAuthorityRequestRef.current === requestId &&
        selectionRevisionRef.current === expectedRevision &&
        exactNoteIds(selectionIdsRef.current, expectedIds) &&
        exactNoteIds(prepared.selectedNodeIds, expectedIds) &&
        prepared.selectionRevision === expectedRevision &&
        isPreparedSelectionAuthorityCurrent(prepared)
      ) {
        setPreparedSelectionAuthority(prepared);
        setSelectionAuthorityFailureKey(null);
      }
    })().catch(() => {
      if (selectionAuthorityRequestRef.current === requestId) {
        setSelectionAuthorityFailureKey(selectionChooserLifecycleKey);
      }
    });
  }, [
    actions,
    filteredDragAuthorityRetryNonce,
    isPreparedSelectionAuthorityCurrent,
    materializedSelectionIds,
    prepareSelectionAuthority,
    provisionalSelectionSnapshot,
    selectionChooserLifecycleKey,
    selectionRevision
  ]);

  const currentFilteredDragAuthority =
    libraryView !== "all" &&
    filteredDragAuthorityPreparation.authority &&
    (isPreparedSelectionAuthorityCurrent?.(
      filteredDragAuthorityPreparation.authority
    ) ?? false)
      ? filteredDragAuthorityPreparation.authority
      : null;
  const filteredDragPreflightRequired =
    libraryView !== "all" && !lifecycleReadOnly;
  const filteredDragAuthorityReady =
    !filteredDragPreflightRequired || currentFilteredDragAuthority !== null;
  const filteredDragAuthorityFailed =
    filteredDragPreflightRequired &&
    currentFilteredDragAuthority === null &&
    filteredDragAuthorityPreparation.status === "error";

  useEffect(() => {
    const requestId = ++filteredDragAuthorityRequestRef.current;
    setFilteredDragAuthorityPreparation({ status: "idle", authority: null });
    if (
      !filteredDragPreflightRequired ||
      deletingNotesData ||
      state.status === "loading" ||
      bodyVisibleIds.length === 0
    ) {
      return;
    }
    if (!prepareSelectionAuthority || !isPreparedSelectionAuthorityCurrent) {
      setFilteredDragAuthorityPreparation({ status: "error", authority: null });
      return;
    }
    if (currentPreparedAuthority) {
      setFilteredDragAuthorityPreparation({
        status: "ready",
        authority: currentPreparedAuthority
      });
      return;
    }
    if (materializedSelectionIds.length > 0) {
      setFilteredDragAuthorityPreparation({
        status:
          selectionAuthorityFailureKey === selectionChooserLifecycleKey
            ? "error"
            : "preparing",
        authority: null
      });
      return;
    }
    const seedId = bodyVisibleIds[0];
    setFilteredDragAuthorityPreparation({
      status: "preparing",
      authority: null
    });
    void prepareSelectionAuthority([seedId])
      .then((authority) => {
        if (
          filteredDragAuthorityRequestRef.current === requestId &&
          exactNoteIds(authority.selectedNodeIds, [seedId]) &&
          isPreparedSelectionAuthorityCurrent(authority)
        ) {
          setFilteredDragAuthorityPreparation({ status: "ready", authority });
        }
      })
      .catch(() => {
        if (filteredDragAuthorityRequestRef.current === requestId) {
          setFilteredDragAuthorityPreparation({
            status: "error",
            authority: null
          });
        }
      });
  }, [
    bodyVisibleIds,
    currentPreparedAuthority,
    deletingNotesData,
    filteredDragAuthorityRetryNonce,
    filteredDragPreflightRequired,
    isPreparedSelectionAuthorityCurrent,
    materializedSelectionIds.length,
    prepareSelectionAuthority,
    selectionAuthorityFailureKey,
    selectionChooserLifecycleKey,
    state
  ]);

  const selectionIdsRef = useRef(materializedSelectionIds);
  selectionIdsRef.current = materializedSelectionIds;
  const selectionRevisionRef = useRef(selectionRevision);
  selectionRevisionRef.current = selectionRevision;
  const stateRef = useRef(state);
  stateRef.current = state;
  const libraryViewRef = useRef(libraryView);
  libraryViewRef.current = libraryView;
  const currentPreparedAuthorityRef = useRef(currentPreparedAuthority);
  currentPreparedAuthorityRef.current = currentPreparedAuthority;
  const currentFilteredDragAuthorityRef = useRef(
    currentFilteredDragAuthority
  );
  currentFilteredDragAuthorityRef.current = currentFilteredDragAuthority;
  const protectedMoveNodeIds = useMemo(
    () =>
      protectedNotesMoveRootIds(
        currentFilteredDragAuthority?.workspace.nodesById ??
          currentPreparedAuthority?.workspace.nodesById ??
          state.nodesById
      ),
    [currentFilteredDragAuthority, currentPreparedAuthority, state.nodesById]
  );
  const projectionVisibilityRef = useRef({
    locallyExpandedNodeIds,
    showCompleted,
    zoomRootId: state.zoomRootId
  });
  projectionVisibilityRef.current = {
    locallyExpandedNodeIds,
    showCompleted,
    zoomRootId: state.zoomRootId
  };
  const getProjectedSelectionVisibleIds = useCallback(
    (projectedWorkspace: UseNotesWorkspaceResult["state"]): readonly NoteId[] => {
      const visibility = projectionVisibilityRef.current;
      const zoomRootId =
        visibility.zoomRootId !== null &&
        projectedWorkspace.nodesById[visibility.zoomRootId]
          ? visibility.zoomRootId
          : null;
      const allRows = flattenVisibleOutlineRows(
        projectedWorkspace,
        zoomRootId,
        visibility.locallyExpandedNodeIds
      );
      const rows = visibility.showCompleted
        ? allRows
        : hideCompletedSubtrees(
            allRows,
            projectedWorkspace.nodesById,
            zoomRootId
          );
      return deriveOutlineBodyRows(rows, zoomRootId).map((row) => row.id);
    },
    []
  );
  const focusBodyTitle = useCallback((nodeId: NoteId): void => {
    const row = Array.from(
      contentRef.current?.querySelectorAll<HTMLElement>("[data-outline-id]") ??
        []
    ).find((candidate) => candidate.dataset.outlineId === nodeId);
    row?.querySelector<HTMLTextAreaElement>("textarea.notes-node-title")?.focus();
  }, []);
  useEffect(() => {
    const retireMouseSelectionGesture = (event: globalThis.PointerEvent) => {
      const gesture = mouseSelectionGestureRef.current;
      if (gesture?.pointerId === event.pointerId) {
        mouseSelectionGestureRef.current = null;
        // Promotion blurred the editor to stop the browser's native text
        // selection from fighting the outline drag. Hand focus back to the
        // selection head once the drag ends so the state matches a
        // keyboard-built selection — otherwise block-move shortcuts and
        // native copy/cut (both bound inside the pane subtree) never fire.
        // Deferred a task so the browser's trailing click (dispatched after
        // pointerup on the same pointer sequence) still observes the blurred
        // state and stays swallowed — e.g. an image atom click must not
        // restore its native range from a drag's residual click.
        if (gesture.promoted && event.type === "pointerup") {
          window.setTimeout(() => {
            const headId = lastSelectionHeadRef.current;
            if (headId !== null) {
              focusBodyTitle(headId);
            }
          }, 0);
        }
      }
    };
    window.addEventListener("pointerup", retireMouseSelectionGesture, true);
    window.addEventListener("pointercancel", retireMouseSelectionGesture, true);
    return () => {
      window.removeEventListener("pointerup", retireMouseSelectionGesture, true);
      window.removeEventListener(
        "pointercancel",
        retireMouseSelectionGesture,
        true
      );
    };
  }, [focusBodyTitle]);
  const writeSelectionClipboard = useCallback(
    (text: string) =>
      writeNotesClipboardText(text, {
        clipboard: navigator.clipboard,
        ClipboardItem:
          typeof ClipboardItem === "undefined" ? undefined : ClipboardItem,
        Blob: typeof Blob === "undefined" ? undefined : Blob
      }),
    []
  );
  const getLiveSelectionActionSnapshot = useCallback(() => {
    const live = getLiveSelectionSnapshot?.() ?? {
      selection: selectionRef.current,
      revision: selectionRevisionRef.current
    };
    const visibleNodeIds = bodyVisibleIdsRef.current;
    const selectedNodeIds = selectionSubtreeIds(
      live.selection,
      visibleNodeIds,
      stateRef.current
    );
    const prepared = currentPreparedAuthorityRef.current;
    const authoritativeWorkspace =
      libraryViewRef.current === "all"
        ? stateRef.current
        : prepared &&
            prepared.selectionRevision === live.revision &&
            exactNoteIds(prepared.selectedNodeIds, selectedNodeIds) &&
            (isPreparedSelectionAuthorityCurrent?.(prepared) ?? false)
          ? prepared.workspace
          : undefined;
    return deriveNotesSelectionActionSnapshot({
      selection: live.selection,
      visibleNodeIds,
      workspace: stateRef.current,
      authoritativeWorkspace
    });
  }, [getLiveSelectionSnapshot, isPreparedSelectionAuthorityCurrent]);
  const selectionRouter = useNotesSelectionCommandRouter({
    getSnapshot: getLiveSelectionActionSnapshot,
    getSelectionRevision: () =>
      getLiveSelectionSnapshot?.().revision ?? selectionRevisionRef.current,
    getNavigationVersion: () => actions.getNavigationVersion?.() ?? 0,
    getVisibleNodeIds: getProjectedSelectionVisibleIds,
    flushDrafts: actions.flushAllDrafts,
    prepareAuthority: (nodeIds) => {
      const cached = currentPreparedAuthorityRef.current;
      if (
        cached &&
        exactNoteIds(cached.selectedNodeIds, nodeIds) &&
        (isPreparedSelectionAuthorityCurrent?.(cached) ?? false)
      ) {
        return Promise.resolve(cached);
      }
      if (!prepareSelectionAuthority) {
        return Promise.reject(new Error("Selection authority is unavailable."));
      }
      return prepareSelectionAuthority(nodeIds);
    },
    isAuthorityCurrent: (authority) =>
      isPreparedSelectionAuthorityCurrent?.(authority) ?? false,
    applyBatch: async (authority, op, options) => {
      if (!applyPreparedSelectionBatch) {
        return Promise.reject(new Error("Selection batch actions are unavailable."));
      }
      const settlement = await applyPreparedSelectionBatch(
        authority,
        op,
        options
      );
      const expandNodeId = options?.expandNodeId;
      if (
        expandNodeId !== undefined &&
        settlement.projectedWorkspace?.nodesById[expandNodeId]?.isCollapsed
      ) {
        // The workspace command installs this local expansion before it
        // returns, but React has not rendered the new hook state yet. Publish
        // the same projection to the pane ref synchronously so the router's
        // immediate endpoint-visibility check retains the moved selection.
        const visibility = projectionVisibilityRef.current;
        if (!visibility.locallyExpandedNodeIds.has(expandNodeId)) {
          const locallyExpandedNodeIds = new Set(
            visibility.locallyExpandedNodeIds
          );
          locallyExpandedNodeIds.add(expandNodeId);
          projectionVisibilityRef.current = {
            ...visibility,
            locallyExpandedNodeIds
          };
        }
      }
      return settlement;
    },
    replaceSelection: (nextSelection, expectedRevision) =>
      actions.replaceSelection?.(nextSelection, expectedRevision) ?? false,
    focusNode: focusBodyTitle,
    writeClipboard: writeSelectionClipboard
  });
  const executeSelectionCommand = selectionRouter.execute;
  const clearSelectionRouterFeedback = selectionRouter.clearFeedback;
  const selectionFeedbackError =
    selectionChooserFeedback.error ??
    selectionRouter.error ??
    selectionClipboardError;
  const { publish: publishNotesFeedback, clear: clearNotesFeedback } =
    useNotesFeedback();
  const publishFilteredDragPreflightFeedback = useCallback(() => {
    const selectionAuthorityFailed =
      selectionAuthorityFailureKey === selectionChooserLifecycleKey;
    const selectionContextFailed =
      selectionDragContextFailureKey === selectionChooserLifecycleKey;
    if (
      selectionContextFailed &&
      !selectionAuthorityFailed &&
      !filteredDragAuthorityFailed
    ) {
      setSelectionDragContextFailureKey(null);
      setSelectionDragContextRetryNonce((nonce) => nonce + 1);
    } else if (selectionAuthorityFailed || filteredDragAuthorityFailed) {
      setSelectionAuthorityFailureKey(null);
      setFilteredDragAuthorityPreparation({
        status: "preparing",
        authority: null
      });
      setFilteredDragAuthorityRetryNonce((nonce) => nonce + 1);
    }
    publishNotesFeedback({
      kind: "error",
      message: filteredDragPreparingMessage
    });
  }, [
    filteredDragAuthorityFailed,
    publishNotesFeedback,
    selectionAuthorityFailureKey,
    selectionChooserLifecycleKey,
    selectionDragContextFailureKey
  ]);
  useEffect(() => {
    clearNotesFeedback();
    clearSelectionRouterFeedback();
  }, [clearNotesFeedback, clearSelectionRouterFeedback, selectionRevision]);
  useEffect(() => {
    if (selectionFeedbackError) {
      publishNotesFeedback({
        kind: "error",
        message: selectionFeedbackError
      });
    } else if (selectionRouter.status) {
      publishNotesFeedback({
        kind: "status",
        message: selectionRouter.status
      });
    }
  }, [
    publishNotesFeedback,
    selectionFeedbackError,
    selectionRouter.feedbackRevision,
    selectionRouter.status
  ]);
  const rejectDisabledSelectionOperation = useCallback(
    (operation: Parameters<typeof notesSelectionOperationDisabledReason>[0]) => {
      const reason = notesSelectionOperationDisabledReason(
        operation,
        selectionMutationDisabledReasonRef.current
      );
      if (reason === null) {
        return false;
      }
      setSelectionClipboardError(null);
      setSelectionChooserFeedback({ busy: false, error: reason });
      return true;
    },
    []
  );
  const executeGuardedSelectionCommand = useCallback(
    (...args: Parameters<typeof executeSelectionCommand>) => {
      if (rejectDisabledSelectionOperation(args[0].type)) {
        return Promise.resolve({
          outcome: "skipped" as const,
          mutationCommitted: false
        });
      }
      return executeSelectionCommand(...args);
    },
    [executeSelectionCommand, rejectDisabledSelectionOperation]
  );
  const invalidatePreparedSelectionClipboard =
    selectionRouter.invalidatePreparedClipboard;
  const selectionChooserAuthorityCurrent =
    selectionChooser === null ||
    (isPreparedSelectionAuthorityCurrent?.(
      selectionChooser.snapshot.ownership.authority
    ) ?? false);
  useLayoutEffect(() => {
    const lifecycleChanged =
      selectionChooserLifecycleRef.current !== selectionChooserLifecycleKey;
    const openAuthorityStale =
      selectionChooser !== null && !selectionChooserAuthorityCurrent;
    if (!lifecycleChanged && !openAuthorityStale) {
      return;
    }
    selectionChooserLifecycleRef.current = selectionChooserLifecycleKey;
    selectionChooserPreparationRequestRef.current += 1;
    selectionChooserPreparingRef.current = false;
    setSelectionChooser((current) => (current === null ? current : null));
    setSelectionChooserFeedback((current) =>
      current.busy || current.error
        ? { busy: false, error: null }
        : current
    );
    setSelectionClipboardError(null);
  }, [
    selectionChooser,
    selectionChooserAuthorityCurrent,
    selectionChooserLifecycleKey
  ]);
  const handleSelectionClipboardPreparationPending = useCallback(
    (intent: "copy" | "cut") => {
      const action = intent === "copy" ? "Copy" : "Cut";
      setSelectionClipboardError(
        `The selected items are still preparing for ${action}. Try again.`
      );
    },
    []
  );
  const selectionNativeClipboard = useMemo(
    () =>
      createNotesSelectionNativeClipboardController(
        {
          prepareClipboard: selectionRouter.prepareClipboard,
          commitPreparedClipboardEvent:
            selectionRouter.commitPreparedClipboardEvent,
          invalidatePreparedClipboard:
            selectionRouter.invalidatePreparedClipboard
        },
        {
          onPreparationPending: handleSelectionClipboardPreparationPending
        }
      ),
    [
      handleSelectionClipboardPreparationPending,
      selectionRouter.commitPreparedClipboardEvent,
      selectionRouter.invalidatePreparedClipboard,
      selectionRouter.prepareClipboard
    ]
  );
  const selectionClipboardReady =
    materializedSelectionIds.length > 0 &&
    selectionSnapshot?.eligibility.copy.eligible === true &&
    exactNoteIds(selectionSnapshot.selectedNodeIds, materializedSelectionIds) &&
    currentPreparedAuthority !== null;
  useEffect(() => {
    if (
      selectionClipboardReady &&
      !selectionRouter.busy &&
      !selectionChooserFeedback.busy &&
      !deletingNotesData
    ) {
      void selectionNativeClipboard.refresh();
      return;
    }
    selectionNativeClipboard.invalidate();
  }, [
    bodyVisibleIds,
    deletingNotesData,
    draftsByNodeId,
    libraryView,
    selectionChooserFeedback.busy,
    selectionClipboardReady,
    selectionNativeClipboard,
    selectionRevision,
    selectionRouter.busy,
    state,
    vaultRoot
  ]);
  useEffect(() => {
    selectionClipboardLifecycleRef.current += 1;
    return () => {
      const cleanupGeneration = selectionClipboardLifecycleRef.current + 1;
      selectionClipboardLifecycleRef.current = cleanupGeneration;
      queueMicrotask(() => {
        if (
          selectionClipboardLifecycleRef.current === cleanupGeneration
        ) {
          selectionNativeClipboard.dispose();
        }
      });
    };
  }, [selectionNativeClipboard]);
  const handleSelectionClipboardEvent = useCallback(
    (
      intent: "copy" | "cut",
      event: ClipboardEvent<HTMLDivElement>
    ): void => {
      const textControlTarget =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement;
      if (
        !textControlTarget &&
        typeof window.getSelection === "function" &&
        window.getSelection()?.isCollapsed === false
      ) {
        return;
      }
      const hasOutlineSelection =
        selectionSubtreeIds(
          getSelection(),
          bodyVisibleIdsRef.current,
          stateRef.current
        ).length > 0;
      const hasNativeTextSelection =
        textControlTarget &&
        (event.target as HTMLInputElement | HTMLTextAreaElement)
          .selectionStart !==
          (event.target as HTMLInputElement | HTMLTextAreaElement).selectionEnd;
      if (selectionNativeClipboard.isCompositionActive()) {
        return;
      }
      if (
        hasOutlineSelection &&
        !hasNativeTextSelection &&
        rejectDisabledSelectionOperation(intent)
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const options = {
        allowNonTextTarget: !textControlTarget,
        claimUnprepared: hasOutlineSelection
      };
      const outcome =
        intent === "copy"
          ? selectionNativeClipboard.handleCopy(event, options)
          : selectionNativeClipboard.handleCut(event, options);
      if (outcome.kind !== "unowned") {
        event.stopPropagation();
      }
      if (outcome.kind === "claimed") {
        clearSelectionRouterFeedback();
      }
      if (outcome.kind === "committed") {
        setSelectionClipboardError(null);
      }
    },
    [
      clearSelectionRouterFeedback,
      getSelection,
      rejectDisabledSelectionOperation,
      selectionNativeClipboard
    ]
  );
  const handleSelectionCopyCapture = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) =>
      handleSelectionClipboardEvent("copy", event),
    [handleSelectionClipboardEvent]
  );
  const handleSelectionCutCapture = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) =>
      handleSelectionClipboardEvent("cut", event),
    [handleSelectionClipboardEvent]
  );
  const handleGithubEditorFocusCapture = useCallback(
    (event: ReactFocusEvent<HTMLDivElement>): void => {
      const target =
        event.target instanceof HTMLElement ? event.target : null;
      const externalRow = target?.closest<HTMLElement>(
        "[data-external-bullet-key]"
      );
      const storedRow = target?.closest<HTMLElement>("[data-outline-id]");
      if (
        target === null ||
        target.closest(".notes-external-children") === null
      ) {
        return;
      }
      const field =
        target instanceof HTMLTextAreaElement &&
        target.dataset.githubEditorField === "note"
          ? "note"
          : target.closest(".notes-external-note-field")
            ? "note"
            : "title";
      const nodeId =
        target.dataset.githubEditorNodeId ??
        externalRow?.dataset.githubEditorNodeId ??
        storedRow?.dataset.outlineId;
      const key =
        target.dataset.githubEditorKey ??
        externalRow?.dataset.githubEditorKey;
      if (!nodeId && !key) {
        return;
      }
      lastGithubEditorFocusRef.current = nodeId
        ? { kind: "stored", nodeId, field }
        : key
          ? { kind: "provider", key, field }
          : null;
      if (externalRow !== null) {
        actions.clearSelection();
      }
    },
    [actions]
  );
  const handleGithubCompositeKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): boolean => {
      const target =
        event.target instanceof HTMLTextAreaElement ? event.target : null;
      if (
        target === null ||
        target.closest(".notes-external-children") === null ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.nativeEvent.isComposing ||
        event.nativeEvent.key === "Process"
      ) {
        return false;
      }
      const field =
        target.dataset.githubEditorField === "note" ? "note" : "title";
      const resolution = resolveExternalEditorKey({
        field,
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing,
        repeat: event.repeat,
        selectionStart: target.selectionStart,
        selectionEnd: target.selectionEnd,
        value: target.value
      });
      if (resolution?.type !== "focus") {
        return false;
      }
      const nodeId = target.dataset.githubEditorNodeId;
      const key = target.dataset.githubEditorKey;
      const current: GithubEditorFocusKey | null = nodeId
        ? { kind: "stored", nodeId, field }
        : key
          ? { kind: "provider", key, field }
          : null;
      const currentIndex =
        current === null
          ? -1
          : githubProjection.editorFocusKeys.findIndex(
              (candidate) =>
                candidate.kind === current.kind &&
                candidate.field === current.field &&
                (candidate.kind === "stored"
                  ? current.kind === "stored" &&
                    candidate.nodeId === current.nodeId
                  : current.kind === "provider" &&
                    candidate.key === current.key)
            );
      if (currentIndex < 0) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      const direction = resolution.direction === "previous" ? -1 : 1;
      for (
        let index = currentIndex + direction;
        index >= 0 && index < githubProjection.editorFocusKeys.length;
        index += direction
      ) {
        const next = githubEditorElement(
          githubProjection.editorFocusKeys[index]!
        );
        if (next) {
          next.focus();
          if (resolution.edge === "end") {
            next.setSelectionRange(next.value.length, next.value.length);
          } else if (resolution.edge === "start") {
            next.setSelectionRange(0, 0);
          }
          break;
        }
      }
      return true;
    },
    [githubEditorElement, githubProjection.editorFocusKeys]
  );
  const handleSelectionClipboardKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (handleGithubCompositeKeyDownCapture(event)) {
        return;
      }
      const editor =
        event.target instanceof HTMLTextAreaElement
          ? event.target.closest<HTMLElement>("[data-outline-id]")
          : null;
      if (
        event.key === "F6" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.repeat &&
        !event.nativeEvent.isComposing &&
        editor !== null &&
        selectionToolbarRef.current !== null
      ) {
        event.preventDefault();
        event.stopPropagation();
        selectionToolbarRef.current.focus();
        return;
      }
      selectionNativeClipboard.handleKeyDown(event);
    },
    [handleGithubCompositeKeyDownCapture, selectionNativeClipboard]
  );
  const handleSelectionClipboardKeyUpCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      selectionNativeClipboard.handleKeyUp(event);
    },
    [selectionNativeClipboard]
  );
  const handleSelectionCompositionStartCapture = useCallback((): void => {
    selectionNativeClipboard.handleCompositionStart();
    actions.setOutlineCompositionActive?.(true);
  }, [actions, selectionNativeClipboard]);
  const handleSelectionCompositionEndCapture = useCallback((): void => {
    selectionNativeClipboard.handleCompositionEnd();
    actions.setOutlineCompositionActive?.(false);
  }, [actions, selectionNativeClipboard]);
  useEffect(() => {
    const requestId = ++selectionDragContextRequestRef.current;
    setSelectionDragContext(null);
    setSelectionDragContextFailureKey(null);
    if (
      !selectionSnapshot ||
      !selectionSnapshot.eligibility.copy.eligible ||
      !currentPreparedAuthority ||
      !prepareSelectionAuthority ||
      !isPreparedSelectionAuthorityCurrent
    ) {
      if (
        selectionSnapshot &&
        selectionSnapshot.eligibility.copy.eligible &&
        (!prepareSelectionAuthority || !isPreparedSelectionAuthorityCurrent)
      ) {
        setSelectionDragContextFailureKey(selectionChooserLifecycleKey);
      }
      return;
    }
    const expectedRevision = selectionRevision;
    const expectedSelectedIds = [...selectionSnapshot.selectedNodeIds];
    const expectedRootIds = [...selectionSnapshot.structuralRootIds];
    if (expectedRootIds.length === 0) {
      return;
    }
    const installContext = (
      authority: NotesPreparedSelectionAuthority
    ): void => {
      const live = getLiveSelectionSnapshot?.() ?? {
        selection: selectionRef.current,
        revision: selectionRevisionRef.current
      };
      const liveSelectedIds = selectionSubtreeIds(
        live.selection,
        bodyVisibleIdsRef.current,
        stateRef.current
      );
      if (
        selectionDragContextRequestRef.current !== requestId ||
        live.revision !== expectedRevision ||
        !exactNoteIds(liveSelectedIds, expectedSelectedIds) ||
        authority.selectionRevision !== expectedRevision ||
        !exactNoteIds(authority.selectedNodeIds, expectedRootIds) ||
        !isPreparedSelectionAuthorityCurrent(authority)
      ) {
        return;
      }
      const actionSnapshot = deriveNotesSelectionActionSnapshot({
        selection: live.selection,
        visibleNodeIds: bodyVisibleIdsRef.current,
        workspace: stateRef.current,
        authoritativeWorkspace: authority.workspace
      });
      if (
        !actionSnapshot ||
        !exactNoteIds(actionSnapshot.selectedNodeIds, expectedSelectedIds) ||
        !exactNoteIds(actionSnapshot.structuralRootIds, expectedRootIds)
      ) {
        return;
      }
      setSelectionDragContext(Object.freeze({
        nodeIds: Object.freeze([...expectedRootIds]),
        ownership: Object.freeze({ actionSnapshot, authority })
      }));
      setSelectionDragContextFailureKey(null);
    };

    if (
      exactNoteIds(
        currentPreparedAuthority.selectedNodeIds,
        expectedRootIds
      )
    ) {
      installContext(currentPreparedAuthority);
      return;
    }

    void (async () => {
      if (!(await actions.flushAllDrafts())) {
        if (selectionDragContextRequestRef.current === requestId) {
          setSelectionDragContextFailureKey(selectionChooserLifecycleKey);
        }
        return;
      }
      if (
        selectionDragContextRequestRef.current !== requestId ||
        selectionRevisionRef.current !== expectedRevision
      ) {
        return;
      }
      installContext(await prepareSelectionAuthority(expectedRootIds));
    })().catch(() => {
      if (selectionDragContextRequestRef.current === requestId) {
        setSelectionDragContextFailureKey(selectionChooserLifecycleKey);
      }
    });
  }, [
    actions,
    currentPreparedAuthority,
    getLiveSelectionSnapshot,
    isPreparedSelectionAuthorityCurrent,
    prepareSelectionAuthority,
    selectionChooserLifecycleKey,
    selectionDragContextRetryNonce,
    selectionRevision,
    selectionSnapshot
  ]);
  useEffect(() => {
    if (!selection || materializedSelectionIds.length > 0) {
      return;
    }
    const live = getLiveSelectionSnapshot?.() ?? {
      selection: selectionRef.current,
      revision: selectionRevisionRef.current
    };
    if (
      !live.selection ||
      live.revision !== selectionRevision ||
      live.selection.anchorId !== selection.anchorId ||
      live.selection.headId !== selection.headId
    ) {
      return;
    }
    if (actions.replaceSelection?.(null, live.revision)) {
      invalidatePreparedSelectionClipboard();
      selectionChooserPreparationRequestRef.current += 1;
      selectionChooserPreparingRef.current = false;
      setSelectionChooser(null);
      setSelectionChooserFeedback({ busy: false, error: null });
    }
  }, [
    actions,
    getLiveSelectionSnapshot,
    invalidatePreparedSelectionClipboard,
    materializedSelectionIds.length,
    selection,
    selectionRevision
  ]);
  const requestSelectionChooser = useCallback(
    async (
      kind: "move" | "tags",
      origin: SelectionChooserRequestOrigin
    ): Promise<void> => {
      const operation = kind === "move" ? "moveTo" : "tags";
      if (rejectDisabledSelectionOperation(operation)) {
        return;
      }
      if (selectionChooserPreparingRef.current) {
        return;
      }
      selectionChooserPreparingRef.current = true;
      const requestId = ++selectionChooserPreparationRequestRef.current;
      setSelectionChooser(null);
      setSelectionChooserFeedback({ busy: true, error: null });
      const failCurrent = (error: string) => {
        if (selectionChooserPreparationRequestRef.current === requestId) {
          setSelectionChooserFeedback({ busy: true, error });
          if (origin === "menu") {
            queueMicrotask(() => {
              if (
                selectionChooserPreparationRequestRef.current === requestId
              ) {
                const headId = lastSelectionHeadRef.current;
                if (headId !== null) {
                  focusBodyTitle(headId);
                }
              }
            });
          }
        }
      };
      try {
        const openingSnapshot = getLiveSelectionActionSnapshot();
        const openingLive = getLiveSelectionSnapshot?.() ?? {
          selection: selectionRef.current,
          revision: selectionRevisionRef.current
        };
        const targetIds =
          kind === "move"
            ? openingSnapshot?.eligibility.moveTo.eligible
              ? openingSnapshot.eligibility.moveTo.nodeIds
              : []
            : (openingSnapshot?.selectedNodeIds ?? []);
        if (!openingSnapshot || targetIds.length === 0) {
          failCurrent("The selected range is no longer available.");
          return;
        }
        if (!prepareSelectionAuthority || !isPreparedSelectionAuthorityCurrent) {
          failCurrent("Couldn't open the selection chooser. Try again.");
          return;
        }
        if (!(await actions.flushAllDrafts())) {
          failCurrent("Save pending changes before continuing.");
          return;
        }
        if (selectionChooserPreparationRequestRef.current !== requestId) {
          return;
        }
        const afterFlushLive = getLiveSelectionSnapshot?.() ?? {
          selection: selectionRef.current,
          revision: selectionRevisionRef.current
        };
        if (afterFlushLive.revision !== openingLive.revision) {
          failCurrent("The selection changed. Try again.");
          return;
        }
        const authority = await prepareSelectionAuthority(targetIds);
        if (selectionChooserPreparationRequestRef.current !== requestId) {
          return;
        }
        const currentLive = getLiveSelectionSnapshot?.() ?? {
          selection: selectionRef.current,
          revision: selectionRevisionRef.current
        };
        if (
          currentLive.revision !== openingLive.revision ||
          authority.selectionRevision !== openingLive.revision ||
          !exactNoteIds(authority.selectedNodeIds, targetIds) ||
          !isPreparedSelectionAuthorityCurrent(authority)
        ) {
          failCurrent("The selection changed. Try again.");
          return;
        }
        const actionSnapshot = deriveNotesSelectionActionSnapshot({
          selection: currentLive.selection,
          visibleNodeIds: bodyVisibleIdsRef.current,
          workspace: stateRef.current,
          authoritativeWorkspace: authority.workspace
        });
        if (
          !actionSnapshot ||
          !exactNoteIds(
            kind === "move"
              ? actionSnapshot.structuralRootIds
              : actionSnapshot.selectedNodeIds,
            targetIds
          )
        ) {
          failCurrent("The selection changed. Try again.");
          return;
        }
        if (rejectDisabledSelectionOperation(operation)) {
          return;
        }
        const snapshot: SelectionChooserSnapshot = Object.freeze({
          nodeIds: Object.freeze([...targetIds]),
          ownership: Object.freeze({ actionSnapshot, authority })
        });
        setSelectionChooser(
          kind === "move"
            ? Object.freeze({ kind, snapshot })
            : Object.freeze({
                kind,
                snapshot,
                selectedTagUnion: selectedTagUnion(
                  authority.workspace,
                  targetIds
                )
              })
        );
      } catch {
        failCurrent("Couldn't open the selection chooser. Try again.");
      } finally {
        if (selectionChooserPreparationRequestRef.current === requestId) {
          selectionChooserPreparingRef.current = false;
          setSelectionChooserFeedback((current) => ({
            ...current,
            busy: false
          }));
        }
      }
    },
    [
      actions,
      focusBodyTitle,
      getLiveSelectionActionSnapshot,
      getLiveSelectionSnapshot,
      isPreparedSelectionAuthorityCurrent,
      prepareSelectionAuthority,
      rejectDisabledSelectionOperation
    ]
  );

  const executeSelectionAction = useCallback(
    async (action: NotesSelectionActionBarAction): Promise<void> => {
      if (rejectDisabledSelectionOperation(action)) {
        return;
      }
      setSelectionClipboardError(null);
      setSelectionChooserFeedback((current) =>
        current.error ? { ...current, error: null } : current
      );
      let intent: NotesSelectionCommandIntent | null = null;
      switch (action) {
        case "toggleComplete":
          intent = { type: "complete" };
          break;
        case "moveUp":
        case "moveDown":
        case "indent":
        case "outdent":
        case "duplicate":
        case "copy":
        case "cut":
        case "delete":
          intent = { type: action };
          break;
        case "moveTo":
          await requestSelectionChooser("move", "toolbar");
          return;
        case "tags":
          await requestSelectionChooser("tags", "toolbar");
          return;
      }
      if (intent) {
        await executeGuardedSelectionCommand(intent);
      }
    },
    [
      executeGuardedSelectionCommand,
      rejectDisabledSelectionOperation,
      requestSelectionChooser
    ]
  );
  const returnFocusToSelectionHead = useCallback(() => {
    const headId = lastSelectionHeadRef.current;
    if (headId !== null) {
      focusBodyTitle(headId);
    }
  }, [focusBodyTitle]);
  const selectionMenuState = useMemo<NotesBulletMenuSelectionState | null>(
    () =>
      selectionSnapshot
        ? {
            snapshot: selectionSnapshot,
            busy: selectionRouter.busy || selectionChooserFeedback.busy,
            mutationDisabledReason: selectionMutationDisabledReason
          }
        : null,
    [
      selectionMutationDisabledReason,
      selectionRouter.busy,
      selectionChooserFeedback.busy,
      selectionSnapshot
    ]
  );
  const selectionMenuStateRef = useRef<NotesBulletMenuSelectionState | null>(
    selectionMenuState
  );
  // Preserve the last published non-null value through selected -> cleared
  // teardown. A portal subscriber can read once more before it unsubscribes.
  if (selectionMenuState) {
    selectionMenuStateRef.current = selectionMenuState;
  }
  const selectionMenuSubscribersRef = useRef(new Set<() => void>());
  const selectionMenuExecuteRef = useRef(executeSelectionAction);
  selectionMenuExecuteRef.current = executeSelectionAction;
  const selectionChooserHandoffRef = useRef<(chooser: "move" | "tags") => void>(
    () => undefined
  );
  selectionChooserHandoffRef.current = (chooser) => {
    void requestSelectionChooser(chooser, "menu");
  };
  const selectionMenuBridge = useMemo<NotesBulletMenuSelectionBridge>(
    () => ({
      // The bridge is only attached after the first non-null publication; the
      // cache is deliberately retained after detachment for portal teardown.
      getSnapshot: () => selectionMenuStateRef.current!,
      subscribe: (onStoreChange) => {
        selectionMenuSubscribersRef.current.add(onStoreChange);
        return () => selectionMenuSubscribersRef.current.delete(onStoreChange);
      },
      execute: (action) => selectionMenuExecuteRef.current(action),
      requestChooser: (chooser) =>
        selectionChooserHandoffRef.current(chooser)
    }),
    []
  );
  useLayoutEffect(() => {
    if (!selectionMenuState) {
      return;
    }
    for (const subscriber of selectionMenuSubscribersRef.current) {
      subscriber();
    }
  }, [selectionMenuState]);
  const tagSuggestions = useMemo<readonly NoteSearchTag[]>(
    () =>
      tagSummaries.map(({ prefix, normalizedTag, displayTag }) => ({
        prefix,
        normalizedTag,
        displayTag
      })),
    [tagSummaries]
  );
  const imageDropMarkerBoundary = useMemo<ImageDropMarkerBoundary | null>(() => {
    if (imageDropTargetId === null || imageDropTargetId === state.zoomRootId) {
      return null;
    }
    const targetRow = bodyRows.find((row) => row.id === imageDropTargetId);
    if (!targetRow) {
      return null;
    }
    return {
      afterId: targetRow.visibleDescendantEndId ?? targetRow.id,
      depth: targetRow.depth
    };
  }, [bodyRows, imageDropTargetId, state.zoomRootId]);
  const bodyDropPreview =
    dropPreview && state.zoomRootId !== null
      ? { ...dropPreview, depth: Math.max(0, dropPreview.depth - 1) }
      : dropPreview;
  const initialLoading = state.status === "loading" && state.rootIds.length === 0;
  const dragUnavailable =
    deletingNotesData ||
    lifecycleReadOnly ||
    state.status === "loading" ||
    bodyRows.length === 0;
  const promotePendingSelectionDrag = useCallback(
    (session: PaneDragSession): PaneDragSession => {
      if (session.kind !== "selected-pending") {
        return session;
      }
      const live = getLiveSelectionSnapshot?.() ?? {
        selection: selectionRef.current,
        revision: selectionRevisionRef.current
      };
      const selectedNodeIds = selectionSubtreeIds(
        live.selection,
        bodyVisibleIdsRef.current,
        stateRef.current
      );
      if (
        live.revision !== session.selectionRevision ||
        !exactNoteIds(selectedNodeIds, session.selectedNodeIds) ||
        !selectedNodeIds.includes(session.activeId)
      ) {
        return Object.freeze({
          kind: "selected-invalid",
          reason: "selection-authority-mismatch"
        });
      }
      const frozenContext = session.preparation.current;
      if (frozenContext === undefined) {
        return session;
      }
      if (
        frozenContext === null ||
        frozenContext.ownership.authority.selectionRevision !==
          session.selectionRevision ||
        !exactNoteIds(
          frozenContext.ownership.actionSnapshot.selectedNodeIds,
          session.selectedNodeIds
        ) ||
        !(isPreparedSelectionAuthorityCurrent?.(
          frozenContext.ownership.authority
        ) ?? false)
      ) {
        return Object.freeze({
          kind: "selected-invalid",
          reason: "selection-authority-mismatch"
        });
      }
      return startOutlineSelectionDragSession({
        activeId: session.activeId,
        selectedNodeIds: session.selectedNodeIds,
        rows: session.rows,
        order: {
          rootIds: frozenContext.ownership.authority.workspace.rootIds,
          childIdsByParent:
            frozenContext.ownership.authority.workspace.childIdsByParent,
          zoomRootId: session.zoomRootId
        },
        frozenContext
      });
    },
    [
      getLiveSelectionSnapshot,
      isPreparedSelectionAuthorityCurrent
    ]
  );
  const projectDrag = useCallback(
    (
      event: Pick<DragMoveEvent, "active" | "delta" | "over">
    ): PaneDragProjection | null => {
      const activeId = String(event.active.id);
      const pointerBoundary =
        pointerDropBoundaryRef.current?.activeId === activeId
          ? pointerDropBoundaryRef.current
          : null;
      if (
        dragUnavailable ||
        (pointerBoundary === null && !event.over) ||
        activeId === state.zoomRootId ||
        (activeDragId !== null && activeDragId !== activeId)
      ) {
        return null;
      }
      let session = outlineDragSessionRef.current;
      if (!session) {
        return null;
      }
      session = promotePendingSelectionDrag(session);
      outlineDragSessionRef.current = session;
      if (session.kind === "selected-pending") {
        const result =
          pointerBoundary === null
            ? projectPreparedOutlineSelectionDrop(
                session.preview,
                String(event.over!.id),
                event.delta.x,
                outlineIndentPx
              )
            : projectPreparedOutlineSelectionDropAtBoundary(
                session.preview,
                pointerBoundary.beforeId,
                event.delta.x,
                outlineIndentPx
              );
        return Object.freeze({
          kind: "selected-preview",
          prepared: session.preview,
          result
        });
      }
      if (session.kind === "selected-invalid") {
        return session;
      }
      if (session.kind === "selected-ready") {
        if (pointerBoundary !== null) {
          const result = projectPreparedOutlineSelectionDropAtBoundary(
            session.prepared,
            pointerBoundary.beforeId,
            event.delta.x,
            outlineIndentPx
          );
          if (result.kind === "invalid") {
            return Object.freeze({
              kind: "selected-invalid",
              reason: result.reason
            });
          }
          if (result.noOp) {
            return Object.freeze({
              kind: "selected-preview",
              prepared: session.prepared,
              result
            });
          }
          const { expandNodeId, ...target } = result.projection;
          return Object.freeze({
            kind: "selected-move",
            target: Object.freeze(target),
            ...(expandNodeId === undefined ? {} : { expandNodeId }),
            frozenContext: session.frozenContext
          });
        }
        return projectOutlineSelectionDragSession(
          session,
          String(event.over!.id),
          event.delta.x,
          outlineIndentPx
        );
      }
      if (session.activeId !== activeId) {
        return null;
      }
      const order = {
        rootIds: state.rootIds,
        childIdsByParent: state.childIdsByParent,
        zoomRootId: state.zoomRootId
      };
      if (pointerBoundary !== null) {
        const result = projectOutlineDropAtBoundary(
          activeId,
          pointerBoundary.beforeId,
          event.delta.x,
          structuralRows,
          order,
          outlineIndentPx
        );
        if (
          result &&
          activeId === GITHUB_NOTIFICATIONS_ROOT_ID &&
          result.projection.parentId !== null
        ) {
          return null;
        }
        return result
          ? Object.freeze({
              kind: result.noOp ? "ordinary-preview" : "ordinary-move",
              projection: result.projection
            })
          : null;
      }
      const projection = projectOutlineDrop(
        activeId,
        String(event.over!.id),
        event.delta.x,
        structuralRows,
        order,
        outlineIndentPx
      );
      if (
        projection &&
        activeId === GITHUB_NOTIFICATIONS_ROOT_ID &&
        projection.parentId !== null
      ) {
        return null;
      }
      return projection
        ? Object.freeze({ kind: "ordinary-move", projection })
        : null;
    },
    [
      activeDragId,
      dragUnavailable,
      outlineIndentPx,
      promotePendingSelectionDrag,
      structuralRows,
      state.childIdsByParent,
      state.rootIds,
      state.zoomRootId
    ]
  );
  const announcements = useMemo<Announcements>(() => {
    const labelFor = (id: string | number) => {
      const node = state.nodesById[String(id)];
      return node
        ? noteNodeNavigationLabel(node, node.title, "Untitled node")
        : "Untitled node";
    };
    const subjectFor = (id: string | number) => {
      const selectedNodeIds = selectedDragNodeIdsRef.current;
      return selectedNodeIds
        ? {
            label: `${selectedNodeIds.length} selected ${selectedNodeIds.length === 1 ? "note" : "notes"}`,
            plural: selectedNodeIds.length !== 1
          }
        : { label: labelFor(id), plural: false };
    };

    return {
      onDragStart: ({ active }) => `Picked up ${subjectFor(active.id).label}.`,
      onDragOver: ({ active, over }) => {
        const subject = subjectFor(active.id);
        return over
          ? `${subject.label} ${subject.plural ? "are" : "is"} over ${labelFor(over.id)}.`
          : `${subject.label} ${subject.plural ? "are" : "is"} no longer over a valid row.`;
      },
      onDragEnd: ({ active, over }) => {
        const result = dragEndProjection.current;
        const activeId = String(active.id);
        const overId = over ? String(over.id) : null;
        const subject = subjectFor(active.id).label;
        const projectedMove =
          result?.projection?.kind === "ordinary-move" ||
          result?.projection?.kind === "selected-move";
        if (
          over &&
          result?.activeId === activeId &&
          result.overId === overId &&
          projectedMove
        ) {
          return `Queued move for ${subject} at ${labelFor(over.id)}.`;
        }
        return `No move was made for ${subject}.`;
      },
      onDragCancel: ({ active }) =>
        `Cancelled moving ${subjectFor(active.id).label}.`
    };
  }, [state.nodesById]);

  const rejectSelectedDrag = useCallback(() => {
    pointerDropBoundaryRef.current = null;
    setDragPresentation(null);
    setDropPreview(null);
    if (!selectionDragRejectionPublishedRef.current) {
      selectionDragRejectionPublishedRef.current = true;
      publishNotesFeedback({
        kind: "error",
        message: selectionDragRejectedMessage
      });
    }
  }, [publishNotesFeedback]);
  useEffect(() => {
    const session = outlineDragSessionRef.current;
    if (session?.kind === "selected-pending") {
      if (
        session.selectionRevision === selectionRevision ||
        outlineDragSessionRef.current !== session ||
        outlineDragAttemptEpochRef.current !== session.attemptEpoch
      ) {
        return;
      }
    } else if (session?.kind === "selected-ready") {
      const authority = session.frozenContext.ownership.authority;
      if (
        (authority.selectionRevision === selectionRevision &&
          (isPreparedSelectionAuthorityCurrent?.(authority) ?? false)) ||
        outlineDragSessionRef.current !== session
      ) {
        return;
      }
    } else {
      return;
    }
    outlineDragSessionRef.current = Object.freeze({
      kind: "selected-invalid",
      reason: "selection-authority-mismatch"
    });
    rejectSelectedDrag();
  });

  const handleDragStart = (event: DragStartEvent) => {
    const attemptEpoch = ++outlineDragAttemptEpochRef.current;
    const id = String(event.active.id);
    pointerDropBoundaryRef.current = null;
    githubProjectionDropRef.current = null;
    selectedDragNodeIdsRef.current = null;
    selectionDragRejectionPublishedRef.current = false;
    dragEndProjection.current = null;
    setDragPresentation(null);
    setDropPreview(null);
    if (
      dragUnavailable ||
      id === state.zoomRootId ||
      !structuralRows.some((row) => row.id === id)
    ) {
      outlineDragSessionRef.current = null;
      setActiveDragId(null);
      return;
    }
    const filteredAuthority = currentFilteredDragAuthorityRef.current;
    if (filteredDragPreflightRequired && filteredAuthority === null) {
      outlineDragSessionRef.current = null;
      setActiveDragId(null);
      publishFilteredDragPreflightFeedback();
      return;
    }
    const live = getLiveSelectionSnapshot?.() ?? {
      selection: selectionRef.current,
      revision: selectionRevisionRef.current
    };
    const selectedIds = selectionSubtreeIds(
      live.selection,
      bodyVisibleIdsRef.current,
      stateRef.current
    );
    if (selectedIds.includes(id)) {
      const visibleNodeIds = Object.freeze([...bodyVisibleIdsRef.current]);
      const projectedWorkspace = stateRef.current;
      const presentationTitleFor = (nodeId: NoteId): string | undefined =>
        draftsByNodeId[nodeId]?.title ??
        projectedWorkspace.nodesById[nodeId]?.title;
      const openedSnapshot = deriveNotesSelectionActionSnapshot({
        selection: live.selection,
        visibleNodeIds,
        workspace: projectedWorkspace,
        authoritativeWorkspace:
          libraryViewRef.current === "all"
            ? projectedWorkspace
            : (filteredAuthority?.workspace ??
              currentPreparedAuthorityRef.current?.workspace)
      });
      const selectedNodeIds = Object.freeze([...selectedIds]);
      const existingContext = selectionDragContextRef.current;
      const existingContextCurrent =
        openedSnapshot !== null &&
        openedSnapshot.eligibility.movement.eligible &&
        exactNoteIds(openedSnapshot.selectedNodeIds, selectedNodeIds) &&
        existingContext !== null &&
        exactNoteIds(
          existingContext.ownership.actionSnapshot.selectedNodeIds,
          selectedNodeIds
        ) &&
        exactNoteIds(
          existingContext.nodeIds,
          existingContext.ownership.actionSnapshot.structuralRootIds
        ) &&
        existingContext.ownership.authority.selectionRevision ===
          live.revision &&
        (isPreparedSelectionAuthorityCurrent?.(
          existingContext.ownership.authority
        ) ?? false);
      if (filteredDragPreflightRequired && !existingContextCurrent) {
        outlineDragSessionRef.current = null;
        setActiveDragId(null);
        publishFilteredDragPreflightFeedback();
        return;
      }
      const presentationWorkspace =
        filteredDragPreflightRequired && existingContextCurrent
          ? existingContext.ownership.authority.workspace
          : projectedWorkspace;
      const visualPreparation = prepareOutlineSelectionDrag(
        id,
        selectedNodeIds,
        structuralRows,
        {
          rootIds: presentationWorkspace.rootIds,
          childIdsByParent: presentationWorkspace.childIdsByParent,
          zoomRootId: state.zoomRootId
        }
      );
      const representativeThumbnailSrc =
        visualPreparation.kind === "ready"
          ? renderedDragImageSource(
              dropSurfaceRef.current,
              visualPreparation.nodeIds[0]
            )
          : undefined;
      if (visualPreparation.kind === "invalid") {
        outlineDragSessionRef.current = Object.freeze({
          kind: "selected-invalid",
          reason: visualPreparation.reason
        });
      } else if (existingContextCurrent) {
        outlineDragSessionRef.current = startOutlineSelectionDragSession({
          activeId: id,
          selectedNodeIds,
          rows: structuralRows,
          order: {
            rootIds: existingContext.ownership.authority.workspace.rootIds,
            childIdsByParent:
              existingContext.ownership.authority.workspace.childIdsByParent,
            zoomRootId: state.zoomRootId
          },
          frozenContext: existingContext
        });
      } else if (
        openedSnapshot === null ||
        !openedSnapshot.eligibility.movement.eligible ||
        !exactNoteIds(openedSnapshot.selectedNodeIds, selectedNodeIds) ||
        !prepareSelectionAuthority ||
        !isPreparedSelectionAuthorityCurrent
      ) {
        outlineDragSessionRef.current = Object.freeze({
          kind: "selected-invalid",
          reason: "selection-authority-mismatch"
        });
      } else {
        // Calling preparation now captures the workspace/session generation
        // synchronously, before its Active read awaits. The pending drag can
        // therefore wait for this exact ownership proof after pointer-up but
        // can never adopt an authority from a later scope or generation.
        const authorityPromise = prepareSelectionAuthority(selectedNodeIds);
        const preparation = trackPendingSelectionDragPreparation(
          authorityPromise.then(async (selectionAuthority) => {
            if (
              selectionAuthority.selectionRevision !== live.revision ||
              !exactNoteIds(
                selectionAuthority.selectedNodeIds,
                selectedNodeIds
              ) ||
              !isPreparedSelectionAuthorityCurrent(selectionAuthority)
            ) {
              return null;
            }
            const selectionSnapshot = deriveNotesSelectionActionSnapshot({
              selection: live.selection,
              visibleNodeIds,
              workspace: projectedWorkspace,
              authoritativeWorkspace: selectionAuthority.workspace
            });
            const structuralRootIds = selectionSnapshot
              ? Object.freeze([...selectionSnapshot.structuralRootIds])
              : Object.freeze([] as NoteId[]);
            if (
              selectionSnapshot === null ||
              !selectionSnapshot.eligibility.movement.eligible ||
              !exactNoteIds(
                selectionSnapshot.selectedNodeIds,
                selectedNodeIds
              ) ||
              structuralRootIds.length === 0
            ) {
              return null;
            }
            const authority = exactNoteIds(
              selectionAuthority.selectedNodeIds,
              structuralRootIds
            )
              ? selectionAuthority
              : await prepareSelectionAuthority(structuralRootIds);
            const current = getLiveSelectionSnapshot?.() ?? {
              selection: selectionRef.current,
              revision: selectionRevisionRef.current
            };
            const currentSelectedIds = selectionSubtreeIds(
              current.selection,
              bodyVisibleIdsRef.current,
              stateRef.current
            );
            if (
              current.revision !== live.revision ||
              !exactNoteIds(currentSelectedIds, selectedNodeIds) ||
              authority.selectionRevision !== live.revision ||
              !exactNoteIds(authority.selectedNodeIds, structuralRootIds) ||
              !isPreparedSelectionAuthorityCurrent(authority)
            ) {
              return null;
            }
            const actionSnapshot = deriveNotesSelectionActionSnapshot({
              selection: live.selection,
              visibleNodeIds,
              workspace: projectedWorkspace,
              authoritativeWorkspace: authority.workspace
            });
            if (
              actionSnapshot === null ||
              !actionSnapshot.eligibility.movement.eligible ||
              !exactNoteIds(
                actionSnapshot.selectedNodeIds,
                selectedNodeIds
              ) ||
              !exactNoteIds(
                actionSnapshot.structuralRootIds,
                structuralRootIds
              )
            ) {
              return null;
            }
            return Object.freeze({
              nodeIds: structuralRootIds,
              ownership: Object.freeze({ actionSnapshot, authority })
            });
          })
        );
        const pendingSession = Object.freeze({
          kind: "selected-pending",
          attemptEpoch,
          activeId: id,
          selectedNodeIds,
          selectionRevision: live.revision,
          rows: Object.freeze([...structuralRows]),
          zoomRootId: state.zoomRootId,
          preview: visualPreparation,
          preparation
        });
        outlineDragSessionRef.current = pendingSession;
        void pendingSession.preparation.promise.then(() => {
          if (
            outlineDragSessionRef.current !== pendingSession ||
            outlineDragAttemptEpochRef.current !== pendingSession.attemptEpoch ||
            selectionRevisionRef.current !== pendingSession.selectionRevision
          ) {
            return;
          }
          const promotedSession = promotePendingSelectionDrag(pendingSession);
          outlineDragSessionRef.current = promotedSession;
          if (promotedSession.kind === "selected-invalid") {
            rejectSelectedDrag();
          } else if (promotedSession.kind === "selected-ready") {
            setDragPresentation(
              notesDragPresentationSnapshot(
                promotedSession.prepared,
                promotedSession.frozenContext.ownership.authority.workspace,
                presentationTitleFor(promotedSession.prepared.nodeIds[0]),
                representativeThumbnailSrc
              )
            );
          }
        });
      }
      selectedDragNodeIdsRef.current = selectedNodeIds;
      const startedSession = outlineDragSessionRef.current;
      if (startedSession.kind === "selected-invalid") {
        rejectSelectedDrag();
      } else if (startedSession.kind === "selected-ready") {
        setDragPresentation(
          notesDragPresentationSnapshot(
            startedSession.prepared,
            startedSession.frozenContext.ownership.authority.workspace,
            presentationTitleFor(startedSession.prepared.nodeIds[0]),
            representativeThumbnailSrc
          )
        );
      } else if (visualPreparation.kind === "ready") {
        // All-view presentation is already the complete Active forest while
        // its exact selection command authority finishes preparing.
        setDragPresentation(
          notesDragPresentationSnapshot(
            visualPreparation,
            presentationWorkspace,
            presentationTitleFor(visualPreparation.nodeIds[0]),
            representativeThumbnailSrc
          )
        );
      }
    } else {
      const presentationWorkspace = filteredAuthority?.workspace ?? state;
      const visualPreparation = prepareOutlineSelectionDrag(
        id,
        [id],
        structuralRows,
        {
          rootIds: presentationWorkspace.rootIds,
          childIdsByParent: presentationWorkspace.childIdsByParent,
          zoomRootId: state.zoomRootId
        }
      );
      if (visualPreparation.kind === "invalid") {
        outlineDragSessionRef.current = null;
        setActiveDragId(null);
        return;
      }
      const representativeThumbnailSrc = renderedDragImageSource(
        dropSurfaceRef.current,
        visualPreparation.nodeIds[0]
      );
      const ordinarySession = Object.freeze({
        kind: "ordinary",
        activeId: id
      });
      outlineDragSessionRef.current = ordinarySession;
      const representativeTitle =
        draftsByNodeId[id]?.title ?? state.nodesById[id]?.title;
      setDragPresentation(
        notesDragPresentationSnapshot(
          visualPreparation,
          presentationWorkspace,
          representativeTitle,
          representativeThumbnailSrc
        )
      );
    }
    setActiveDragId(id);
  };

  const handleDragMove = (event: DragMoveEvent) => {
    const projection = projectDrag(event);
    if (!projection) {
      setDropPreview(null);
      return;
    }
    if (projection.kind === "selected-preview") {
      setDropPreview(
        derivePreparedOutlineSelectionDropPreview(
          projection.prepared,
          projection.result
        )
      );
      return;
    }
    if (projection.kind === "selected-invalid") {
      if (outlineDragSessionRef.current?.kind === "selected-invalid") {
        rejectSelectedDrag();
      } else {
        setDropPreview(null);
      }
      return;
    }
    if (
      projection.kind === "ordinary-move" ||
      projection.kind === "ordinary-preview"
    ) {
      setDropPreview(
        deriveOutlineDropPreview(
          String(event.active.id),
          structuralRows,
          projection.projection
        )
      );
      return;
    }
    const session = outlineDragSessionRef.current;
    setDropPreview(
      session?.kind === "selected-ready"
        ? derivePreparedOutlineSelectionDropPreview(session.prepared, {
            kind: "valid",
            nodeIds: session.prepared.nodeIds,
            projection: {
              ...projection.target,
              ...(projection.expandNodeId === undefined
                ? {}
                : { expandNodeId: projection.expandNodeId })
            }
          })
        : null
    );
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const droppedSession = outlineDragSessionRef.current;
    const githubProjectionDrop =
      githubProjectionDropRef.current?.activeId === activeId
        ? githubProjectionDropRef.current
        : null;
    const droppedPointerBoundary =
      pointerDropBoundaryRef.current?.activeId === activeId
        ? pointerDropBoundaryRef.current
        : null;
    const projection = projectDrag(event);
    dragEndProjection.current = {
      activeId,
      overId:
        droppedPointerBoundary?.overId ??
        (event.over ? String(event.over.id) : null),
      projection
    };
    outlineDragSessionRef.current = null;
    pointerDropBoundaryRef.current = null;
    githubProjectionDropRef.current = null;
    setActiveDragId(null);
    setDragPresentation(null);
    setDropPreview(null);
    if (githubProjectionDrop !== null) {
      const commitProjectionDrop = async () => {
        let session = droppedSession;
        if (session?.kind === "selected-pending") {
          await session.preparation.promise;
          session = promotePendingSelectionDrag(session);
        }
        const oneMovableNode =
          session?.kind === "ordinary" ||
          (session?.kind === "selected-ready" &&
            session.frozenContext.ownership.actionSnapshot.structuralRootIds
              .length === 1 &&
            session.frozenContext.ownership.actionSnapshot.structuralRootIds[0] ===
              activeId);
        if (!oneMovableNode || activeId === GITHUB_NOTIFICATIONS_ROOT_ID) {
          return;
        }
        const projectedRow = githubProjectionRef.current.rows.find(
          (row) =>
            row.kind === "projected" &&
            serializeExternalBulletKey(row.bullet.key) ===
              githubProjectionDrop.serializedKey
        );
        if (projectedRow?.kind !== "projected") {
          return;
        }
        const snapshot = githubNotificationSnapshotFromBullet(
          projectedRow.bullet
        );
        if (snapshot === null) return;
        await actions.materializeGithubNotification(snapshot, {
          kind: "reparent",
          nodeId: activeId
        });
      };
      void commitProjectionDrop();
      return;
    }
    if (
      droppedSession?.kind === "selected-pending" &&
      (droppedPointerBoundary !== null || event.over !== null) &&
      !dragUnavailable &&
      droppedSession.activeId === activeId
    ) {
      const overId = event.over === null ? null : String(event.over.id);
      const horizontalOffset = event.delta.x;
      void droppedSession.preparation.promise.then(() => {
        if (droppedSession.attemptEpoch !== outlineDragAttemptEpochRef.current) {
          return;
        }
        const live = getLiveSelectionSnapshot?.() ?? {
          selection: selectionRef.current,
          revision: selectionRevisionRef.current
        };
        if (live.revision !== droppedSession.selectionRevision) {
          return;
        }
        const readySession = promotePendingSelectionDrag(droppedSession);
        if (readySession.kind !== "selected-ready") {
          rejectSelectedDrag();
          return;
        }
        if (droppedPointerBoundary !== null) {
          const boundaryResult =
            projectPreparedOutlineSelectionDropAtBoundary(
              readySession.prepared,
              droppedPointerBoundary.beforeId,
              horizontalOffset,
              outlineIndentPx
            );
          if (boundaryResult.kind === "invalid") {
            rejectSelectedDrag();
            return;
          }
          if (boundaryResult.noOp) {
            return;
          }
          if (
            droppedSession.attemptEpoch !== outlineDragAttemptEpochRef.current
          ) {
            return;
          }
          const { expandNodeId, ...target } = boundaryResult.projection;
          void executeGuardedSelectionCommand(
            {
              type: "reorder",
              target,
              ...(expandNodeId === undefined ? {} : { expandNodeId })
            },
            readySession.frozenContext
          );
          return;
        }
        if (overId === null) {
          return;
        }
        const lateProjection = projectOutlineSelectionDragSession(
          readySession,
          overId,
          horizontalOffset,
          outlineIndentPx
        );
        if (lateProjection.kind !== "selected-move") {
          rejectSelectedDrag();
          return;
        }
        if (droppedSession.attemptEpoch !== outlineDragAttemptEpochRef.current) {
          return;
        }
        void executeGuardedSelectionCommand(
          {
            type: "reorder",
            target: lateProjection.target,
            ...(lateProjection.expandNodeId === undefined
              ? {}
              : { expandNodeId: lateProjection.expandNodeId })
          },
          lateProjection.frozenContext
        );
      });
      return;
    }
    if (
      projection?.kind === "selected-preview" ||
      projection?.kind === "ordinary-preview"
    ) {
      return;
    }
    if (!projection) {
      return;
    }
    if (projection.kind === "selected-invalid") {
      rejectSelectedDrag();
      return;
    }
    if (projection.kind === "selected-move") {
      void executeGuardedSelectionCommand(
        {
          type: "reorder",
          target: projection.target,
          ...(projection.expandNodeId === undefined
            ? {}
            : { expandNodeId: projection.expandNodeId })
        },
        projection.frozenContext
      );
      return;
    }
    const { expandNodeId, ...input } = projection.projection;
    void actions.moveNode(
      { id: activeId, ...input },
      undefined,
      expandNodeId === undefined ? undefined : { expandNodeId }
    );
  };

  const bodyRowById = useMemo(
    () => new Map(bodyRows.map((row) => [row.id, row])),
    [bodyRows]
  );
  const githubStoredRowById = useMemo(() => {
    const adapted = new Map<NoteId, FlattenedOutlineRow>();
    for (const projectedRow of githubProjection.rows) {
      if (projectedRow.kind !== "stored") {
        continue;
      }
      const row = bodyRowById.get(projectedRow.nodeId);
      if (!row) {
        continue;
      }
      adapted.set(projectedRow.nodeId, {
        ...row,
        depth: projectedRow.depth,
        ancestorGuideDepths: Array.from(
          { length: projectedRow.depth },
          (_, guideDepth) => guideDepth
        )
      });
    }
    return adapted;
  }, [bodyRowById, githubProjection.rows]);
  const renderOutlineNodeItem = (
    row: FlattenedOutlineRow,
    depth = row.depth
  ) => {
    const pluginOwned = state.nodesById[row.id]?.pluginMeta !== undefined;
    return (
    <li
      className="notes-outline-item"
      key={row.id}
      aria-level={depth + 1}
      data-drag-source={
        dragSourceNodeIdSet.has(row.id) ? "true" : undefined
      }
      role="listitem"
    >
      {bodyDropPreview?.beforeId === row.id && (
        <DropPreviewLine preview={bodyDropPreview} />
      )}
      <OutlineNodeRow
        nodeId={row.id}
        depth={depth}
        ancestorGuideDepths={row.ancestorGuideDepths}
        visibleDescendantEndId={row.visibleDescendantEndId}
        getVisibleNodeIds={getVisibleNodeIds}
        getSelectionVisibleNodeIds={getSelectionVisibleNodeIds}
        getSelection={getSelection}
        onSelectionAction={executeSelectionAction}
        selectionBridge={
          selectedIdSet.has(row.id)
            ? selectionMenuBridge
            : undefined
        }
        isSelected={selectedIdSet.has(row.id)}
        draft={draftsByNodeId[row.id]}
        attachmentUploadError={
          attachmentUploadErrorsByNodeId?.[row.id]
        }
        attachmentUploadRetryAttemptId={
          attachmentUploadRetryAttemptIdsByNodeId?.[row.id]
        }
        readOnlyMode={
          lifecycleReadOnly
            ? lifecycleMode === "archive"
              ? "archive"
              : "trash"
            : undefined
        }
        disabled={deletingNotesData}
        locallyExpanded={locallyExpandedNodeIds.has(row.id)}
        dragDisabled={
          dragUnavailable ||
          pluginOwned ||
          protectedMoveNodeIds.has(row.id) ||
          row.id === state.zoomRootId ||
          (filteredDragPreflightRequired &&
            (!filteredDragAuthorityReady ||
              (selectedIdSet.has(row.id) &&
                currentSelectionDragContext === null)))
        }
        movementProtected={protectedMoveNodeIds.has(row.id)}
        dragDisabledReason={
          filteredDragPreflightRequired &&
          (!filteredDragAuthorityReady ||
            (selectedIdSet.has(row.id) &&
              currentSelectionDragContext === null))
            ? filteredDragAuthorityFailed ||
              selectionDragContextFailureKey ===
                selectionChooserLifecycleKey
              ? filteredDragUnavailableMessage
              : filteredDragPreparingMessage
            : undefined
        }
        onDragDisabledAttempt={
          !dragUnavailable &&
          !pluginOwned &&
          !protectedMoveNodeIds.has(row.id) &&
          row.id !== state.zoomRootId &&
          filteredDragPreflightRequired &&
          (!filteredDragAuthorityReady ||
            (selectedIdSet.has(row.id) &&
              currentSelectionDragContext === null))
            ? publishFilteredDragPreflightFeedback
            : undefined
        }
        suppressDragPresentation={activeDragId !== null}
        pluginRoot={row.id === GITHUB_NOTIFICATIONS_ROOT_ID}
        selectionDisabled={
          pluginOwned || row.id === GITHUB_NOTIFICATIONS_ROOT_ID
        }
        imageDropActive={imageDropTargetId === row.id}
        showDropPlaceholder={false}
      />
      {imageDropMarkerBoundary?.afterId === row.id && (
        <span
          className="notes-image-drop-position"
          data-testid="notes-image-drop-position"
          aria-hidden="true"
          style={{
            insetInlineStart: `calc(${imageDropMarkerBoundary.depth} * var(--notes-outline-indent) + var(--notes-content-offset))`
          }}
        />
      )}
    </li>
    );
  };
  const renderGithubStoredRow = (nodeId: NoteId) => {
    const row = githubStoredRowById.get(nodeId);
    const node = state.nodesById[nodeId];
    const date = node?.parentId
      ? state.nodesById[node.parentId]?.pluginMeta
      : undefined;
    const bullet =
      node && date?.kind === "date"
        ? storedGithubNotificationBullet(node, date.dateKey)
        : null;
    if (bullet) {
      const key = serializeExternalBulletKey(bullet.key);
      return (
        <NotesExternalBulletRow
          key={nodeId}
          bullet={bullet}
          storedNodeId={nodeId}
          completing={githubPage?.completingKeys.has(key) ?? false}
          completionError={githubPage?.completionErrors[key] ?? null}
          onCompleted={async (completedBullet) => {
            await actions.markMaterializedGithubNotificationRead(
              serializeExternalBulletKey(completedBullet.key),
              completedBullet.updatedAt
            );
          }}
          onCreateSibling={createGithubNotificationSibling}
          onStructuralPaste={importGithubNotificationChildren}
        />
      );
    }
    return row ? renderOutlineNodeItem(row) : null;
  };

  return (
    <NotesExportControllerProvider
      available={state.zoomRootId !== null || bodyRows.length > 0}
      disabled={deletingNotesData || lifecycleReadOnly}
      loading={state.status === "loading"}
      onFlushDrafts={actions.flushAllDrafts}
    >
      <section
        className="notes-outline"
        aria-label="Notes outline"
        aria-busy={state.status === "loading" || deletingNotesData}
        style={
          {
            "--notes-outline-indent": `${outlineIndentPx}px`
          } as CSSProperties
        }
      >
        <TooltipProvider>
        {selectionSnapshot ? (
          <NotesSelectionActionBar
            ref={selectionToolbarRef}
            snapshot={selectionSnapshot}
            busy={selectionRouter.busy || selectionChooserFeedback.busy}
            mutationDisabledReason={selectionMutationDisabledReason}
            onAction={executeSelectionAction}
            onClearSelection={actions.clearSelection}
            onReturnFocus={returnFocusToSelectionHead}
          />
        ) : (
          <div className="notes-outline-toolbar">
            <NotesBreadcrumb
              disabled={deletingNotesData}
              trashView={trashView}
              onRequestEmptyTrash={() => setEmptyTrashConfirmOpen(true)}
            />
            <IconTooltip
              label={showCompleted ? "Hide completed" : "Show completed"}
              side="bottom"
            >
              <button
                className="notes-completed-toggle"
                type="button"
                aria-label="Completed items"
                aria-pressed={showCompleted}
                disabled={deletingNotesData || lifecycleReadOnly}
                onClick={() => setShowCompleted((visible) => !visible)}
              >
                <ListChecks size={16} aria-hidden="true" />
              </button>
            </IconTooltip>
            {!githubZoomed && (
              <NotesExportMenu
                selectedNodeId={state.selectedId}
                selectedNodeTitle={
                  state.selectedId === null
                    ? undefined
                    : optionalNodeLabel(
                        state.nodesById[state.selectedId],
                        draftsByNodeId[state.selectedId]?.title
                      )
                }
                zoomRootId={state.zoomRootId}
                zoomRootTitle={
                  state.zoomRootId === null
                    ? undefined
                    : optionalNodeLabel(
                        state.nodesById[state.zoomRootId],
                        draftsByNodeId[state.zoomRootId]?.title,
                        "Untitled page"
                      )
                }
                onFlushDrafts={actions.flushAllDrafts}
                disabled={deletingNotesData || lifecycleReadOnly}
                loading={state.status === "loading"}
              />
            )}
            {paneLayout && (
              <IconTooltip
                label={
                  paneLayout.detailMaximized
                    ? "상세 최대화 해제"
                    : "상세 최대화"
                }
                side="bottom"
              >
                <button
                  className="notes-export-trigger notes-maximize-toggle"
                  type="button"
                  aria-label="상세 최대화"
                  aria-pressed={paneLayout.detailMaximized}
                  onClick={paneLayout.toggleDetailMaximized}
                >
                  {paneLayout.detailMaximized ? (
                    <Minimize2 size={16} aria-hidden="true" />
                  ) : (
                    <Maximize2 size={16} aria-hidden="true" />
                  )}
                </button>
              </IconTooltip>
            )}
          </div>
        )}
        <NotesSyncStatusBadge />
        {writeError && (
          <div
            className="notes-inline-error notes-write-error-banner"
            role="alert"
          >
            <span>
              A note could not be saved, so editing commands are paused.
              Retry the save to continue.
            </span>
            <button
              type="button"
              className="notes-write-error-retry"
              onClick={() => void retryLastFailedWrite()}
            >
              Retry save
            </button>
          </div>
        )}
        <div className="notes-outline-rows" ref={dropSurfaceRef}>
          <div
            className="notes-outline-content"
            data-zoomed-page={
              state.zoomRootId !== null && state.nodesById[state.zoomRootId]
                ? "true"
                : undefined
            }
            ref={contentRef}
            onCompositionEndCapture={handleSelectionCompositionEndCapture}
            onCompositionStartCapture={handleSelectionCompositionStartCapture}
            onFocusCapture={handleGithubEditorFocusCapture}
            onCopyCapture={handleSelectionCopyCapture}
            onCutCapture={handleSelectionCutCapture}
            onKeyDownCapture={handleSelectionClipboardKeyDownCapture}
            onKeyUpCapture={handleSelectionClipboardKeyUpCapture}
            onPasteCapture={handlePasteCapture}
          >
          {initialLoading && (
            <p className="notes-pane-state">Loading notes...</p>
          )}
          {state.status === "error" && state.rootIds.length === 0 && (
            <p className="notes-pane-state notes-pane-error" role="alert">
              {state.error}
            </p>
          )}
          {!initialLoading &&
            state.status !== "error" &&
            completedItemsHidden && (
              <p className="notes-pane-state">Completed items are hidden.</p>
            )}
          {!initialLoading &&
            state.status !== "error" &&
            allStructuralRows.length === 0 && (
              <p className="notes-pane-state">No outline yet.</p>
            )}
          {state.status === "error" && state.rootIds.length > 0 && (
            <p className="notes-inline-error" role="alert">
              {state.error}
            </p>
          )}
          {imageIngestError && (
            <p
              className="notes-inline-error"
              role="alert"
              aria-label={imageIngestError.label}
            >
              {imageIngestError.message}
            </p>
          )}
          {!githubZoomed &&
            state.zoomRootId !== null &&
            state.nodesById[state.zoomRootId] && (
            <NotesPageHeader
              key={state.zoomRootId}
              nodeId={state.zoomRootId}
              getVisibleNodeIds={getVisibleNodeIds}
              disabled={deletingNotesData}
              movementProtected={protectedMoveNodeIds.has(state.zoomRootId)}
              mode={lifecycleMode}
              imageDropActive={imageDropTargetId === state.zoomRootId}
              showDropPlaceholder={imageDropTargetId === state.zoomRootId}
            />
          )}
          <DndContext
            accessibility={{
              announcements,
              screenReaderInstructions: outlineScreenReaderInstructions
            }}
            collisionDetection={detectOutlineCollisions}
            measuring={{ dragOverlay: { measure: measureDragOverlay } }}
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragOver={handleDragMove}
            onDragCancel={() => {
              outlineDragAttemptEpochRef.current += 1;
              outlineDragSessionRef.current = null;
              pointerDropBoundaryRef.current = null;
              githubProjectionDropRef.current = null;
              setActiveDragId(null);
              setDragPresentation(null);
              setDropPreview(null);
            }}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={sortableVisibleIds}
              strategy={verticalListSortingStrategy}
            >
              <ol
                className="notes-outline-list"
                data-drag-active={activeDragId === null ? undefined : "true"}
                onPointerDownCapture={handleMouseSelectionPointerDownCapture}
                onPointerMoveCapture={handleMouseSelectionPointerMoveCapture}
                role="list"
              >
                {ordinaryBodyRows.map((row) => (
                  <Fragment key={row.id}>
                    {renderOutlineNodeItem(row)}
                    {row.id === GITHUB_NOTIFICATIONS_ROOT_ID &&
                      !row.isCollapsed && (
                        <NotesExternalOutlinePane
                          onRetry={retryGithubNotifications}
                          onCreateSibling={createGithubNotificationSibling}
                          onStructuralPaste={importGithubNotificationChildren}
                          onToggleDateGroup={toggleGithubDateGroup}
                          page={githubPage}
                          projection={githubProjection}
                          renderStoredRow={renderGithubStoredRow}
                        />
                      )}
                  </Fragment>
                ))}
                {githubZoomed && (
                  <NotesExternalOutlinePane
                    onRetry={retryGithubNotifications}
                    onCreateSibling={createGithubNotificationSibling}
                    onStructuralPaste={importGithubNotificationChildren}
                    onToggleDateGroup={toggleGithubDateGroup}
                    page={githubPage}
                    projection={githubProjection}
                    renderStoredRow={renderGithubStoredRow}
                  />
                )}
                {bodyDropPreview?.beforeId === null && (
                  <li
                    className="notes-outline-drop-preview-tail"
                    aria-hidden="true"
                    role="presentation"
                  >
                    <DropPreviewLine preview={bodyDropPreview} />
                  </li>
                )}
              </ol>
            </SortableContext>
            {dragPresentation !== null && (
              <DragOverlay
                dropAnimation={null}
                modifiers={NOTES_DRAG_OVERLAY_MODIFIERS}
              >
                <NotesSelectionDragPreview
                  labels={draggedNodeLabels}
                  total={dragPresentation.forestNodeIds.length}
                  thumbnailSrc={dragPresentation.representativeThumbnailSrc}
                />
              </DragOverlay>
            )}
          </DndContext>
          {!githubZoomed &&
            state.zoomRootId !== null &&
            state.nodesById[state.zoomRootId] && (
            <NotesChildComposer
              parentId={state.zoomRootId}
              disabled={deletingNotesData || lifecycleReadOnly}
              hasChildren={
                (state.childIdsByParent[state.zoomRootId]?.length ?? 0) > 0
              }
            />
          )}
          </div>
        </div>
        {imageDropPreview && (
          <NotesAttachmentDragPreview
            paths={imageDropPreview.paths}
            position={imageDropPreview.position}
            portalContainer={
              contentRef.current?.closest(".feature-pane-slot") ?? undefined
            }
          />
        )}
        <ConfirmDialog
          open={emptyTrashConfirmOpen}
          onOpenChange={setEmptyTrashConfirmOpen}
          title="Empty trash?"
          description="Permanently delete every note currently in Trash? This cannot be undone."
          confirmLabel="Empty trash"
          cancelLabel="Cancel"
          danger
          onConfirm={() => void actions.emptyTrash()}
        />
        <NotesQuickJump
          open={quickJumpOpen}
          onOpenChange={setQuickJumpOpen}
          onSearch={actions.searchNotes}
          onJump={actions.openSearchResult}
          nodesById={state.nodesById}
        />
        {selectionChooser?.kind === "move" && (
          <NotesMoveChooser
            open
            snapshot={selectionChooser.snapshot}
            nodesById={
              selectionChooser.snapshot.ownership.authority.workspace.nodesById
            }
            onOpenChange={(open) => {
              if (!open) {
                setSelectionChooser(null);
              }
            }}
            onChoose={({ destinationId, snapshot }) => {
              const target = frozenMoveTarget(
                snapshot.ownership.authority.workspace,
                snapshot.nodeIds,
                destinationId
              );
              if (target) {
                void executeGuardedSelectionCommand(
                  { type: "moveTo", target },
                  snapshot
                );
              }
            }}
            onRequestFocusReturn={returnFocusToSelectionHead}
          />
        )}
        {selectionChooser?.kind === "tags" && (
          <NotesTagChooser
            open
            snapshot={selectionChooser.snapshot}
            suggestions={tagSuggestions}
            selectedTagUnion={selectionChooser.selectedTagUnion}
            onOpenChange={(open) => {
              if (!open) {
                setSelectionChooser(null);
              }
            }}
            onCommit={(commit) => {
              void executeGuardedSelectionCommand(
                commit.mode === "add"
                  ? { type: "addTag", tag: commit.tag }
                  : { type: "removeTag", tag: commit.tag },
                commit.snapshot
              );
            }}
            onRequestFocusReturn={returnFocusToSelectionHead}
          />
        )}
        </TooltipProvider>
      </section>
    </NotesExportControllerProvider>
  );
}
