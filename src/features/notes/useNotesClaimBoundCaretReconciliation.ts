import { useCallback, useRef } from "react";
import type { NotesDirectCaretClaimToken } from "./notesWorkspaceTypes";

export function createNotesDirectCaretClaimToken(): NotesDirectCaretClaimToken {
  return {} as NotesDirectCaretClaimToken;
}

interface NotesClaimBoundCaretAdapter<Move, Before, Revision> {
  captureBefore(): Before;
  prepare(move: Move): void;
  currentRevision(): Revision;
  revisionsEqual(left: Revision, right: Revision): boolean;
  canApply(move: Move): boolean;
  apply(move: Move): void;
  rollback(before: Before, applied: boolean): void;
}

interface ClaimRecord<Before, Revision> {
  readonly before: Before;
  readonly pendingRevision: Revision;
  appliedRevision: Revision | null;
}

export function useNotesClaimBoundCaretReconciliation<
  Move,
  Before,
  Revision
>(
  adapter: NotesClaimBoundCaretAdapter<Move, Before, Revision>
): {
  notify(move: Move, claimToken?: NotesDirectCaretClaimToken): void;
  settle(claimToken: NotesDirectCaretClaimToken, claimed: boolean): boolean;
  invalidate(): void;
  cancel(): void;
} {
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;
  const activeTokenRef = useRef<NotesDirectCaretClaimToken | null>(null);
  const claimRecordsRef = useRef(
    new Map<NotesDirectCaretClaimToken, ClaimRecord<Before, Revision>>()
  );
  const notify = useCallback(
    (move: Move, claimToken?: NotesDirectCaretClaimToken): void => {
      const token = claimToken ?? createNotesDirectCaretClaimToken();
      const current = adapterRef.current;
      const captured = claimToken
        ? { before: current.captureBefore() }
        : null;
      current.prepare(move);
      const revision = current.currentRevision();
      activeTokenRef.current = token;
      if (claimToken && captured !== null) {
        claimRecordsRef.current.set(token, {
          before: captured.before,
          pendingRevision: revision,
          appliedRevision: null
        });
      }
      if (
        activeTokenRef.current !== token ||
        !current.revisionsEqual(current.currentRevision(), revision) ||
        !current.canApply(move)
      ) {
        activeTokenRef.current = null;
        return;
      }
      current.apply(move);
      const record = claimRecordsRef.current.get(token);
      if (record) {
        record.appliedRevision = current.currentRevision();
      } else {
        activeTokenRef.current = null;
      }
    },
    []
  );
  const settle = useCallback(
    (claimToken: NotesDirectCaretClaimToken, claimed: boolean): boolean => {
      const record = claimRecordsRef.current.get(claimToken);
      if (!record) return false;
      claimRecordsRef.current.delete(claimToken);
      const current = adapterRef.current;
      const expectedRevision =
        record.appliedRevision ?? record.pendingRevision;
      if (
        activeTokenRef.current !== claimToken ||
        !current.revisionsEqual(
          current.currentRevision(),
          expectedRevision
        )
      ) {
        if (activeTokenRef.current === claimToken) {
          activeTokenRef.current = null;
        }
        return true;
      }
      if (claimed) {
        if (record.appliedRevision !== null) {
          activeTokenRef.current = null;
        }
        return true;
      }
      activeTokenRef.current = null;
      current.rollback(record.before, record.appliedRevision !== null);
      return true;
    },
    []
  );
  const invalidate = useCallback((): void => {
    activeTokenRef.current = null;
  }, []);
  const cancel = useCallback((): void => {
    activeTokenRef.current = null;
  }, []);
  return { notify, settle, invalidate, cancel };
}
