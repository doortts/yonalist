import { useContext } from "react";
import { AlertTriangle } from "lucide-react";
import { VaultRootContext } from "../../VaultRootContext";
import type { SyncStatus } from "../../services/notesSyncContract";
import {
  notesSyncStatusNeedsAttention,
  useNotesSyncStatus
} from "./useNotesSyncStatus";

function summarize(status: SyncStatus): string {
  if (status.quarantined.length > 0) {
    const count = status.quarantined.length;
    return `${count} note file${count === 1 ? "" : "s"} need attention`;
  }
  if (status.lastError) {
    return "Notes sync reported an error";
  }
  return "Notes sync stopped";
}

/**
 * C3: a single badge that appears at the top of Notes only when the sync
 * runtime is quarantined or errored. It is otherwise absent (no "all good"
 * chrome). Details live in the Notes data settings dialog.
 */
export function NotesSyncStatusBadge() {
  const vaultRoot = useContext(VaultRootContext);
  const status = useNotesSyncStatus(vaultRoot);
  if (!notesSyncStatusNeedsAttention(status)) {
    return null;
  }
  return (
    <div className="notes-sync-status-badge" role="status" aria-live="polite">
      <AlertTriangle size={14} aria-hidden="true" />
      <span className="notes-sync-status-message">
        <span>{summarize(status)}</span>
        {status.lastError && (
          <span className="notes-sync-status-detail">{status.lastError}</span>
        )}
      </span>
    </div>
  );
}
