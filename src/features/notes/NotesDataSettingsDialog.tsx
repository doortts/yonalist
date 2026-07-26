import { Dialog } from "@base-ui/react/dialog";
import {
  AlertTriangle,
  Database,
  RefreshCw,
  Trash2,
  Wrench,
  X
} from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import "../../components/ui/dialog.css";
import { VaultRootContext } from "../../VaultRootContext";
import {
  notesPurgeUnusedAssets,
  notesResetDatabase,
  notesSyncRetryQuarantined,
  type NotesAssetPurgeReport
} from "../../services/notesStore";
import { NotesDataRepairAction } from "./NotesDataRepairAction";
import { useNotesActions, useNotesState } from "./NotesWorkspaceContext";
import { useNotesSyncStatus } from "./useNotesSyncStatus";
import { isNotesDraftsFlushFailedError } from "./useNotesWorkspace";

interface NotesDataSettingsDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  reloadApplication?: () => void;
}

export function NotesDataSettingsDialog({
  open,
  onOpenChange,
  reloadApplication = () => window.location.reload()
}: NotesDataSettingsDialogProps) {
  const { actions } = useNotesActions();
  const vaultRoot = useContext(VaultRootContext);
  const syncStatus = useNotesSyncStatus(vaultRoot);
  const { deletingNotesData } = useNotesState();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [deletionRequestPending, setDeletionRequestPending] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const [repairPending, setRepairPending] = useState(false);
  const [purgePending, setPurgePending] = useState(false);
  const [retryPending, setRetryPending] = useState(false);
  const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false);
  const [purgeReport, setPurgeReport] = useState<NotesAssetPurgeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attachmentWarning, setAttachmentWarning] = useState<string | null>(
    null
  );
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const resetTriggerRef = useRef<HTMLButtonElement>(null);
  const errorFocusTargetRef = useRef<"delete" | "reset">("delete");
  const deleteConfirmationVaultRootRef = useRef<string | null>(null);
  const deleteRequestGenerationRef = useRef(0);
  const resetConfirmationVaultRootRef = useRef<string | null>(null);
  const resetRequestGenerationRef = useRef(0);
  const purgeReportVaultRootRef = useRef<string | null>(null);
  const purgeConfirmationVaultRootRef = useRef<string | null>(null);
  const purgeRequestGenerationRef = useRef(0);
  const currentVaultRootRef = useRef(vaultRoot);
  currentVaultRootRef.current = vaultRoot;
  const deleting = deletingNotesData || deletionRequestPending;
  const busy =
    deleting || purgePending || repairPending || resetPending || retryPending;

  // R13: manual quarantine release — clear the flag, re-mark dirty, flush now.
  const handleRetryQuarantined = async () => {
    if (!vaultRoot) {
      return;
    }
    setError(null);
    setRetryPending(true);
    try {
      await notesSyncRetryQuarantined(vaultRoot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRetryPending(false);
    }
  };

  useEffect(() => {
    if (error && !busy) {
      const trigger =
        errorFocusTargetRef.current === "reset"
          ? resetTriggerRef.current
          : deleteTriggerRef.current;
      trigger?.focus();
    }
  }, [busy, error]);

  useEffect(() => {
    currentVaultRootRef.current = vaultRoot;
    deleteRequestGenerationRef.current += 1;
    resetRequestGenerationRef.current += 1;
    purgeRequestGenerationRef.current += 1;
    setDeletionRequestPending(false);
    setResetPending(false);
    setPurgePending(false);
    purgeReportVaultRootRef.current = null;
    purgeConfirmationVaultRootRef.current = null;
    setPurgeConfirmOpen(false);
    setPurgeReport(null);
    deleteConfirmationVaultRootRef.current = null;
    setConfirmOpen(false);
    setDiscardConfirmOpen(false);
    resetConfirmationVaultRootRef.current = null;
    setResetConfirmOpen(false);
    setError(null);
    setAttachmentWarning(null);
  }, [vaultRoot]);

  const openDeleteConfirmation = () => {
    deleteConfirmationVaultRootRef.current = vaultRoot;
    setConfirmOpen(true);
  };

  const openResetConfirmation = () => {
    resetConfirmationVaultRootRef.current = vaultRoot;
    setResetConfirmOpen(true);
  };

  const openPurgeConfirmation = () => {
    const reportVaultRoot = purgeReportVaultRootRef.current;
    if (
      purgeReport === null ||
      reportVaultRoot === null ||
      reportVaultRoot !== currentVaultRootRef.current
    ) {
      return;
    }
    purgeConfirmationVaultRootRef.current = reportVaultRoot;
    setPurgeConfirmOpen(true);
  };

  const handlePurgeConfirmOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      purgeConfirmationVaultRootRef.current = null;
    }
    setPurgeConfirmOpen(nextOpen);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && busy) {
      return;
    }
    if (!nextOpen) {
      deleteConfirmationVaultRootRef.current = null;
      resetConfirmationVaultRootRef.current = null;
      purgeReportVaultRootRef.current = null;
      purgeConfirmationVaultRootRef.current = null;
      setConfirmOpen(false);
      setDiscardConfirmOpen(false);
      setResetConfirmOpen(false);
      setPurgeConfirmOpen(false);
      setPurgeReport(null);
      setError(null);
      setAttachmentWarning(null);
    }
    onOpenChange(nextOpen);
  };

  const purgeUnusedAssets = async (confirm: boolean) => {
    if (busy) return;
    if (
      confirm &&
      (purgeConfirmationVaultRootRef.current === null ||
        purgeConfirmationVaultRootRef.current !== currentVaultRootRef.current)
    ) {
      return;
    }
    const requestVaultRoot = currentVaultRootRef.current;
    const requestGeneration = purgeRequestGenerationRef.current + 1;
    purgeRequestGenerationRef.current = requestGeneration;
    setPurgePending(true);
    setError(null);
    if (!confirm) {
      purgeReportVaultRootRef.current = null;
      purgeConfirmationVaultRootRef.current = null;
      setPurgeReport(null);
    }
    try {
      const report = await notesPurgeUnusedAssets(requestVaultRoot, confirm);
      if (
        requestGeneration !== purgeRequestGenerationRef.current ||
        requestVaultRoot !== currentVaultRootRef.current
      ) {
        return;
      }
      setPurgeConfirmOpen(false);
      purgeConfirmationVaultRootRef.current = null;
      if (confirm) {
        purgeReportVaultRootRef.current = null;
        setPurgeReport(null);
      } else {
        purgeReportVaultRootRef.current = requestVaultRoot;
        setPurgeReport(report);
      }
    } catch (cause) {
      if (
        requestGeneration !== purgeRequestGenerationRef.current ||
        requestVaultRoot !== currentVaultRootRef.current
      ) {
        return;
      }
      purgeReportVaultRootRef.current = null;
      purgeConfirmationVaultRootRef.current = null;
      setPurgeConfirmOpen(false);
      setPurgeReport(null);
      errorFocusTargetRef.current = "delete";
      setError(
        cause instanceof Error ? cause.message : "Unused assets could not be checked."
      );
    } finally {
      if (
        requestGeneration === purgeRequestGenerationRef.current &&
        requestVaultRoot === currentVaultRootRef.current
      ) {
        setPurgePending(false);
      }
    }
  };

  const deleteNotesData = async (discardDrafts = false) => {
    if (
      deleting ||
      deleteConfirmationVaultRootRef.current === null ||
      deleteConfirmationVaultRootRef.current !== currentVaultRootRef.current
    ) {
      return;
    }
    const requestVaultRoot = currentVaultRootRef.current;
    const requestGeneration = deleteRequestGenerationRef.current + 1;
    deleteRequestGenerationRef.current = requestGeneration;
    const isCurrentRequest = () =>
      requestGeneration === deleteRequestGenerationRef.current &&
      requestVaultRoot === currentVaultRootRef.current;
    setDeletionRequestPending(true);
    setError(null);
    setAttachmentWarning(null);
    try {
      const result = await actions.deleteAllNotesData(
        discardDrafts ? { discardDrafts: true } : undefined
      );
      if (!isCurrentRequest()) {
        return;
      }
      deleteConfirmationVaultRootRef.current = null;
      setConfirmOpen(false);
      setDiscardConfirmOpen(false);
      setError(null);
      if (result?.attachmentCleanupFailed) {
        // Deletion succeeded; keep the dialog open to surface the non-blocking
        // warning that some attachment files were left on disk.
        setAttachmentWarning(
          "Yonalist data was deleted, but some attachment files could not be removed from disk."
        );
      } else {
        onOpenChange(false);
        reloadApplication();
      }
    } catch (cause) {
      if (!isCurrentRequest()) {
        return;
      }
      if (isNotesDraftsFlushFailedError(cause)) {
        setConfirmOpen(false);
        setDiscardConfirmOpen(true);
        return;
      }
      deleteConfirmationVaultRootRef.current = null;
      errorFocusTargetRef.current = "delete";
      setError(
        cause instanceof Error
          ? cause.message
          : "Yonalist data could not be deleted."
      );
    } finally {
      if (isCurrentRequest()) {
        setDeletionRequestPending(false);
      }
    }
  };

  const resetNotesDatabase = async () => {
    if (
      busy ||
      resetConfirmationVaultRootRef.current === null ||
      resetConfirmationVaultRootRef.current !== currentVaultRootRef.current
    ) {
      return;
    }
    const requestVaultRoot = currentVaultRootRef.current;
    const requestGeneration = resetRequestGenerationRef.current + 1;
    resetRequestGenerationRef.current = requestGeneration;
    const isCurrentRequest = () =>
      requestGeneration === resetRequestGenerationRef.current &&
      requestVaultRoot === currentVaultRootRef.current;
    setResetPending(true);
    setError(null);
    try {
      await notesResetDatabase(requestVaultRoot);
      if (!isCurrentRequest()) {
        return;
      }
      resetConfirmationVaultRootRef.current = null;
      setResetConfirmOpen(false);
      reloadApplication();
    } catch (cause) {
      if (!isCurrentRequest()) {
        return;
      }
      resetConfirmationVaultRootRef.current = null;
      errorFocusTargetRef.current = "reset";
      setError(
        cause instanceof Error
          ? cause.message
          : "The Yonalist database could not be reset."
      );
    } finally {
      if (isCurrentRequest()) {
        setResetPending(false);
      }
    }
  };

  return (
    <>
      <Dialog.Root open={open} onOpenChange={handleOpenChange}>
        <Dialog.Portal>
          <Dialog.Backdrop className="modal-backdrop" />
          <Dialog.Popup
            className="modal notes-data-settings-dialog"
            aria-label="Yonalist data"
          >
            <div className="modal-header">
              <div>
                <p className="eyebrow">Local storage</p>
                <Dialog.Title render={<h2 />}>Yonalist data</Dialog.Title>
                <p className="modal-copy">
                  Manage the Yonalist database stored inside this vault.
                </p>
              </div>
              <Dialog.Close
                className="icon-button"
                aria-label="Close Yonalist data settings"
                disabled={busy}
              >
                <X size={18} aria-hidden="true" />
              </Dialog.Close>
            </div>

            {syncStatus && (
              <div className="notes-data-settings-content notes-sync-status-section">
                <div className="notes-data-settings-icon" aria-hidden="true">
                  <RefreshCw size={20} />
                </div>
                <div>
                  <strong>Folder sync status</strong>
                  <p>{syncStatus.running ? "Running." : "Not running."}</p>
                  {syncStatus.quarantined.length > 0 && (
                    <p role="status">
                      Quarantined files: {syncStatus.quarantined.join(", ")}
                    </p>
                  )}
                  {syncStatus.lastError && (
                    <p className="notes-inline-error" role="alert">
                      {syncStatus.lastError}
                    </p>
                  )}
                  <p>
                    Last export: {syncStatus.lastExportAt ?? "—"} · Last merge:{" "}
                    {syncStatus.lastMergeAt ?? "—"}
                  </p>
                  {syncStatus.quarantined.length > 0 && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={handleRetryQuarantined}
                    >
                      {retryPending ? "Retrying sync..." : "Retry sync"}
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="notes-data-settings-content">
              <div className="notes-data-settings-icon" aria-hidden="true">
                <Wrench size={20} />
              </div>
              <div>
                <strong>Repair Yonalist data</strong>
                <p>
                  Back up and repair Yonalist ordering data that prevents the
                  workspace from loading.
                </p>
              </div>
              <NotesDataRepairAction
                disabled={busy}
                onPendingChange={setRepairPending}
                reloadApplication={reloadApplication}
              />
            </div>

            {import.meta.env.DEV && (
              <div className="notes-data-settings-content">
                <div className="notes-data-settings-icon" aria-hidden="true">
                  <Database size={20} />
                </div>
                <div>
                  <strong>Reset Yonalist database</strong>
                  <p>
                    Rebuild the local Yonalist database while keeping synced
                    Yonalist files and attachments.
                  </p>
                </div>
                <button
                  ref={resetTriggerRef}
                  type="button"
                  disabled={busy}
                  onClick={openResetConfirmation}
                >
                  {resetPending ? "Resetting..." : "Reset Yonalist database"}
                </button>
              </div>
            )}

            <div className="notes-data-settings-content">
              <div className="notes-data-settings-icon" aria-hidden="true">
                <Trash2 size={20} />
              </div>
              <div>
                <strong>Unused attachment assets</strong>
                <p>
                  Check files that are no longer referenced by any Yonalist
                  attachment.
                </p>
                {purgeReport && (
                  <p role="status">
                    {purgeReport.count.toLocaleString()} unused assets ({purgeReport.totalBytes.toLocaleString()} bytes)
                  </p>
                )}
              </div>
              {purgeReport && purgeReport.count > 0 ? (
                <div className="notes-data-settings-purge-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void purgeUnusedAssets(false)}
                  >
                    {purgePending ? "Checking..." : "Refresh unused assets"}
                  </button>
                  <button
                    className="danger-button"
                    type="button"
                    disabled={busy}
                    onClick={openPurgeConfirmation}
                  >
                    Delete {purgeReport.count.toLocaleString()} unused assets
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void purgeUnusedAssets(false)}
                >
                  {purgePending ? "Checking..." : "Check unused assets"}
                </button>
              )}
            </div>

            <div className="notes-data-settings-content">
              <div className="notes-data-settings-icon" aria-hidden="true">
                <Database size={20} />
              </div>
              <div>
                <strong>Delete local Yonalist data</strong>
                <p>
                  This removes the Yonalist database, synced Yonalist files,
                  attachments, and Trash data from this vault. Other vault files
                  and application settings are kept.
                </p>
              </div>
              <button
                ref={deleteTriggerRef}
                className="danger-button"
                type="button"
                disabled={busy}
                onClick={openDeleteConfirmation}
              >
                <Trash2 size={16} aria-hidden="true" />
                {deleting ? "Deleting..." : "Delete all Yonalist data"}
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
        open={purgeConfirmOpen}
        onOpenChange={handlePurgeConfirmOpenChange}
        title="Delete unused Yonalist assets now?"
        description="This permanently deletes the unused attachment files reported by the latest check, including files already in quarantine."
        confirmLabel="Delete unused assets"
        cancelLabel="Cancel"
        danger
        onConfirm={() => void purgeUnusedAssets(true)}
      />

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete all Yonalist data?"
        description="This removes the Yonalist database, synced Yonalist files, attachments, and Trash data from this vault. Other vault files and application settings are kept."
        confirmLabel="Delete Yonalist data"
        cancelLabel="Cancel"
        danger
        onConfirm={() => void deleteNotesData()}
      />

      <ConfirmDialog
        open={resetConfirmOpen}
        onOpenChange={setResetConfirmOpen}
        title="Reset the Yonalist database?"
        description="Synced Yonalist files and attachments are kept. Pages that exist only in SQLite will be permanently discarded."
        confirmLabel="Reset database"
        cancelLabel="Cancel"
        danger
        onConfirm={() => void resetNotesDatabase()}
      />

      <ConfirmDialog
        open={discardConfirmOpen}
        onOpenChange={setDiscardConfirmOpen}
        title="Discard unsaved edits and delete?"
        description="Unsaved edits could not be written. Discard them and delete all Yonalist data anyway?"
        confirmLabel="Discard and delete"
        cancelLabel="Cancel"
        danger
        onConfirm={() => void deleteNotesData(true)}
      />
    </>
  );
}
