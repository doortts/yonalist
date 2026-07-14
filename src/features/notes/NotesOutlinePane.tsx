import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  type Announcements,
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
import { ChevronRight, Home, ListChecks, Trash2 } from "lucide-react";
import {
  type CSSProperties,
  type ClipboardEvent,
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
import type { NoteId, NoteSearchTag } from "../../domain/notes";
import { VaultRootContext } from "../../VaultRootContext";
import { NotesChildComposer } from "./NotesChildComposer";
import { NotesAttachmentDragPreview } from "./NotesAttachmentDragPreview";
import { NotesExportMenu } from "./NotesExportMenu";
import { NotesExportControllerProvider } from "./NotesExportController";
import { useNotesAttachmentUi } from "./NotesAttachmentUiContext";
import type { NotesNativeImageDropEvent } from "./notesAttachmentController";
import {
  attachmentTargetFromPaste,
  attachmentTargetFromPoint
} from "./notesAttachmentTargets";
import { extractClipboardImages } from "./notesClipboardImages";
import { NotesPageHeader } from "./NotesPageHeader";
import { NotesQuickJump } from "./NotesQuickJump";
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
import {
  useNotesActions,
  useNotesDrafts,
  useNotesState
} from "./NotesWorkspaceContext";
import { writeNotesClipboardText } from "./notesClipboard";
import {
  deriveNotesSelectionActionSnapshot,
  type NotesSelectionActionSnapshot
} from "./notesSelectionActions";
import { buildNotesMoveDestinations } from "./notesMoveTargets";
import { tokenizeNoteText } from "./noteTokens";
import {
  deriveOutlineDropPreview,
  OUTLINE_INDENT_PX,
  OUTLINE_NARROW_INDENT_PX,
  OUTLINE_NARROW_MEDIA_QUERY,
  projectOutlineDrop,
  type OutlineDropPreview
} from "./outlineDrag";
import {
  selectionRangeIds,
  type NormalizedNotesWorkspace
} from "./notesWorkspaceReducer";
import {
  deriveOutlineBodyRows,
  flattenVisibleOutlineRows,
  parentTrail
} from "./outlineTree";
import { OutlineNodeRow } from "./OutlineNodeRow";
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
        const label = node.title.trim() || "Untitled page";
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

export function NotesOutlinePane() {
  const attachmentUi = useNotesAttachmentUi();
  const {
    actions,
    applyPreparedSelectionBatch,
    isPreparedSelectionAuthorityCurrent,
    prepareSelectionAuthority,
    retryLastFailedWrite
  } = useNotesActions();
  const vaultRoot = useContext(VaultRootContext);
  const {
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
  const getLiveSelectionSnapshot = actions.getSelectionSnapshot;
  const [activeDragId, setActiveDragId] = useState<NoteId | null>(null);
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
  const [selectionChooser, setSelectionChooser] =
    useState<SelectionChooserSession | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const selectionToolbarRef = useRef<HTMLDivElement>(null);
  const lastSelectionHeadRef = useRef<NoteId | null>(null);
  const selectionAuthorityRequestRef = useRef(0);
  const selectionChooserPreparationRequestRef = useRef(0);
  const imageDropPathsRef = useRef<readonly string[]>([]);
  const imageDropAvailableRef = useRef(false);
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
  const imageDropAvailable =
    !deletingNotesData &&
    !lifecycleReadOnly &&
    state.status !== "loading" &&
    actions.importDroppedImagePaths !== undefined;
  const imagePasteAvailable =
    !imagePasteExecutionScope.deletingNotesData &&
    !lifecycleReadOnly &&
    imagePasteExecutionScope.status !== "loading" &&
    imagePasteExecutionScope.importClipboardImages !== undefined;
  imageDropAvailableRef.current = imageDropAvailable;
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
    const clipboardItems = event.clipboardData.items;
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
    projection: ReturnType<typeof projectOutlineDrop>;
  } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, pointerSensorOptions),
    useSensor(KeyboardSensor, keyboardSensorOptions)
  );

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
      setImageDropTargetId(null);
      setImageDropPreview(null);
    };
    const targetFromEvent = (
      event: Extract<NotesNativeImageDropEvent, { position: unknown }>
    ) => {
      const root = contentRef.current;
      return root ? attachmentTargetFromPoint(root, event.position) : null;
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
      const root = contentRef.current;
      if (!root || root.closest("[hidden]")) {
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
        setImageDropTargetId(
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
        setImageDropTargetId(
          imageDropPathsRef.current.length > 0 ? targetFromEvent(event) : null
        );
        return;
      }

      const targetId =
        event.paths.length > 0 ? targetFromEvent(event) : null;
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

  // Cmd/Ctrl+K opens the quick-jump palette while Notes is the active
  // feature. Notes' panes stay mounted (hidden) while another feature is
  // active (see App.tsx's `feature-pane-slot` wrapper), so a plain global
  // listener would fire from the background; guarding on whether this pane's
  // own DOM sits under a `[hidden]` ancestor scopes the shortcut to Notes
  // without needing a dedicated "active feature" context.
  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.key === "Process") {
        return;
      }
      if (event.key.toLowerCase() !== "k") {
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) {
        return;
      }
      if (contentRef.current?.closest("[hidden]")) {
        return;
      }
      event.preventDefault();
      setQuickJumpOpen(true);
    };
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, []);

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
  const bodyRows = useMemo(
    () => deriveOutlineBodyRows(structuralRows, state.zoomRootId),
    [structuralRows, state.zoomRootId]
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
  const bodyVisibleIds = useMemo(
    () => bodyRows.map((row) => row.id),
    [bodyRows]
  );
  const bodyVisibleIdsRef = useRef(bodyVisibleIds);
  bodyVisibleIdsRef.current = bodyVisibleIds;
  const getSelectionVisibleNodeIds = useCallback(
    () => bodyVisibleIdsRef.current,
    []
  );
  const materializedSelectionIds = useMemo(
    () => selectionRangeIds(selection ?? null, bodyVisibleIds),
    [bodyVisibleIds, selection]
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
  if (selectionSnapshot) {
    lastSelectionHeadRef.current = selectionSnapshot.selection.headId;
  }

  // The preparation API intentionally allows overlapping callers. This pane
  // adds latest-request ownership so a late result for an older visible range
  // can never hydrate the current toolbar.
  useEffect(() => {
    const requestId = ++selectionAuthorityRequestRef.current;
    setPreparedSelectionAuthority(null);
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
      }
    })().catch(() => {
      // The provisional snapshot remains mounted with explicit disabled
      // reasons. The shared router reports command-time failures.
    });
  }, [
    actions,
    isPreparedSelectionAuthorityCurrent,
    materializedSelectionIds,
    prepareSelectionAuthority,
    provisionalSelectionSnapshot,
    selectionRevision
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
    const selectedNodeIds = selectionRangeIds(live.selection, visibleNodeIds);
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
    getVisibleNodeIds: getProjectedSelectionVisibleIds,
    flushDrafts: actions.flushAllDrafts,
    prepareAuthority: (nodeIds) => {
      if (!prepareSelectionAuthority) {
        return Promise.reject(new Error("Selection authority is unavailable."));
      }
      return prepareSelectionAuthority(nodeIds);
    },
    isAuthorityCurrent: (authority) =>
      isPreparedSelectionAuthorityCurrent?.(authority) ?? false,
    applyBatch: (authority, op, options) => {
      if (!applyPreparedSelectionBatch) {
        return Promise.reject(new Error("Selection batch actions are unavailable."));
      }
      return applyPreparedSelectionBatch(authority, op, options);
    },
    replaceSelection: (nextSelection, expectedRevision) =>
      actions.replaceSelection?.(nextSelection, expectedRevision) ?? false,
    focusNode: focusBodyTitle,
    writeClipboard: writeSelectionClipboard
  });
  const executeSelectionCommand = selectionRouter.execute;
  const invalidatePreparedSelectionClipboard =
    selectionRouter.invalidatePreparedClipboard;
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
      setSelectionChooser(null);
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
    async (kind: "move" | "tags"): Promise<void> => {
      const requestId = ++selectionChooserPreparationRequestRef.current;
      setSelectionChooser(null);
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
      if (
        !openingSnapshot ||
        targetIds.length === 0 ||
        !prepareSelectionAuthority ||
        !isPreparedSelectionAuthorityCurrent ||
        !(await actions.flushAllDrafts()) ||
        selectionChooserPreparationRequestRef.current !== requestId
      ) {
        return;
      }
      const afterFlushLive = getLiveSelectionSnapshot?.() ?? {
        selection: selectionRef.current,
        revision: selectionRevisionRef.current
      };
      if (afterFlushLive.revision !== openingLive.revision) {
        return;
      }
      const authority = await prepareSelectionAuthority(targetIds);
      const currentLive = getLiveSelectionSnapshot?.() ?? {
        selection: selectionRef.current,
        revision: selectionRevisionRef.current
      };
      if (
        selectionChooserPreparationRequestRef.current !== requestId ||
        currentLive.revision !== openingLive.revision ||
        authority.selectionRevision !== openingLive.revision ||
        !exactNoteIds(authority.selectedNodeIds, targetIds) ||
        !isPreparedSelectionAuthorityCurrent(authority)
      ) {
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
    },
    [
      actions,
      getLiveSelectionActionSnapshot,
      getLiveSelectionSnapshot,
      isPreparedSelectionAuthorityCurrent,
      prepareSelectionAuthority
    ]
  );

  const executeSelectionAction = useCallback(
    async (action: NotesSelectionActionBarAction): Promise<void> => {
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
          await requestSelectionChooser("move");
          return;
        case "tags":
          await requestSelectionChooser("tags");
          return;
      }
      if (intent) {
        await executeSelectionCommand(intent);
      }
    },
    [executeSelectionCommand, requestSelectionChooser]
  );
  const returnFocusToSelectionHead = useCallback(() => {
    const headId = lastSelectionHeadRef.current;
    if (headId !== null) {
      focusBodyTitle(headId);
    }
  }, [focusBodyTitle]);
  const selectionMutationDisabledReason = deletingNotesData
    ? "Notes data is being deleted."
    : lifecycleReadOnly
      ? "Selection actions are unavailable in Archive or Trash."
      : writeError
        ? "Retry the failed save before changing notes."
        : null;
  const selectionMenuState = useMemo<NotesBulletMenuSelectionState | null>(
    () =>
      selectionSnapshot
        ? {
            snapshot: selectionSnapshot,
            busy: selectionRouter.busy,
            mutationDisabledReason: selectionMutationDisabledReason
          }
        : null,
    [
      selectionMutationDisabledReason,
      selectionRouter.busy,
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
    void requestSelectionChooser(chooser);
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
  const projectDrag = useCallback(
    (event: Pick<DragMoveEvent, "active" | "delta" | "over">) => {
      const activeId = String(event.active.id);
      if (
        dragUnavailable ||
        !event.over ||
        activeId === state.zoomRootId ||
        (activeDragId !== null && activeDragId !== activeId)
      ) {
        return null;
      }

      return projectOutlineDrop(
        activeId,
        String(event.over.id),
        event.delta.x,
        structuralRows,
        {
          rootIds: state.rootIds,
          childIdsByParent: state.childIdsByParent,
          zoomRootId: state.zoomRootId
        },
        outlineIndentPx
      );
    },
    [
      activeDragId,
      dragUnavailable,
      outlineIndentPx,
      structuralRows,
      state.childIdsByParent,
      state.rootIds,
      state.zoomRootId
    ]
  );
  const announcements = useMemo<Announcements>(() => {
    const labelFor = (id: string | number) => {
      const title = state.nodesById[String(id)]?.title.trim();
      return title || "Untitled node";
    };

    return {
      onDragStart: ({ active }) => `Picked up ${labelFor(active.id)}.`,
      onDragOver: ({ active, over }) =>
        over
          ? `${labelFor(active.id)} is over ${labelFor(over.id)}.`
          : `${labelFor(active.id)} is no longer over a valid row.`,
      onDragEnd: ({ active, over }) => {
        const result = dragEndProjection.current;
        const activeId = String(active.id);
        const overId = over ? String(over.id) : null;
        if (
          over &&
          result?.activeId === activeId &&
          result.overId === overId &&
          result.projection
        ) {
          return `Queued move for ${labelFor(active.id)} at ${labelFor(over.id)}.`;
        }
        return `No move was made for ${labelFor(active.id)}.`;
      },
      onDragCancel: ({ active }) => `Cancelled moving ${labelFor(active.id)}.`
    };
  }, [state.nodesById]);

  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    dragEndProjection.current = null;
    setDropPreview(null);
    if (
      dragUnavailable ||
      id === state.zoomRootId ||
      !structuralRows.some((row) => row.id === id)
    ) {
      setActiveDragId(null);
      return;
    }
    setActiveDragId(id);
  };

  const handleDragMove = (event: DragMoveEvent) => {
    const projection = projectDrag(event);
    setDropPreview(
      projection
        ? deriveOutlineDropPreview(
            String(event.active.id),
            structuralRows,
            projection
          )
        : null
    );
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const projection = projectDrag(event);
    dragEndProjection.current = {
      activeId,
      overId: event.over ? String(event.over.id) : null,
      projection
    };
    setActiveDragId(null);
    setDropPreview(null);
    if (!projection) {
      return;
    }
    const { expandNodeId, ...input } = projection;
    // Dragging a row that belongs to a live multi-node selection moves the WHOLE
    // selection as one block (plan Phase 4.1c) — one applyBatch call, one undo
    // step. Skip the block path when the drop would anchor after (or under) a
    // node inside the selection, which the backend rejects; that falls back to
    // the single-node move.
    const selectedIds = selectionRangeIds(
      selection ?? null,
      structuralVisibleIds
    );
    if (
      selectedIds.length > 1 &&
      selectedIds.includes(activeId) &&
      (input.afterId === null || !selectedIds.includes(input.afterId)) &&
      (input.parentId === null || !selectedIds.includes(input.parentId))
    ) {
      void actions.applyBatch(selectedIds, {
        type: "move",
        parentId: input.parentId ?? null,
        afterId: input.afterId ?? null
      });
      return;
    }
    void actions.moveNode(
      { id: activeId, ...input },
      undefined,
      expandNodeId === undefined ? undefined : { expandNodeId }
    );
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
            busy={selectionRouter.busy}
            mutationDisabledReason={selectionMutationDisabledReason}
            status={selectionRouter.status}
            error={selectionRouter.error}
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
            <NotesExportMenu
              selectedNodeId={state.selectedId}
              selectedNodeTitle={
                state.selectedId === null
                  ? undefined
                  : (draftsByNodeId[state.selectedId]?.title ??
                    state.nodesById[state.selectedId]?.title)
              }
              zoomRootId={state.zoomRootId}
              zoomRootTitle={
                state.zoomRootId === null
                  ? undefined
                  : (draftsByNodeId[state.zoomRootId]?.title ??
                    state.nodesById[state.zoomRootId]?.title)
              }
              onFlushDrafts={actions.flushAllDrafts}
              disabled={deletingNotesData || lifecycleReadOnly}
              loading={state.status === "loading"}
            />
          </div>
        )}
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
        <div className="notes-outline-rows">
          <div
            className="notes-outline-content"
            ref={contentRef}
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
          {state.zoomRootId !== null && state.nodesById[state.zoomRootId] && (
            <NotesPageHeader
              key={state.zoomRootId}
              nodeId={state.zoomRootId}
              getVisibleNodeIds={getVisibleNodeIds}
              disabled={deletingNotesData}
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
            collisionDetection={closestCenter}
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragOver={handleDragMove}
            onDragCancel={() => {
              setActiveDragId(null);
              setDropPreview(null);
            }}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={bodyVisibleIds}
              strategy={verticalListSortingStrategy}
            >
              <ol
                className="notes-outline-list"
                data-drag-active={activeDragId === null ? undefined : "true"}
                role="list"
              >
                {bodyRows.map((row) => (
                  <li
                    className="notes-outline-item"
                    key={row.id}
                    aria-level={row.depth + 1}
                    role="listitem"
                  >
                    {bodyDropPreview?.beforeId === row.id && (
                      <DropPreviewLine preview={bodyDropPreview} />
                    )}
                    <OutlineNodeRow
                      nodeId={row.id}
                      depth={row.depth}
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
                        dragUnavailable || row.id === state.zoomRootId
                      }
                      imageDropActive={imageDropTargetId === row.id}
                      showDropPlaceholder={imageDropTargetId === row.id}
                    />
                  </li>
                ))}
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
          </DndContext>
          {state.zoomRootId !== null && state.nodesById[state.zoomRootId] && (
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
          onJump={actions.zoomTo}
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
                void executeSelectionCommand(
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
              void executeSelectionCommand(
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
