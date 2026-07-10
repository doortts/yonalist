import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
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

interface ExportAttempt {
  format: NotesExportFormat;
  run(isCurrent: () => boolean): Promise<NotesExportResult | null>;
}

interface RetryableAttempt {
  attempt: ExportAttempt;
  allowConflict: boolean;
}

export interface PendingNotesExportOverwrite {
  format: NotesExportFormat;
  request: NotesExportRequest;
}

export type NotesExportFeedback =
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

interface NotesExportControllerValue {
  busy: boolean;
  feedback: NotesExportFeedback | null;
  pendingOverwrite: PendingNotesExportOverwrite | null;
  unavailable: boolean;
  clearPendingOverwrite(): void;
  replaceExistingExport(): void;
  retryFailedExport(): void;
  startExport(
    rootNodeId: NoteId,
    defaultFileName: string | undefined,
    format: NotesExportFormat
  ): void;
}

interface NotesExportControllerProviderProps {
  available: boolean;
  children: ReactNode;
  disabled?: boolean;
  loading?: boolean;
  onFlushNodeDraft(nodeId: NoteId): Promise<boolean>;
}

const NotesExportControllerContext =
  createContext<NotesExportControllerValue | null>(null);

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

export function NotesExportControllerProvider({
  available,
  children,
  disabled = false,
  loading = false,
  onFlushNodeDraft
}: NotesExportControllerProviderProps) {
  const vaultPath = useContext(VaultRootContext);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<NotesExportFeedback | null>(null);
  const [pendingOverwrite, setPendingOverwrite] =
    useState<PendingNotesExportOverwrite | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const operationGenerationRef = useRef(0);
  const awaitingDraftFlushRef = useRef(false);
  const retryRef = useRef<RetryableAttempt | null>(null);
  const hardUnavailable = disabled || !available || !vaultPath.trim();
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

  const startExport = useCallback(
    (
      rootNodeId: NoteId,
      defaultFileName: string | undefined,
      format: NotesExportFormat
    ) => {
      if (unavailable || busyRef.current) {
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
    },
    [executeAttempt, onFlushNodeDraft, unavailable, vaultPath]
  );

  const retryFailedExport = useCallback(() => {
    const retry = retryRef.current;
    if (retry) {
      void executeAttempt(retry.attempt, retry.allowConflict);
    }
  }, [executeAttempt]);

  const replaceExistingExport = useCallback(() => {
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
  }, [executeAttempt, pendingOverwrite, unavailable]);

  const value = useMemo<NotesExportControllerValue>(
    () => ({
      busy,
      feedback,
      pendingOverwrite,
      unavailable,
      clearPendingOverwrite: () => setPendingOverwrite(null),
      replaceExistingExport,
      retryFailedExport,
      startExport
    }),
    [
      busy,
      feedback,
      pendingOverwrite,
      replaceExistingExport,
      retryFailedExport,
      startExport,
      unavailable
    ]
  );

  return (
    <NotesExportControllerContext.Provider value={value}>
      {children}
    </NotesExportControllerContext.Provider>
  );
}

export function useOptionalNotesExportController() {
  return useContext(NotesExportControllerContext);
}

export function useNotesExportController(): NotesExportControllerValue {
  const controller = useOptionalNotesExportController();
  if (!controller) {
    throw new Error("Notes export controller is unavailable.");
  }
  return controller;
}
