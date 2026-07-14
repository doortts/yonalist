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
import type { NoteId } from "../../domain/notes";
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
import {
  useNotesActions,
  useNotesDrafts,
  useNotesState
} from "./NotesWorkspaceContext";
import {
  deriveOutlineDropPreview,
  OUTLINE_INDENT_PX,
  OUTLINE_NARROW_INDENT_PX,
  OUTLINE_NARROW_MEDIA_QUERY,
  projectOutlineDrop,
  type OutlineDropPreview
} from "./outlineDrag";
import { selectionRangeIds } from "./notesWorkspaceReducer";
import {
  deriveOutlineBodyRows,
  flattenVisibleOutlineRows,
  parentTrail
} from "./outlineTree";
import { OutlineNodeRow } from "./OutlineNodeRow";
import type { UseNotesWorkspaceResult } from "./useNotesWorkspace";

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
  const { actions, retryLastFailedWrite } = useNotesActions();
  const vaultRoot = useContext(VaultRootContext);
  const {
    deletingNotesData,
    libraryView,
    locallyExpandedNodeIds,
    state
  } = useNotesState();
  const {
    attachmentUploadErrorsByNodeId,
    attachmentUploadRetryAttemptIdsByNodeId,
    draftsByNodeId,
    selection,
    writeError
  } = useNotesDrafts();
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
  const contentRef = useRef<HTMLDivElement>(null);
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
  // The multi-node selection range materialized against the SAME visible-row
  // ordering keyboard nav uses, then handed to each row as an atomic `isSelected`
  // boolean. Deriving a stable Set here (rather than passing the selection object
  // down) keeps OutlineNodeRow's memo intact: only rows whose membership flips
  // get a changed prop. Selection lives on the drafts slice, so rows — which read
  // the state slice but not drafts — never re-render merely because it changed.
  const selectedIdSet = useMemo(
    () => new Set(selectionRangeIds(selection ?? null, structuralVisibleIds)),
    [selection, structuralVisibleIds]
  );
  // Rows read the live selection at keydown time (to extend the head) through
  // this stable accessor, mirroring getVisibleNodeIds — the row never subscribes
  // to the selection, so its memo is preserved.
  const selectionRef = useRef(selection ?? null);
  selectionRef.current = selection ?? null;
  const getSelection = useCallback(() => selectionRef.current, []);
  const bodyVisibleIds = useMemo(
    () => bodyRows.map((row) => row.id),
    [bodyRows]
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
                      getSelection={getSelection}
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
        </TooltipProvider>
      </section>
    </NotesExportControllerProvider>
  );
}
