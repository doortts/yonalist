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
import { ChevronRight, Home } from "lucide-react";
import { useMemo, useState } from "react";
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

function NotesBreadcrumb() {
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
              onClick={() => void actions.zoomTo(nodeId)}
            >
              {label}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

export function NotesOutlinePane() {
  const workspace = useNotesWorkspaceContext();
  const { actions, state } = workspace;
  const [activeDragId, setActiveDragId] = useState<NoteId | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const rows = flattenVisibleOutlineRows(state, state.zoomRootId);
  const visibleIds = rows.map((row) => row.id);
  const initialLoading = state.status === "loading" && state.rootIds.length === 0;
  const dragUnavailable = state.status === "loading" || rows.length === 0;
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
      onDragEnd: ({ active, over }) =>
        over
          ? `Dropped ${labelFor(active.id)} at ${labelFor(over.id)}.`
          : `Could not drop ${labelFor(active.id)}.`,
      onDragCancel: ({ active }) => `Cancelled moving ${labelFor(active.id)}.`
    };
  }, [state.nodesById]);

  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
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
    setActiveDragId(null);
    if (
      dragUnavailable ||
      !event.over ||
      activeId === state.zoomRootId ||
      (activeDragId !== null && activeDragId !== activeId)
    ) {
      return;
    }

    const projection = projectOutlineDrop(
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
      aria-busy={state.status === "loading"}
    >
      <TooltipProvider>
        <NotesBreadcrumb />
        <div className="notes-outline-rows">
          {initialLoading && (
            <p className="notes-pane-state">Loading notes...</p>
          )}
          {state.status === "error" && state.rootIds.length === 0 && (
            <p className="notes-pane-state notes-pane-error">{state.error}</p>
          )}
          {!initialLoading &&
            state.status !== "error" &&
            visibleIds.length === 0 && (
              <p className="notes-pane-state">No outline yet.</p>
            )}
          {state.status === "error" && state.rootIds.length > 0 && (
            <p className="notes-inline-error">{state.error}</p>
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
              >
                {rows.map((row) => (
                  <li
                    className="notes-outline-item"
                    key={row.id}
                    aria-level={row.depth + 1}
                  >
                    <OutlineNodeRow
                      nodeId={row.id}
                      depth={row.depth}
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
      </TooltipProvider>
    </section>
  );
}
