import { CheckCircle2, X } from "lucide-react";
import type { OutboxOperationDocument } from "../domain/types";

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
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-label="Outbox">
        <div className="modal-header">
          <div>
            <p className="eyebrow">Pending sync</p>
            <h2>Outbox</h2>
            {outbox.length > 0 && (
              <p className="modal-copy">Choose queued changes to sync.</p>
            )}
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close outbox"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        {outbox.length === 0 ? (
          <p className="empty-copy">No queued changes.</p>
        ) : (
          <>
            <div className="outbox-list">
              {outbox.map((operation) => (
                <article className="outbox-card" key={operation.frontMatter.id}>
                  <input
                    aria-label={`Select ${operation.frontMatter.operation}`}
                    type="checkbox"
                    checked={selectedIds.has(operation.frontMatter.id)}
                    onChange={() => onToggleSelection(operation.frontMatter.id)}
                  />
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
      </section>
    </div>
  );
}
