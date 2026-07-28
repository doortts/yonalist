import {
  createContext,
  type PropsWithChildren,
  useContext,
} from "react";
import type { NotesPaneId } from "./notesPaneSession";
import type { NotesPaneRuntimeSlice } from "./notesWorkspaceTypes";
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
}: PropsWithChildren<{
  paneId: NotesPaneId;
}>) {
  const registry = useNotesPaneRegistry();
  return (
    <NotesPaneSliceScope pane={registry.panes[paneId]}>
      {children}
    </NotesPaneSliceScope>
  );
}

export function NotesPaneSliceScope({
  pane,
  children,
}: PropsWithChildren<{
  pane: NotesPaneRuntimeSlice;
}>) {
  return (
    <NotesPaneIdContext.Provider value={pane.paneId}>
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
