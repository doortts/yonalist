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
import { ChevronRight, Home, Trash2 } from "lucide-react";
import {
  type CSSProperties,
  useCallback,
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
import { NotesExportMenu } from "./NotesExportMenu";
import { NotesPageHeader } from "./NotesPageHeader";
import { useNotesWorkspaceContext } from "./NotesWorkspaceContext";
import {
  deriveOutlineDropPreview,
  OUTLINE_INDENT_PX,
  projectOutlineDrop,
  type OutlineDropPreview
} from "./outlineDrag";
import {
  deriveOutlineBodyRows,
  flattenVisibleOutlineRows,
  parentTrail
} from "./outlineTree";
import { OutlineNodeRow } from "./OutlineNodeRow";

const outlineScreenReaderInstructions = {
  draggable:
    "To pick up a note, press Space or Enter. Use Arrow Up and Arrow Down to choose a visible row. Press Space or Enter to drop, or Escape to cancel."
};

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
  const { actions, state } = useNotesWorkspaceContext();
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
          "--notes-drop-column-count": preview.depth + 1
        } as CSSProperties
      }
    />
  );
}

export function NotesOutlinePane() {
  const workspace = useNotesWorkspaceContext();
  const {
    actions,
    deletingNotesData,
    draftsByNodeId,
    libraryView,
    locallyExpandedNodeIds,
    state
  } = workspace;
  const [activeDragId, setActiveDragId] = useState<NoteId | null>(null);
  const [dropPreview, setDropPreview] = useState<OutlineDropPreview | null>(null);
  const [emptyTrashConfirmOpen, setEmptyTrashConfirmOpen] = useState(false);
  const trashView = libraryView === "trash";
  // dnd-kit invokes onDragEnd before its announcement monitor, which omits delta.
  const dragEndProjection = useRef<{
    activeId: NoteId;
    overId: NoteId | null;
    projection: ReturnType<typeof projectOutlineDrop>;
  } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const structuralRows = flattenVisibleOutlineRows(
    state,
    state.zoomRootId,
    locallyExpandedNodeIds
  );
  const bodyRows = deriveOutlineBodyRows(structuralRows, state.zoomRootId);
  const structuralVisibleIds = structuralRows.map((row) => row.id);
  const bodyVisibleIds = bodyRows.map((row) => row.id);
  const bodyDropPreview =
    dropPreview && state.zoomRootId !== null
      ? { ...dropPreview, depth: Math.max(0, dropPreview.depth - 1) }
      : dropPreview;
  const initialLoading = state.status === "loading" && state.rootIds.length === 0;
  const dragUnavailable =
    deletingNotesData ||
    trashView ||
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
        }
      );
    },
    [
      activeDragId,
      dragUnavailable,
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
    void actions.moveNode(
      { id: activeId, ...input },
      undefined,
      expandNodeId === undefined ? undefined : { expandNodeId }
    );
  };

  return (
    <section
      className="notes-outline"
      aria-label="Notes outline"
      aria-busy={state.status === "loading" || deletingNotesData}
      style={
        {
          "--notes-outline-indent": `${OUTLINE_INDENT_PX}px`
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
            onFlushNodeDraft={actions.flushNodeDraft}
            disabled={deletingNotesData || trashView}
            loading={state.status === "loading"}
          />
        </div>
        <div className="notes-outline-rows">
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
            structuralVisibleIds.length === 0 && (
              <p className="notes-pane-state">No outline yet.</p>
            )}
          {state.status === "error" && state.rootIds.length > 0 && (
            <p className="notes-inline-error" role="alert">
              {state.error}
            </p>
          )}
          {state.zoomRootId !== null && state.nodesById[state.zoomRootId] && (
            <NotesPageHeader
              nodeId={state.zoomRootId}
              disabled={deletingNotesData || trashView}
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
                      readOnly={trashView}
                      disabled={deletingNotesData}
                      locallyExpanded={locallyExpandedNodeIds.has(row.id)}
                      dragDisabled={
                        dragUnavailable || row.id === state.zoomRootId
                      }
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
        </div>
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
      </TooltipProvider>
    </section>
  );
}
