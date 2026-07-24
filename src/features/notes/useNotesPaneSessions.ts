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
  getActivePaneId(): NotesPaneId;
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
  const [activePaneId, setActivePaneIdState] =
    useState<NotesPaneId>("primary");
  const activePaneIdRef = useRef<NotesPaneId>(activePaneId);
  activePaneIdRef.current = activePaneId;
  const panes = useMemo(() => ({ primary, secondary } as const), [
    primary,
    secondary
  ]);
  const panesRef = useRef(panes);
  panesRef.current = panes;

  const dispatchPane = useCallback(
    (paneId: NotesPaneId, action: NotesPaneSessionAction): void => {
      panesRef.current = {
        ...panesRef.current,
        [paneId]: notesPaneSessionReducer(panesRef.current[paneId], action)
      };
      (paneId === "primary" ? dispatchPrimary : dispatchSecondary)(action);
    },
    []
  );
  const setActivePaneId = useCallback((paneId: NotesPaneId): void => {
    activePaneIdRef.current = paneId;
    setActivePaneIdState(paneId);
  }, []);
  const getActivePaneId = useCallback(() => activePaneIdRef.current, []);
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
      getActivePaneId,
      dispatchPane,
      getPaneSession
    }),
    [
      activePaneId,
      dispatchPane,
      getActivePaneId,
      getPaneSession,
      panes,
      setActivePaneId
    ]
  );
}
