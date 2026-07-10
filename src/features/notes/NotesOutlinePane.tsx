import { ChevronRight, Home } from "lucide-react";
import { TooltipProvider } from "../../components/ui/Tooltip";
import type { NoteId, NoteNode } from "../../domain/notes";
import { useNotesWorkspaceContext } from "./NotesWorkspaceContext";
import type { NormalizedNotesWorkspace } from "./notesWorkspaceReducer";
import { parentTrail, visibleNodeIds } from "./outlineTree";
import { OutlineNodeRow } from "./OutlineNodeRow";

function nodeDepth(
  state: NormalizedNotesWorkspace,
  nodeId: NoteId,
  zoomRootId: NoteId | null
): number {
  let depth = 0;
  let currentId: NoteId | null = nodeId;
  const visited = new Set<NoteId>();

  while (
    currentId !== null &&
    currentId !== zoomRootId &&
    !visited.has(currentId)
  ) {
    visited.add(currentId);
    const current: NoteNode | undefined = state.nodesById[currentId];
    if (!current?.parentId) {
      break;
    }
    depth += 1;
    currentId = current.parentId;
  }

  return depth;
}

function NotesBreadcrumb() {
  const { actions, state } = useNotesWorkspaceContext();
  const trail = state.zoomRootId ? parentTrail(state, state.zoomRootId) : [];

  return (
    <nav className="notes-breadcrumb" aria-label="Notes breadcrumb">
      <button
        className="notes-breadcrumb-button notes-breadcrumb-home"
        type="button"
        aria-label="All notes"
        aria-current={state.zoomRootId === null ? "page" : undefined}
        onClick={() => void actions.zoomTo(null)}
      >
        <Home size={15} aria-hidden="true" />
      </button>
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
  const { state } = workspace;
  const visibleIds = visibleNodeIds(state, state.zoomRootId);
  const initialLoading = state.status === "loading" && state.rootIds.length === 0;

  return (
    <section
      className="notes-outline"
      aria-label="Notes outline"
      aria-busy={state.status === "loading"}
    >
      <NotesBreadcrumb />
      <div className="notes-outline-rows">
        {initialLoading && <p className="notes-pane-state">Loading notes...</p>}
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
        <TooltipProvider>
          {visibleIds.map((nodeId) => (
            <OutlineNodeRow
              key={nodeId}
              nodeId={nodeId}
              depth={nodeDepth(state, nodeId, state.zoomRootId)}
            />
          ))}
        </TooltipProvider>
      </div>
    </section>
  );
}
