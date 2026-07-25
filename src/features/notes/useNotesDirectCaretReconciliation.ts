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
  readonly invalidatePendingCaretMove: () => void;
  readonly cancelPendingCaretMove: () => void;
} {
  const { enqueue, cancel } = useNotesFrameReconciler<{
    readonly focus: NotesHistoryFocus;
    readonly navigationVersion: number;
  }>(({ focus, navigationVersion }) => {
    if (
      !closedRef.current &&
      navigationVersionRef.current === navigationVersion
    ) {
      applyAction({ type: "caretMovedByDom", nodeId: focus.nodeId });
    }
  });
  const notifyCaretMovedByDom = useCallback(
    (nodeId: NoteId, field: NotesHistoryFocusField): void => {
      pendingPrimarySelectionRef.current = null;
      navigationVersionRef.current += 1;
      editingFocusRef.current = { nodeId, field };
      enqueue({
        focus: { nodeId, field },
        navigationVersion: navigationVersionRef.current,
      });
    },
    [
      editingFocusRef,
      enqueue,
      navigationVersionRef,
      pendingPrimarySelectionRef,
    ],
  );
  const invalidatePendingCaretMove = useCallback((): void => {
    navigationVersionRef.current += 1;
  }, [navigationVersionRef]);
  return {
    notifyCaretMovedByDom,
    invalidatePendingCaretMove,
    cancelPendingCaretMove: cancel,
  };
}
