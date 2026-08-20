import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ExportFormat } from "../../../packages/contracts/generated/ExportFormat";
import type { NotesStore } from "./notesStore";
import {
  exportFormatLabel,
  isDestinationConflict,
  isRetryableExportError
} from "./exportApi";
import { pickExportPath } from "./exportPicker";
import { messageFrom } from "./store/storeSupport";
import "./notesExport.css";

interface ExportTarget {
  readonly id: string;
  readonly title: string;
}

interface ExportAttempt {
  readonly target: ExportTarget;
  readonly format: ExportFormat;
  readonly destinationPath?: string;
}

interface RetryAttempt {
  readonly attempt: ExportAttempt;
  readonly overwrite: boolean;
}

export function NotesExportMenu({
  store,
  currentRoot,
  selectedNode,
  initialOpen = false,
  disabled = false
}: {
  readonly store: NotesStore;
  readonly currentRoot: ExportTarget;
  readonly selectedNode: ExportTarget | null;
  readonly initialOpen?: boolean;
  readonly disabled?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(initialOpen);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<
    { readonly kind: "success" | "error"; readonly message: string } | null
  >(null);
  const [pendingOverwrite, setPendingOverwrite] =
    useState<ExportAttempt | null>(null);
  const retryRef = useRef<RetryAttempt | null>(null);
  const busyRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [menuOpen]);

  const run = async (
    attempt: ExportAttempt,
    overwrite = false
  ): Promise<void> => {
    if (disabled || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMenuOpen(false);
    if (!overwrite) retryRef.current = null;
    try {
      await store.flushAllDrafts();
      const title = store.getNodeSnapshot(attempt.target.id).title ||
        attempt.target.title;
      const destinationPath = attempt.destinationPath ??
        await pickExportPath(title, attempt.format);
      if (!destinationPath) return;
      setFeedback(null);
      const resolved = { ...attempt, destinationPath };
      try {
        await store.exportNotes({
          rootNodeId: attempt.target.id,
          format: attempt.format,
          destinationPath,
          overwrite
        });
        retryRef.current = null;
        setFeedback({
          kind: "success",
          message: `Exported ${exportFormatLabel(attempt.format)}.`
        });
      } catch (cause) {
        if (!overwrite && isDestinationConflict(cause)) {
          setPendingOverwrite(resolved);
          return;
        }
        retryRef.current = isRetryableExportError(cause)
          ? { attempt: resolved, overwrite }
          : null;
        setFeedback({ kind: "error", message: messageFrom(cause) });
      }
    } catch (cause) {
      retryRef.current = { attempt, overwrite };
      setFeedback({ kind: "error", message: messageFrom(cause) });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const action = (
    label: string,
    target: ExportTarget | null,
    format: ExportFormat
  ) => (
    <button
      className="notes-export-menu-item"
      type="button"
      role="menuitem"
      disabled={disabled || busy || target === null}
      onClick={() => target && void run({ target, format })}
    >
      {label}
    </button>
  );

  return (
    <div ref={rootRef} className="notes-export-control" aria-busy={busy}>
      {busy && <span className="notes-export-feedback" role="status">
        Exporting...
      </span>}
      {!busy && feedback?.kind === "success" && (
        <span className="notes-export-feedback" role="status">
          {feedback.message}
        </span>
      )}
      {!busy && feedback?.kind === "error" && (
        <span className="notes-export-feedback notes-export-error" role="alert">
          <span>{feedback.message}</span>
          {retryRef.current && (
            <button
              className="notes-export-retry-button"
              type="button"
              disabled={disabled}
              onClick={() => {
                const retry = retryRef.current;
                if (retry) void run(retry.attempt, retry.overwrite);
              }}
            >
              Retry
            </button>
          )}
        </span>
      )}
      <button
        className="notes-export-trigger"
        type="button"
        aria-label="Export as"
        title="Export as"
        data-tooltip="Export as"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-popup-open={menuOpen ? "true" : undefined}
        disabled={disabled || busy}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <Download size={16} aria-hidden="true" />
      </button>
      {menuOpen && (
        <div
          className="notes-export-menu"
          role="menu"
          aria-label="Export notes"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setMenuOpen(false);
            }
          }}
        >
          {action("Selected node as Markdown", selectedNode, "markdown")}
          {action("Selected node as PDF", selectedNode, "pdf")}
          {action("Current page as Markdown", currentRoot, "markdown")}
          {action("Current page as PDF", currentRoot, "pdf")}
        </div>
      )}
      {pendingOverwrite && (
        <>
          <div className="modal-backdrop" />
          <div
            className="modal confirm-dialog notes-export-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="notes-export-confirm-title"
          >
            <h2 id="notes-export-confirm-title" className="confirm-dialog-title">
              Replace existing export?
            </h2>
            <p className="confirm-dialog-description">
              Replace the existing export at{" "}
              <code className="notes-export-destination">
                {pendingOverwrite.destinationPath}
              </code>
              ?
            </p>
            <div className="confirm-dialog-actions">
              <button type="button" onClick={() => setPendingOverwrite(null)}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const attempt = pendingOverwrite;
                  setPendingOverwrite(null);
                  void run(attempt, true);
                }}
              >
                Replace
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
