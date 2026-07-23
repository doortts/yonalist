import { useCallback, useMemo, useRef, useState } from "react";
import type { NoteId } from "../../domain/notes";
import type {
  NotesHistoryFocusField
} from "./notesHistory";
import type { NotesPaneId } from "./notesPaneSession";

export interface NotesEditingLease {
  readonly paneId: NotesPaneId;
  readonly nodeId: NoteId;
  readonly field: NotesHistoryFocusField;
}

export interface NotesEditingLeaseController {
  readonly lease: NotesEditingLease | null;
  readonly composing: Readonly<Record<NotesPaneId, boolean>>;
  setCompositionActive(paneId: NotesPaneId, active: boolean): void;
  claim(
    request: NotesEditingLease,
    flushNodeDraft: (nodeId: NoteId) => Promise<boolean>
  ): Promise<boolean>;
  release(paneId: NotesPaneId, nodeId?: NoteId): void;
  canEdit(request: NotesEditingLease): boolean;
  structuralCommandsAllowed(): boolean;
}

const initialComposition = { primary: false, secondary: false } as const;

export function useNotesEditingLease(): NotesEditingLeaseController {
  const [lease, setLease] = useState<NotesEditingLease | null>(null);
  const leaseRef = useRef(lease);
  leaseRef.current = lease;
  const [composing, setComposing] =
    useState<Record<NotesPaneId, boolean>>(initialComposition);
  const composingRef = useRef(composing);
  composingRef.current = composing;
  const claimRevisionRef = useRef(0);

  const setCompositionActive = useCallback(
    (paneId: NotesPaneId, active: boolean): void => {
      const current = composingRef.current;
      if (current[paneId] === active) return;
      const next = { ...current, [paneId]: active };
      composingRef.current = next;
      setComposing(next);
    },
    []
  );

  const claim = useCallback(
    async (
      request: NotesEditingLease,
      flushNodeDraft: (nodeId: NoteId) => Promise<boolean>
    ): Promise<boolean> => {
      const current = leaseRef.current;
      if (
        current?.paneId === request.paneId &&
        current.nodeId === request.nodeId &&
        current.field === request.field
      ) {
        return true;
      }
      if (current && composingRef.current[current.paneId]) return false;
      const revision = ++claimRevisionRef.current;
      if (
        current &&
        current.nodeId !== request.nodeId &&
        !(await flushNodeDraft(current.nodeId))
      ) {
        return false;
      }
      if (claimRevisionRef.current !== revision) return false;
      leaseRef.current = request;
      setLease(request);
      return true;
    },
    []
  );

  const release = useCallback(
    (paneId: NotesPaneId, nodeId?: NoteId): void => {
      const current = leaseRef.current;
      if (
        !current ||
        current.paneId !== paneId ||
        (nodeId !== undefined && current.nodeId !== nodeId)
      ) {
        return;
      }
      claimRevisionRef.current += 1;
      leaseRef.current = null;
      setLease(null);
    },
    []
  );

  return useMemo(
    () => ({
      lease,
      composing,
      setCompositionActive,
      claim,
      release,
      canEdit: (request: NotesEditingLease) => {
        const current = leaseRef.current;
        return (
          current === null ||
          (current.paneId === request.paneId &&
            current.nodeId === request.nodeId &&
            current.field === request.field)
        );
      },
      structuralCommandsAllowed: () =>
        !composingRef.current.primary && !composingRef.current.secondary
    }),
    [claim, composing, lease, release, setCompositionActive]
  );
}
