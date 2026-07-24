import type { NoteId, NoteNode } from "../../domain/notes";
import type { NotesLibraryView } from "./notesWorkspaceTypes";

export function githubProjectionLeaseRequested(input: {
  readonly githubRootId: NoteId;
  readonly libraryView: NotesLibraryView;
  readonly zoomRootId: NoteId | null;
  readonly githubRoot: NoteNode | undefined;
}): boolean {
  return (
    input.zoomRootId === input.githubRootId ||
    (input.libraryView === "all" &&
      input.zoomRootId === null &&
      input.githubRoot !== undefined &&
      !input.githubRoot.isCollapsed)
  );
}
