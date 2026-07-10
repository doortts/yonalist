import { Menu } from "@base-ui/react/menu";
import { Download } from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState
} from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { IconTooltip } from "../../components/ui/Tooltip";
import { VaultRootContext } from "../../VaultRootContext";
import type { NoteId } from "../../domain/notes";
import {
  NotesExportConflictError,
  type NotesExportFormat,
  type NotesExportRequest,
  type NotesExportResult
} from "../../domain/notesExport";
import {
  renderMarkdownExport,
  renderPdfExport,
  saveNotesExport
} from "../../services/notesExport";

export interface NotesExportMenuProps {
  selectedNodeId: NoteId | null;
  selectedNodeTitle?: string;
  zoomRootId: NoteId | null;
  zoomRootTitle?: string;
  onFlushNodeDraft(nodeId: NoteId): Promise<boolean>;
  disabled?: boolean;
  loading?: boolean;
}

interface ExportAttempt {
  format: NotesExportFormat;
  run(isCurrent: () => boolean): Promise<NotesExportResult | null>;
}

interface RetryableAttempt {
  attempt: ExportAttempt;
  allowConflict: boolean;
}

interface PendingOverwrite {
  format: NotesExportFormat;
  request: NotesExportRequest;
}

type ExportFeedback =
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

function formatLabel(format: NotesExportFormat): string {
  return format === "markdown" ? "Markdown" : "PDF";
}

function exportErrorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) {
    return cause.message;
  }
  if (typeof cause === "string" && cause.trim()) {
    return cause;
  }
  return "Notes export failed.";
}

