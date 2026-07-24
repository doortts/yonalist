import {
  createContext,
  type PropsWithChildren,
  useContext,
  useDeferredValue
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
  deferWhenInactive = false,
  children
}: PropsWithChildren<{
  paneId: NotesPaneId;
  /**
   * Split view renders both panes against the same workspace, so a change driven
   * by the active pane would otherwise re-render the inactive one synchronously.
   * When set, the inactive pane's state/drafts are handed through
   * {@link useDeferredValue} so React reflects them at a lower priority and
   * coalesces bursts — the final state is identical, just a frame or two later.
   * Actions are never deferred: a command started in a pane promotes it to active
   * first, so its slices are live before the command's own change lands.
   */
  deferWhenInactive?: boolean;
}>) {
  const registry = useNotesPaneRegistry();
  const pane = registry.panes[paneId];
  const shouldDefer = deferWhenInactive && registry.activePaneId !== paneId;
  const deferredStateSlice = useDeferredValue(pane.stateSlice);
  const deferredDraftsSlice = useDeferredValue(pane.draftsSlice);
  const stateSlice = shouldDefer ? deferredStateSlice : pane.stateSlice;
  const draftsSlice = shouldDefer ? deferredDraftsSlice : pane.draftsSlice;
  return (
    <NotesPaneIdContext.Provider value={paneId}>
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
