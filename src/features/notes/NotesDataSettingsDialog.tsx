import { Dialog } from "@base-ui/react/dialog";
import { AlertTriangle, Database, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import "../../components/ui/dialog.css";
import { useNotesWorkspaceContext } from "./NotesWorkspaceContext";
import { isNotesDraftsFlushFailedError } from "./useNotesWorkspace";

interface NotesDataSettingsDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

export function NotesDataSettingsDialog({
  open,
  onOpenChange
}: NotesDataSettingsDialogProps) {
  const { actions, deletingNotesData } = useNotesWorkspaceContext();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [deletionRequestPending, setDeletionRequestPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachmentWarning, setAttachmentWarning] = useState<string | null>(
    null
  );
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const deleting = deletingNotesData || deletionRequestPending;

  useEffect(() => {
    if (error && !deleting) {
      deleteTriggerRef.current?.focus();
    }
  }, [deleting, error]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && deleting) {
      return;
    }
    if (!nextOpen) {
      setConfirmOpen(false);
      setDiscardConfirmOpen(false);
      setError(null);
      setAttachmentWarning(null);
    }
    onOpenChange(nextOpen);
  };

  const deleteNotesData = async (discardDrafts = false) => {
    if (deleting) {
      return;
    }
    setDeletionRequestPending(true);
    setError(null);
    setAttachmentWarning(null);
    try {
      const result = await actions.deleteAllNotesData(
        discardDrafts ? { discardDrafts: true } : undefined
      );
      setConfirmOpen(false);
      setDiscardConfirmOpen(false);
      setError(null);
      if (result?.attachmentCleanupFailed) {
        // Deletion succeeded; keep the dialog open to surface the non-blocking
        // warning that some attachment files were left on disk.
        setAttachmentWarning(
          "Notes data was deleted, but some attachment files could not be removed from disk."
        );
      } else {
        onOpenChange(false);
      }
    } catch (cause) {
      if (isNotesDraftsFlushFailedError(cause)) {
        setConfirmOpen(false);
        setDiscardConfirmOpen(true);
        return;
      }
      setError(
        cause instanceof Error ? cause.message : "Notes data could not be deleted."
      );
    } finally {
      setDeletionRequestPending(false);
    }
  };

  return (
    <>
      <Dialog.Root open={open} onOpenChange={handleOpenChange}>
        <Dialog.Portal>
          <Dialog.Backdrop className="modal-backdrop" />
          <Dialog.Popup
            className="modal notes-data-settings-dialog"
            aria-label="Notes data"
          >
            <div className="modal-header">
              <div>
                <p className="eyebrow">Local storage</p>
                <Dialog.Title render={<h2 />}>Notes data</Dialog.Title>
                <p className="modal-copy">
                  Manage the Notes database stored inside this vault.
                </p>
              </div>
              <Dialog.Close
                className="icon-button"
                aria-label="Close Notes data settings"
                disabled={deleting}
              >
                <X size={18} aria-hidden="true" />
              </Dialog.Close>
            </div>

            <div className="notes-data-settings-content">
              <div className="notes-data-settings-icon" aria-hidden="true">
                <Database size={20} />
              </div>
              <div>
                <strong>Delete local Notes data</strong>
                <p>
                  This removes every page, note, tag, and Trash item from this
                  vault only.
                </p>
              </div>
              <button
                ref={deleteTriggerRef}
                className="danger-button"
                type="button"
                disabled={deleting}
                onClick={() => setConfirmOpen(true)}
              >
                <Trash2 size={16} aria-hidden="true" />
                {deleting ? "Deleting..." : "Delete all Notes data"}
              </button>
            </div>

            {error && (
              <p className="notes-inline-error" role="alert">
                {error}
              </p>
            )}
            {attachmentWarning && (
              <p className="notes-inline-warning" role="status">
                <AlertTriangle size={15} aria-hidden="true" />
                {attachmentWarning}
              </p>
            )}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete all Notes data?"
        description="This permanently deletes the Notes database for this vault. Other vault data and application settings will not be changed."
        confirmLabel="Delete Notes data"
        cancelLabel="Cancel"
        danger
        onConfirm={() => void deleteNotesData()}
      />

      <ConfirmDialog
        open={discardConfirmOpen}
        onOpenChange={setDiscardConfirmOpen}
        title="Discard unsaved edits and delete?"
        description="Unsaved edits could not be written. Discard them and delete all Notes data anyway?"
        confirmLabel="Discard and delete"
        cancelLabel="Cancel"
        danger
        onConfirm={() => void deleteNotesData(true)}
      />
    </>
  );
}
