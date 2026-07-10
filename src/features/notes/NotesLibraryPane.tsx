import { FileText, Plus } from "lucide-react";
import { useNotesWorkspaceContext } from "./NotesWorkspaceContext";

function pageLabel(title: string): string {
  return title.trim() || "Untitled page";
}

export function NotesLibraryPane() {
  const { actions, state } = useNotesWorkspaceContext();
  const initialLoading = state.status === "loading" && state.rootIds.length === 0;

  return (
    <section
      className="list-pane notes-library-pane"
      aria-label="Notes library"
      aria-busy={state.status === "loading"}
    >
      <div className="pane-titlebar-spacer" />
      <header className="notes-library-header">
        <h2>Notes</h2>
        <button
          className="text-button notes-new-page"
          type="button"
          disabled={state.status === "loading"}
          onClick={() => void actions.createRoot()}
        >
          <Plus size={16} aria-hidden="true" />
          <span>New page</span>
        </button>
      </header>

      <div className="notes-library-list">
        {initialLoading && <p className="notes-pane-state">Loading notes...</p>}
        {state.status === "error" && (
          <p className="notes-pane-state notes-pane-error">{state.error}</p>
        )}
        {!initialLoading &&
          state.status !== "error" &&
          state.rootIds.length === 0 && (
            <p className="notes-pane-state">No pages yet.</p>
          )}
        {state.rootIds.map((nodeId) => {
          const node = state.nodesById[nodeId];
          if (!node) {
            return null;
          }
          const label = pageLabel(node.title);
          return (
            <button
              className="notes-library-page"
              data-active={state.zoomRootId === nodeId ? "true" : undefined}
              type="button"
              key={nodeId}
              aria-label={label}
              aria-current={
                state.zoomRootId === nodeId ? "page" : undefined
              }
              onClick={() => void actions.zoomTo(nodeId)}
            >
              <FileText size={16} aria-hidden="true" />
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
