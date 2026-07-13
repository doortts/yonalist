import {
  defaultNotesExportFileName,
  isNotesExportConflictMessage,
  isNotesExportResult,
  NotesExportConflictError
} from "../domain/notesExport";
import type {
  NotesExportFormat,
  NotesExportRequest,
  NotesExportResult,
  NotesExportSaveRequest
} from "../domain/notesExport";

function assertTauriDesktop(): void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    throw new Error("Notes requires Tauri desktop storage.");
  }
}

export async function renderMarkdownExport(
  request: NotesExportRequest
): Promise<NotesExportResult> {
  return renderNotesExport(request, "markdown");
}

export async function renderPdfExport(
  request: NotesExportRequest
): Promise<NotesExportResult> {
  return renderNotesExport(request, "pdf");
}

async function renderNotesExport(
  request: NotesExportRequest,
  format: NotesExportFormat
): Promise<NotesExportResult> {
  assertTauriDesktop();
  const { invoke } = await import("@tauri-apps/api/core");

  let result: unknown;
  try {
    result = await invoke<unknown>(`notes_export_${format}`, {
      vaultPath: request.vaultPath,
      rootNodeId: request.rootNodeId,
      destination: request.destination,
      overwrite: request.overwrite
    });
  } catch (cause) {
    if (isNotesExportConflictMessage(cause)) {
      throw new NotesExportConflictError(request.destination, request);
    }
    throw cause;
  }

  if (!isNotesExportResult(result, format)) {
    throw new Error("Notes export returned an invalid result.");
  }
  return result;
}

export async function saveNotesExport(
  request: NotesExportSaveRequest
): Promise<NotesExportResult | null> {
  assertTauriDesktop();
  const options =
    request.format === "pdf"
      ? { name: "PDF", extension: "pdf" }
      : { name: "Markdown", extension: "md" };
  const { save } = await import("@tauri-apps/plugin-dialog");
  const destination = await save({
    defaultPath: defaultNotesExportFileName(
      request.defaultFileName,
      request.format
    ),
    filters: [{ name: options.name, extensions: [options.extension] }]
  });

  if (destination === null) {
    return null;
  }

  const exportRequest = {
    vaultPath: request.vaultPath,
    rootNodeId: request.rootNodeId,
    destination,
    overwrite: false
  };

  return request.format === "pdf"
    ? renderPdfExport(exportRequest)
    : renderMarkdownExport(exportRequest);
}
