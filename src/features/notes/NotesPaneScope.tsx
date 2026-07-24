import {
  createContext,
  type PropsWithChildren,
  useContext
} from "react";
import type { NotesPaneId } from "./notesPaneSession";
import {
  NotesActionsContext,
  NotesDraftsContext,
  NotesStateContext,
  useNotesPaneRegistry
} from "./NotesWorkspaceContext";

const NotesPaneIdContext = createContext<NotesPaneId>("primary");

export function useNotesPaneId(): NotesPaneId {
  return useContext(NotesPaneIdContext);
}

export function NotesPaneScope({
  paneId,
  children
}: PropsWithChildren<{ paneId: NotesPaneId }>) {
  const pane = useNotesPaneRegistry().panes[paneId];
  return (
    <NotesPaneIdContext.Provider value={paneId}>
      <NotesActionsContext.Provider value={pane.actionsSlice}>
        <NotesStateContext.Provider value={pane.stateSlice}>
          <NotesDraftsContext.Provider value={pane.draftsSlice}>
            {children}
          </NotesDraftsContext.Provider>
        </NotesStateContext.Provider>
      </NotesActionsContext.Provider>
    </NotesPaneIdContext.Provider>
  );
}
