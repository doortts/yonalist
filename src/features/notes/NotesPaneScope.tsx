import {
  createContext,
  type PropsWithChildren,
  useContext,
  useDeferredValue,
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
  deferWhenInactive = false,
  children
}: PropsWithChildren<{
  paneId: NotesPaneId;
  deferWhenInactive?: boolean;
}>) {
  const registry = useNotesPaneRegistry();
  return (
    <NotesPaneSliceScope
      pane={registry.panes[paneId]}
      activePaneId={registry.activePaneId}
      deferWhenInactive={deferWhenInactive}
    >
      {children}
    </NotesPaneSliceScope>
  );
}

export function NotesPaneSliceScope({
  pane,
  activePaneId,
  deferWhenInactive = false,
  children,
}: PropsWithChildren<{
  pane: NotesPaneRuntimeSlice;
  activePaneId: NotesPaneId;
  deferWhenInactive?: boolean;
}>) {
  const deferredStateSlice = useDeferredValue(pane.stateSlice);
  const deferredDraftsSlice = useDeferredValue(pane.draftsSlice);
  const shouldDefer =
    deferWhenInactive && activePaneId !== pane.paneId;
  const stateSlice = shouldDefer ? deferredStateSlice : pane.stateSlice;
  const draftsSlice = shouldDefer ? deferredDraftsSlice : pane.draftsSlice;
  return (
    <NotesPaneIdContext.Provider value={pane.paneId}>
      <NotesActionsContext.Provider value={pane.actionsSlice}>
        <NotesStateContext.Provider value={stateSlice}>
          <NotesDraftsContext.Provider value={draftsSlice}>
            {children}
          </NotesDraftsContext.Provider>
        </NotesStateContext.Provider>
      </NotesActionsContext.Provider>
    </NotesPaneIdContext.Provider>
  );
}
