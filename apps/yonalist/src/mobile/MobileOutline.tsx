import { useState } from "react";
import { NotesOutline } from "../NotesOutline";
import type { NotesStore } from "../notesStore";
import type { NotesShellSnapshot } from "../store/storeSubscriptions";
// The rows are the desktop's, and so are the rules that lay them out. Without
// these the outline falls back to unstyled blocks: the row's grid collapses
// and the text drops below its own bullet. Imported here rather than in the
// entry so they arrive with the component that needs them.
import "../notes.css";
import "../handwritingFaces.css";
import "../formControls.css";

/**
 * The rows, on a phone.
 *
 * The desktop's outline is reused whole rather than rewritten: it owns the
 * caret, the drafts, selection, undo registration and the drag engine, and a
 * second copy of any of those would be a second set of answers to the same
 * questions. What the phone leaves out are the props for things it has no room
 * for — a split pane to open into, a window to close.
 */
export function MobileOutline({
  store,
  shell,
  showCompleted,
  onShowCompletedChange
}: {
  readonly store: NotesStore;
  readonly shell: NotesShellSnapshot;
  readonly showCompleted: boolean;
  readonly onShowCompletedChange: (visible: boolean) => void;
}) {
  const [zoomRootId, setZoomRootId] = useState<string | null>(null);
  // A day nobody has written in has no row in the page list to read a title
  // off, and it opens with one already decided. The store is holding the node
  // for it, which is where that title is — the same read the desktop makes.
  const page = shell.pages.find((candidate) => candidate.id === shell.activePageId)
    ?? (shell.activePageId && shell.provisionalPageId === shell.activePageId
      ? { id: shell.activePageId, title: store.getNodeSnapshot(shell.activePageId).title }
      : undefined);

  return (
    <div className="mobile-outline">
      <NotesOutline
        bare
        showCompleted={showCompleted}
        onShowCompletedChange={onShowCompletedChange}
        store={store}
        status={shell.status}
        error={shell.error}
        pendingWrites={shell.pendingWrites}
        page={page && { id: page.id, title: page.title }}
        zoomRootId={zoomRootId}
        onZoomRootChange={setZoomRootId}
        onHome={() => setZoomRootId(null)}
        onTagClick={() => {
          // Tag search is the Search tab's, and it is not built yet. Until it
          // is, a tag is text: doing nothing is honest, and half-navigating
          // somewhere would not be.
        }}
        paneId="primary"
        restoreRequest={null}
      />
    </div>
  );
}
