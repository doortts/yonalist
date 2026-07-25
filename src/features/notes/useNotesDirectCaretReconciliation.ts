import { useCallback, type MutableRefObject } from "react";
import type { NoteId } from "../../domain/notes";
import type {
  NotesHistoryFocus,
  NotesHistoryFocusField
} from "./notesHistory";
import type {
  NormalizedNotesWorkspace,
  NotesSelection,
  NotesWorkspaceReducerAction
} from "./notesWorkspaceReducer";
import type {
  NotesDirectCaretClaimToken,
  NotesPendingPrimarySelection
} from "./notesWorkspaceTypes";
import { useNotesClaimBoundCaretReconciliation } from "./useNotesClaimBoundCaretReconciliation";

interface NotesDirectCaretReconciliationOptions {
  readonly pendingPrimarySelectionRef: MutableRefObject<NotesPendingPrimarySelection | null>;
  readonly navigationVersionRef: MutableRefObject<number>;
  readonly editingFocusRef: MutableRefObject<NotesHistoryFocus | null>;
  readonly selectionRef: MutableRefObject<NotesSelection | null>;
  readonly selectionRevisionRef: MutableRefObject<number>;
  readonly stateRef: MutableRefObject<NormalizedNotesWorkspace>;
  readonly closedRef: MutableRefObject<boolean>;
  readonly applyAction: (action: NotesWorkspaceReducerAction) => void;
  readonly replaceSelection: (selection: NotesSelection | null) => boolean;
}

interface PrimaryCaretBefore {
  readonly pendingPrimarySelection: NotesPendingPrimarySelection | null;
  readonly editingFocus: NotesHistoryFocus | null;
  readonly selection: NotesSelection | null;
  readonly ui: Pick<
    NormalizedNotesWorkspace,
    | "selectedId"
    | "zoomRootId"
    | "editingNoteId"
    | "pendingFocusId"
    | "pendingFocusField"
  >;
}

type PrimaryCaretRevision = readonly [
  navigationVersion: number,
  selectionRevision: number
];

function sameRevision(
  left: PrimaryCaretRevision,
  right: PrimaryCaretRevision
): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

export function useNotesDirectCaretReconciliation({
  pendingPrimarySelectionRef,
  navigationVersionRef,
  editingFocusRef,
  selectionRef,
  selectionRevisionRef,
  stateRef,
  closedRef,
  applyAction,
  replaceSelection
}: NotesDirectCaretReconciliationOptions): {
  readonly notifyCaretMovedByDom: (
    nodeId: NoteId,
    field: NotesHistoryFocusField,
    claimToken?: NotesDirectCaretClaimToken
  ) => void;
  readonly settleDirectCaretClaim: (
    claimToken: NotesDirectCaretClaimToken,
    claimed: boolean
  ) => boolean;
  readonly invalidatePendingCaretMove: () => void;
  readonly cancelPendingCaretMove: () => void;
} {
  const {
    notify,
    settle,
    invalidate,
    cancel
  } = useNotesClaimBoundCaretReconciliation<
      NotesHistoryFocus,
      PrimaryCaretBefore,
      PrimaryCaretRevision
    >({
      captureBefore: () => {
        const previous = stateRef.current;
        return {
          pendingPrimarySelection: pendingPrimarySelectionRef.current,
          editingFocus: editingFocusRef.current,
          selection: selectionRef.current,
          ui: {
            selectedId: previous.selectedId,
            zoomRootId: previous.zoomRootId,
            editingNoteId: previous.editingNoteId,
            pendingFocusId: previous.pendingFocusId,
            pendingFocusField: previous.pendingFocusField
          }
        };
      },
      prepare: (focus) => {
        pendingPrimarySelectionRef.current = null;
        navigationVersionRef.current += 1;
        editingFocusRef.current = focus;
      },
      currentRevision: () => [
        navigationVersionRef.current,
        selectionRevisionRef.current
      ],
      revisionsEqual: sameRevision,
      canApply: () => !closedRef.current,
      apply: (focus) => {
        applyAction({ type: "caretMovedByDom", nodeId: focus.nodeId });
      },
      rollback: (before, applied) => {
        pendingPrimarySelectionRef.current = before.pendingPrimarySelection;
        editingFocusRef.current = before.editingFocus;
        if (!applied) return;
        applyAction({ type: "setUiState", ...before.ui });
        replaceSelection(before.selection);
      }
    });
  const notifyCaretMovedByDom = useCallback(
    (
      nodeId: NoteId,
      field: NotesHistoryFocusField,
      claimToken?: NotesDirectCaretClaimToken
    ): void => {
      notify({ nodeId, field }, claimToken);
    },
    [notify]
  );
  const invalidatePendingCaretMove = useCallback((): void => {
    invalidate();
    navigationVersionRef.current += 1;
  }, [invalidate, navigationVersionRef]);
  return {
    notifyCaretMovedByDom,
    settleDirectCaretClaim: settle,
    invalidatePendingCaretMove,
    cancelPendingCaretMove: cancel
  };
}
