import { useCallback, useRef, type MutableRefObject } from "react";
import type { NoteId } from "../../domain/notes";
import type {
  NotesHistoryFocus,
  NotesHistoryFocusField,
} from "./notesHistory";
import type {
  NormalizedNotesWorkspace,
  NotesWorkspaceReducerAction,
} from "./notesWorkspaceReducer";
import type { NotesPendingPrimarySelection } from "./notesWorkspaceTypes";
import { useNotesFrameReconciler } from "./useNotesFrameReconciler";

interface NotesDirectCaretReconciliationOptions {
  readonly pendingPrimarySelectionRef: MutableRefObject<NotesPendingPrimarySelection | null>;
  readonly navigationVersionRef: MutableRefObject<number>;
  readonly editingFocusRef: MutableRefObject<NotesHistoryFocus | null>;
  readonly stateRef: MutableRefObject<NormalizedNotesWorkspace>;
  readonly closedRef: MutableRefObject<boolean>;
  readonly applyAction: (action: NotesWorkspaceReducerAction) => void;
}

export function useNotesDirectCaretReconciliation({
  pendingPrimarySelectionRef,
  navigationVersionRef,
  editingFocusRef,
  stateRef,
  closedRef,
  applyAction,
}: NotesDirectCaretReconciliationOptions): {
  readonly notifyCaretMovedByDom: (
    nodeId: NoteId,
    field: NotesHistoryFocusField,
    claimAttempt?: object,
  ) => void;
  readonly settleDirectCaretClaim: (
    claimAttempt: object,
    claimed: boolean,
  ) => boolean;
  readonly invalidatePendingCaretMove: () => void;
  readonly cancelPendingCaretMove: () => void;
} {
  const activeAuthorityRef = useRef<object | null>(null);
  const claimRecordsRef = useRef(
    new Map<
      object,
      {
        readonly navigationVersion: number;
        readonly previousFocus: NotesHistoryFocus | null;
        readonly previousUi: Pick<
          NormalizedNotesWorkspace,
          | "selectedId"
          | "zoomRootId"
          | "editingNoteId"
          | "pendingFocusId"
          | "pendingFocusField"
        >;
        applied: boolean;
      }
    >(),
  );
  const { enqueue, cancel } = useNotesFrameReconciler<{
    readonly focus: NotesHistoryFocus;
    readonly navigationVersion: number;
    readonly authority: object;
  }>(({ focus, navigationVersion, authority }) => {
    if (
      !closedRef.current &&
      activeAuthorityRef.current === authority &&
      navigationVersionRef.current === navigationVersion
    ) {
      applyAction({ type: "caretMovedByDom", nodeId: focus.nodeId });
      const record = claimRecordsRef.current.get(authority);
      if (record) record.applied = true;
      else activeAuthorityRef.current = null;
    }
  });
  const notifyCaretMovedByDom = useCallback(
    (
      nodeId: NoteId,
      field: NotesHistoryFocusField,
      claimAttempt?: object,
    ): void => {
      const authority = claimAttempt ?? {};
      const previousFocus = editingFocusRef.current;
      const previousState = stateRef.current;
      pendingPrimarySelectionRef.current = null;
      navigationVersionRef.current += 1;
      const navigationVersion = navigationVersionRef.current;
      editingFocusRef.current = { nodeId, field };
      activeAuthorityRef.current = authority;
      if (claimAttempt) {
        claimRecordsRef.current.set(authority, {
          navigationVersion,
          previousFocus,
          previousUi: {
            selectedId: previousState.selectedId,
            zoomRootId: previousState.zoomRootId,
            editingNoteId: previousState.editingNoteId,
            pendingFocusId: previousState.pendingFocusId,
            pendingFocusField: previousState.pendingFocusField,
          },
          applied: false,
        });
      }
      enqueue({
        focus: { nodeId, field },
        navigationVersion,
        authority,
      });
    },
    [
      editingFocusRef,
      enqueue,
      navigationVersionRef,
      pendingPrimarySelectionRef,
      stateRef,
    ],
  );
  const settleDirectCaretClaim = useCallback(
    (claimAttempt: object, claimed: boolean): boolean => {
      const record = claimRecordsRef.current.get(claimAttempt);
      if (!record) return false;
      claimRecordsRef.current.delete(claimAttempt);
      if (
        activeAuthorityRef.current !== claimAttempt ||
        navigationVersionRef.current !== record.navigationVersion
      ) {
        if (activeAuthorityRef.current === claimAttempt) {
          activeAuthorityRef.current = null;
        }
        return true;
      }
      if (claimed) {
        if (record.applied) activeAuthorityRef.current = null;
        return true;
      }
      activeAuthorityRef.current = null;
      navigationVersionRef.current += 1;
      editingFocusRef.current = record.previousFocus;
      if (record.applied) {
        applyAction({ type: "setUiState", ...record.previousUi });
      }
      return true;
    },
    [applyAction, editingFocusRef, navigationVersionRef],
  );
  const invalidatePendingCaretMove = useCallback((): void => {
    activeAuthorityRef.current = null;
    navigationVersionRef.current += 1;
  }, [navigationVersionRef]);
  return {
    notifyCaretMovedByDom,
    settleDirectCaretClaim,
    invalidatePendingCaretMove,
    cancelPendingCaretMove: cancel,
  };
}
