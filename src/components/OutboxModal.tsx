import { CheckCircle2, Check, X } from "lucide-react";
import { Dialog } from "@base-ui/react/dialog";
import { Checkbox } from "@base-ui/react/checkbox";
import type { OutboxOperationDocument } from "../domain/types";
import "./ui/dialog.css";

interface OutboxModalProps {
  outbox: OutboxOperationDocument[];
  selectedIds: Set<string>;
  online: boolean;
  syncing: boolean;
  /** Operations whose remote target changed after they were queued. */
  remoteChangedIds?: Set<string>;
  onToggleSelection: (id: string) => void;
  onOpenTarget?: (operation: OutboxOperationDocument) => void;
  onSync: () => void;
  onClose: () => void;
}

export function OutboxModal({
  outbox,
  selectedIds,
  online,
  syncing,
  remoteChangedIds,
  onToggleSelection,
  onOpenTarget,
  onSync,
  onClose
}: OutboxModalProps) {
  return (
    <Dialog.Root
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Popup className="modal" aria-label="Outbox">
          <div className="modal-header">
            <div>
              <p className="eyebrow">Pending sync</p>
              <Dialog.Title render={<h2 />}>Outbox</Dialog.Title>
              {outbox.length > 0 && (
                <p className="modal-copy">Choose queued changes to sync.</p>
              )}
            </div>
            <Dialog.Close
              className="icon-button"
              aria-label="Close outbox"
            >
              <X size={18} />
            </Dialog.Close>
          </div>
          {outbox.length === 0 ? (
            <p className="empty-copy">No queued changes.</p>
          ) : (
            <>
              <div className="outbox-list">
                {outbox.map((operation) => (
                  <article className="outbox-card" key={operation.frontMatter.id}>
                    <Checkbox.Root
                      className="outbox-checkbox"
                      aria-label={`Select ${operation.frontMatter.operation}`}
                      checked={selectedIds.has(operation.frontMatter.id)}
                      onCheckedChange={() =>
                        onToggleSelection(operation.frontMatter.id)
                      }
                    >
                      <Checkbox.Indicator className="outbox-checkbox-indicator">
                        <Check size={12} strokeWidth={3} />
                      </Checkbox.Indicator>
                    </Checkbox.Root>
                    <button
                      className="outbox-target-button"
                      type="button"
                      aria-label={`Open target for ${operation.frontMatter.operation}`}
                      onClick={() => onOpenTarget?.(operation)}
                      disabled={!onOpenTarget}
                    >
                      <strong>{operation.frontMatter.operation.replace("_", " ")}</strong>
                      <p>{operation.body || operation.frontMatter.local_file_path}</p>
                      {operation.frontMatter.status === "failed" && (
                        <p className="outbox-error">
                          {operation.frontMatter.last_error ?? "Sync failed."}
                        </p>
                      )}
                      {operation.frontMatter.status === "blocked" && (
                        <p className="outbox-error outbox-blocked">
                          Blocked —{" "}
                          {operation.frontMatter.last_error ??
                            "this change can no longer be synced."}
                        </p>
                      )}
                      {remoteChangedIds?.has(operation.frontMatter.id) && (
                        <p className="outbox-conflict">
                          Target changed remotely since this was queued.
                        </p>
                      )}
                    </button>
                  </article>
                ))}
              </div>
              <div className="modal-actions">
                <span>
                  {online
                    ? "Selected changes will be sent to GitHub."
                    : "Go online before syncing selected changes."}
                </span>
                <button
                  className="primary-button"
                  type="button"
                  disabled={!online || syncing || selectedIds.size === 0}
                  onClick={onSync}
                >
                  <CheckCircle2 size={16} />
                  {syncing ? "Syncing..." : "Sync selected"}
                </button>
              </div>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
