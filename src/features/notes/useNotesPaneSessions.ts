import {
  useCallback,
  useMemo,
  useReducer,
  useRef,
  useState
} from "react";
import {
  createInitialNotesPaneSession,
  notesPaneSessionReducer,
  type NotesPaneId,
  type NotesPaneSessionAction,
  type NotesPaneSessionState
} from "./notesPaneSession";

export interface NotesPaneSessionsController {
  readonly activePaneId: NotesPaneId;
  readonly panes: Readonly<
    Record<NotesPaneId, NotesPaneSessionState>
  >;
  setActivePaneId(paneId: NotesPaneId): void;
  dispatchPane(
    paneId: NotesPaneId,
    action: NotesPaneSessionAction
  ): void;
  getPaneSession(paneId: NotesPaneId): NotesPaneSessionState;
}

export function useNotesPaneSessions(): NotesPaneSessionsController {
  const [primary, dispatchPrimary] = useReducer(
    notesPaneSessionReducer,
    "primary",
    createInitialNotesPaneSession
  );
  const [secondary, dispatchSecondary] = useReducer(
    notesPaneSessionReducer,
    "secondary",
    createInitialNotesPaneSession
  );
  const [activePaneId, setActivePaneId] =
    useState<NotesPaneId>("primary");
  const panes = useMemo(() => ({ primary, secondary } as const), [
    primary,
    secondary
  ]);
  const panesRef = useRef(panes);
  panesRef.current = panes;

  const dispatchPane = useCallback(
    (paneId: NotesPaneId, action: NotesPaneSessionAction): void => {
      (paneId === "primary" ? dispatchPrimary : dispatchSecondary)(action);
    },
    []
  );
  const getPaneSession = useCallback(
    (paneId: NotesPaneId): NotesPaneSessionState =>
      panesRef.current[paneId],
    []
  );

  return useMemo(
    () => ({
      activePaneId,
      panes,
      setActivePaneId,
      dispatchPane,
      getPaneSession
    }),
    [activePaneId, dispatchPane, getPaneSession, panes]
  );
}
