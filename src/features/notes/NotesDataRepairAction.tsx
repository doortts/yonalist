import { useContext, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { VaultRootContext } from "../../VaultRootContext";
import {
  notesRepairData,
  type NotesDataRepairReport
} from "../../services/notesStore";
import {
  useNotesActions,
  useNotesDrafts,
  useNotesState
} from "./NotesWorkspaceContext";

export const NOTES_DATA_REPAIR_NOTICE_KEY =
  "yonalist.notes.repairNotice.v1";

export interface NotesDataRepairActionProps {
  disabled?: boolean;
  className?: string;
  onPendingChange?(pending: boolean): void;
  reloadApplication?: () => void;
}

function isNotesDataRepairReport(
  value: unknown
): value is NotesDataRepairReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 3 &&
    keys.includes("repairedNodeCount") &&
    keys.includes("backedUpFileCount") &&
    keys.includes("backupPath") &&
    typeof record.repairedNodeCount === "number" &&
    Number.isSafeInteger(record.repairedNodeCount) &&
    record.repairedNodeCount >= 0 &&
    typeof record.backedUpFileCount === "number" &&
    Number.isSafeInteger(record.backedUpFileCount) &&
    record.backedUpFileCount >= 0 &&
    (record.backupPath === null || typeof record.backupPath === "string") &&
    (record.repairedNodeCount !== 0 ||
      (record.backedUpFileCount === 0 && record.backupPath === null))
  );
}

export function takeNotesDataRepairNotice(
  storage: Storage
): NotesDataRepairReport | null {
  const raw = storage.getItem(NOTES_DATA_REPAIR_NOTICE_KEY);
  if (raw === null) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    const report = isNotesDataRepairReport(value) ? value : null;
    storage.removeItem(NOTES_DATA_REPAIR_NOTICE_KEY);
    return report;
  } catch {
    storage.removeItem(NOTES_DATA_REPAIR_NOTICE_KEY);
    return null;
  }
}

export function readNotesDataRepairNotice(
  storage: Storage
): NotesDataRepairReport | null {
  const raw = storage.getItem(NOTES_DATA_REPAIR_NOTICE_KEY);
  if (raw === null) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    return isNotesDataRepairReport(value) ? value : null;
  } catch {
    return null;
  }
}

export function NotesDataRepairAction({
  disabled = false,
  className,
  onPendingChange,
  reloadApplication = () => window.location.reload()
}: NotesDataRepairActionProps) {
  const vaultRoot = useContext(VaultRootContext);
  const { actions } = useNotesActions();
  const { draftsByNodeId, writeError } = useNotesDrafts();
  const { state } = useNotesState();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentVaultRootRef = useRef(vaultRoot);
  const confirmationVaultRootRef = useRef<string | null>(null);
  const requestGenerationRef = useRef(0);
  currentVaultRootRef.current = vaultRoot;

  useEffect(() => {
    onPendingChange?.(pending);
  }, [onPendingChange, pending]);

  useEffect(
    () => () => {
      onPendingChange?.(false);
    },
    [onPendingChange]
  );

  useEffect(() => {
    currentVaultRootRef.current = vaultRoot;
    requestGenerationRef.current += 1;
    confirmationVaultRootRef.current = null;
    setConfirmOpen(false);
    setPending(false);
    setError(null);
  }, [vaultRoot]);

  const openConfirmation = () => {
    if (disabled || pending || !vaultRoot) {
      return;
    }
    confirmationVaultRootRef.current = vaultRoot;
    setError(null);
    setConfirmOpen(true);
  };

  const repairData = async () => {
    if (
      disabled ||
      pending ||
      !vaultRoot ||
      confirmationVaultRootRef.current !== vaultRoot
    ) {
      return;
    }
    const requestVaultRoot = vaultRoot;
    const requestGeneration = requestGenerationRef.current + 1;
    requestGenerationRef.current = requestGeneration;
    const isCurrentRequest = () =>
      requestGeneration === requestGenerationRef.current &&
      requestVaultRoot === currentVaultRootRef.current;
    confirmationVaultRootRef.current = null;
    setConfirmOpen(false);
    setPending(true);
    setError(null);

    try {
      const flushed = await actions.flushAllDrafts();
      if (!isCurrentRequest()) {
        return;
      }
      if (
        !flushed &&
        (state.status === "ready" ||
          Object.keys(draftsByNodeId).length > 0 ||
          writeError !== null)
      ) {
        throw new Error("Unsaved Yonalist edits could not be written.");
      }
      const report = await notesRepairData(requestVaultRoot);
      if (!isCurrentRequest()) {
        return;
      }
      try {
        window.sessionStorage.setItem(
          NOTES_DATA_REPAIR_NOTICE_KEY,
          JSON.stringify(report)
        );
      } catch {
        // The repair already succeeded; a missing notice must not prevent reload.
      }
      reloadApplication();
    } catch (cause) {
      if (!isCurrentRequest()) {
        return;
      }
      setError(
        cause instanceof Error
          ? cause.message
          : "Yonalist data could not be repaired."
      );
    } finally {
      if (isCurrentRequest()) {
        setPending(false);
      }
    }
  };

  return (
    <>
      <button
        type="button"
        className={className}
        disabled={disabled || pending || !vaultRoot}
        onClick={openConfirmation}
      >
        {pending ? "Repairing..." : "Repair Yonalist data"}
      </button>
      {error && (
        <p className="notes-inline-error" role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            confirmationVaultRootRef.current = null;
          }
          setConfirmOpen(nextOpen);
        }}
        title="Repair Yonalist data?"
        description="Yonalist will back up and repair unsafe ordering data. Pages, attachments, and Trash data will not be deleted."
        confirmLabel="Repair Yonalist data"
        cancelLabel="Cancel"
        onConfirm={() => void repairData()}
      />
    </>
  );
}
