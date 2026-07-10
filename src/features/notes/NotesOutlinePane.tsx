import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  type Announcements,
  type DragEndEvent,
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
import { useCallback, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import {
  IconTooltip,
  TooltipProvider
} from "../../components/ui/Tooltip";
import type { NoteId } from "../../domain/notes";
import { useNotesWorkspaceContext } from "./NotesWorkspaceContext";
import { projectOutlineDrop } from "./outlineDrag";
import { flattenVisibleOutlineRows, parentTrail } from "./outlineTree";
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

export function NotesOutlinePane() {
  const workspace = useNotesWorkspaceContext();
  const {
    actions,
    deletingNotesData,
    libraryView,
    locallyExpandedNodeIds,
    state
  } = workspace;
  const [activeDragId, setActiveDragId] = useState<NoteId | null>(null);
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
  const rows = flattenVisibleOutlineRows(
    state,
    state.zoomRootId,
    locallyExpandedNodeIds
  );
  const visibleIds = rows.map((row) => row.id);
  const initialLoading = state.status === "loading" && state.rootIds.length === 0;
  const dragUnavailable =
    deletingNotesData ||
    trashView ||
    state.status === "loading" ||
    rows.length === 0;
  const projectDragEnd = useCallback(
    (event: DragEndEvent) => {
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
        rows,
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
      rows,
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
    if (
      dragUnavailable ||
      id === state.zoomRootId ||
      !rows.some((row) => row.id === id)
    ) {
      setActiveDragId(null);
      return;
    }
    setActiveDragId(id);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const projection = projectDragEnd(event);
    dragEndProjection.current = {
      activeId,
      overId: event.over ? String(event.over.id) : null,
      projection
    };
    setActiveDragId(null);
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
    >
      <TooltipProvider>
        <NotesBreadcrumb
          disabled={deletingNotesData}
          trashView={trashView}
          onRequestEmptyTrash={() => setEmptyTrashConfirmOpen(true)}
        />
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
            visibleIds.length === 0 && (
              <p className="notes-pane-state">No outline yet.</p>
            )}
          {state.status === "error" && state.rootIds.length > 0 && (
            <p className="notes-inline-error" role="alert">
              {state.error}
            </p>
          )}
          <DndContext
            accessibility={{
              announcements,
              screenReaderInstructions: outlineScreenReaderInstructions
            }}
            collisionDetection={closestCenter}
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragCancel={() => setActiveDragId(null)}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={visibleIds}
              strategy={verticalListSortingStrategy}
            >
              <ol
                className="notes-outline-list"
                data-drag-active={activeDragId === null ? undefined : "true"}
                role="list"
              >
                {rows.map((row) => (
                  <li
                    className="notes-outline-item"
                    key={row.id}
                    aria-level={row.depth + 1}
                    role="listitem"
                  >
                    <OutlineNodeRow
                      nodeId={row.id}
                      depth={row.depth}
                      readOnly={trashView}
                      disabled={deletingNotesData}
                      locallyExpanded={locallyExpandedNodeIds.has(row.id)}
                      dragDisabled={
                        dragUnavailable || row.id === state.zoomRootId
                      }
                    />
                  </li>
                ))}
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