export function NotesExportMenu({
  selectedNodeId,
  selectedNodeTitle,
  zoomRootId,
  zoomRootTitle,
  onFlushNodeDraft,
  disabled = false,
  loading = false
}: NotesExportMenuProps) {
  const vaultPath = useContext(VaultRootContext);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<ExportFeedback | null>(null);
  const [pendingOverwrite, setPendingOverwrite] =
    useState<PendingOverwrite | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const operationGenerationRef = useRef(0);
  const awaitingDraftFlushRef = useRef(false);
  const retryRef = useRef<RetryableAttempt | null>(null);
  const hardUnavailable =
    disabled ||
    !vaultPath.trim() ||
    (selectedNodeId === null && zoomRootId === null);
  const unavailable =
    hardUnavailable || (loading && !awaitingDraftFlushRef.current);
  const unavailableRef = useRef(unavailable);
  unavailableRef.current = unavailable;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationGenerationRef.current += 1;
      awaitingDraftFlushRef.current = false;
      busyRef.current = false;
      retryRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!unavailable) {
      return;
    }
    operationGenerationRef.current += 1;
    busyRef.current = false;
    retryRef.current = null;
    setMenuOpen(false);
    setBusy(false);
    setFeedback(null);
    setPendingOverwrite(null);
  }, [unavailable]);

  const executeAttempt = useCallback(
    async (attempt: ExportAttempt, allowConflict: boolean) => {
      if (
        busyRef.current ||
        unavailableRef.current ||
        !mountedRef.current
      ) {
        return;
      }

      const operationGeneration = ++operationGenerationRef.current;
      const isCurrent = () =>
        mountedRef.current &&
        !unavailableRef.current &&
        operationGenerationRef.current === operationGeneration;
      busyRef.current = true;
      setBusy(true);
      setFeedback(null);
      retryRef.current = null;

      try {
        const result = await attempt.run(isCurrent);
        if (!isCurrent() || result === null) {
          return;
        }
        setFeedback({
          kind: "success",
          message: `Exported ${formatLabel(result.format)}.`
        });
      } catch (cause) {
        if (!isCurrent()) {
          return;
        }
        if (allowConflict && cause instanceof NotesExportConflictError) {
          setPendingOverwrite({
            format: attempt.format,
            request: cause.request
          });
          return;
        }

        retryRef.current = { attempt, allowConflict };
        setFeedback({ kind: "error", message: exportErrorMessage(cause) });
      } finally {
        if (isCurrent()) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    []
  );

  const startExport = (
    rootNodeId: NoteId | null,
    defaultFileName: string | undefined,
    format: NotesExportFormat
  ) => {
    if (rootNodeId === null || unavailable || busyRef.current) {
      return;
    }

    const attempt: ExportAttempt = {
      format,
      run: async (isCurrent) => {
        awaitingDraftFlushRef.current = true;
        let saved: boolean;
        try {
          saved = await onFlushNodeDraft(rootNodeId);
        } finally {
          awaitingDraftFlushRef.current = false;
        }
        if (!isCurrent()) {
          return null;
        }
        if (!saved) {
          throw new Error("Save this note before exporting.");
        }
        return saveNotesExport({
          vaultPath,
          rootNodeId,
          format,
          defaultFileName
        });
      }
    };
    void executeAttempt(attempt, true);
  };

  const retryFailedExport = () => {
    const retry = retryRef.current;
    if (!retry) {
      return;
    }
    void executeAttempt(retry.attempt, retry.allowConflict);
  };

  const replaceExistingExport = () => {
    const conflict = pendingOverwrite;
    if (!conflict || busyRef.current || unavailable) {
      return;
    }

    const overwriteRequest = { ...conflict.request, overwrite: true };
    const attempt: ExportAttempt = {
      format: conflict.format,
      run: () =>
        conflict.format === "markdown"
          ? renderMarkdownExport(overwriteRequest)
          : renderPdfExport(overwriteRequest)
    };
    void executeAttempt(attempt, false);
  };

  return (
    <div className="notes-export-control" aria-busy={busy}>
      {busy && (
        <span className="notes-export-feedback" role="status">
          Exporting...
        </span>
      )}
      {!busy && feedback?.kind === "success" && (
        <span className="notes-export-feedback" role="status">
          {feedback.message}
        </span>
      )}
      {!busy && feedback?.kind === "error" && (
        <span className="notes-export-feedback notes-export-error" role="alert">
          <span>{feedback.message}</span>
          <button
            className="notes-export-retry-button"
            type="button"
            disabled={unavailable}
            onClick={retryFailedExport}
          >
            Retry
          </button>
        </span>
      )}

      <Menu.Root
        open={menuOpen}
        onOpenChange={(open) => {
          if (!open || (!unavailable && !busyRef.current)) {
            setMenuOpen(open);
          }
        }}
      >
        <IconTooltip label="Export" side="bottom">
          <Menu.Trigger
            className="notes-export-trigger"
            type="button"
            aria-label="Export"
            aria-busy={busy || undefined}
            disabled={unavailable || busy}
          >
            <Download size={16} aria-hidden="true" />
          </Menu.Trigger>
        </IconTooltip>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6}>
            <Menu.Popup className="notes-export-menu">
              <Menu.Item
                className="notes-export-menu-item"
                disabled={busy || selectedNodeId === null}
                onClick={() =>
                  startExport(
                    selectedNodeId,
                    selectedNodeTitle,
                    "markdown"
                  )
                }
              >
                Selected node as Markdown
              </Menu.Item>
              <Menu.Item
                className="notes-export-menu-item"
                disabled={busy || selectedNodeId === null}
                onClick={() =>
                  startExport(selectedNodeId, selectedNodeTitle, "pdf")
                }
              >
                Selected node as PDF
              </Menu.Item>
              <Menu.Item
                className="notes-export-menu-item"
                disabled={busy || zoomRootId === null}
                onClick={() =>
                  startExport(zoomRootId, zoomRootTitle, "markdown")
                }
              >
                Current page as Markdown
              </Menu.Item>
              <Menu.Item
                className="notes-export-menu-item"
                disabled={busy || zoomRootId === null}
                onClick={() => startExport(zoomRootId, zoomRootTitle, "pdf")}
              >
                Current page as PDF
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      <ConfirmDialog
        open={pendingOverwrite !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingOverwrite(null);
          }
        }}
        title="Replace existing export?"
        description={
          <>
            Replace the existing export at{" "}
            <code className="notes-export-destination">
              {pendingOverwrite?.request.destination}
            </code>
            ?
          </>
        }
        confirmLabel="Replace"
        cancelLabel="Cancel"
        popupClassName="notes-export-confirm-dialog"
        onConfirm={replaceExistingExport}
      />
    </div>
  );
}
