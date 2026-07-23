import type { PropsWithChildren } from "react";
import type { NotesPaneId } from "./notesPaneSession";
import {
  NotesActionsContext,
  NotesDraftsContext,
  NotesStateContext,
  useNotesPaneRegistry
} from "./NotesWorkspaceContext";

export function NotesPaneScope({
  paneId,
  children
}: PropsWithChildren<{ paneId: NotesPaneId }>) {
  const pane = useNotesPaneRegistry().panes[paneId];
  return (
    <NotesActionsContext.Provider value={pane.actionsSlice}>
      <NotesStateContext.Provider value={pane.stateSlice}>
        <NotesDraftsContext.Provider value={pane.draftsSlice}>
          {children}
        </NotesDraftsContext.Provider>
      </NotesStateContext.Provider>
    </NotesActionsContext.Provider>
  );
}
