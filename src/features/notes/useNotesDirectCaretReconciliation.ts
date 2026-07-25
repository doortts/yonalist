import { useCallback, type MutableRefObject } from "react";
import type { NoteId } from "../../domain/notes";
import type {
  NotesHistoryFocus,
  NotesHistoryFocusField,
} from "./notesHistory";
import type { NotesWorkspaceReducerAction } from "./notesWorkspaceReducer";
import type { NotesPendingPrimarySelection } from "./notesWorkspaceTypes";
import { useNotesFrameReconciler } from "./useNotesFrameReconciler";

interface NotesDirectCaretReconciliationOptions {
  readonly pendingPrimarySelectionRef: MutableRefObject<NotesPendingPrimarySelection | null>;
  readonly navigationVersionRef: MutableRefObject<number>;
  readonly editingFocusRef: MutableRefObject<NotesHistoryFocus | null>;
  readonly closedRef: MutableRefObject<boolean>;
  readonly applyAction: (action: NotesWorkspaceReducerAction) => void;
}

export function useNotesDirectCaretReconciliation({
  pendingPrimarySelectionRef,
  navigationVersionRef,
  editingFocusRef,
  closedRef,
  applyAction,
}: NotesDirectCaretReconciliationOptions): {
  readonly notifyCaretMovedByDom: (
    nodeId: NoteId,
    field: NotesHistoryFocusField,
  ) => void;
  readonly cancelPendingCaretMove: () => void;
} {
  const { enqueue, cancel } = useNotesFrameReconciler<NotesHistoryFocus>(
    ({ nodeId }) => {
      if (!closedRef.current) {
        applyAction({ type: "caretMovedByDom", nodeId });
      }
    },
  );
  const notifyCaretMovedByDom = useCallback(
    (nodeId: NoteId, field: NotesHistoryFocusField): void => {
      pendingPrimarySelectionRef.current = null;
      navigationVersionRef.current += 1;
      editingFocusRef.current = { nodeId, field };
      enqueue({ nodeId, field });
    },
    [
      editingFocusRef,
      enqueue,
      navigationVersionRef,
      pendingPrimarySelectionRef,
    ],
  );
  return {
    notifyCaretMovedByDom,
    cancelPendingCaretMove: cancel,
  };
}
