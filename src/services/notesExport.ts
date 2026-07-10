import {
  defaultNotesExportFileName,
  isNotesExportConflictMessage,
  isNotesExportResult,
  NotesExportConflictError
} from "../domain/notesExport";
import type {
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
  assertTauriDesktop();
  const { invoke } = await import("@tauri-apps/api/core");

  let result: unknown;
  try {
    result = await invoke<unknown>("notes_export_markdown", {
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

  if (!isNotesExportResult(result)) {
    throw new Error("Notes export returned an invalid result.");
  }
  return result;
}

export async function saveNotesExport(
  request: NotesExportSaveRequest
): Promise<NotesExportResult | null> {
  assertTauriDesktop();
  const { save } = await import("@tauri-apps/plugin-dialog");
  const destination = await save({
    defaultPath: defaultNotesExportFileName(request.defaultFileName),
    filters: [{ name: "Markdown", extensions: ["md"] }]
  });

  if (destination === null) {
    return null;
  }

  return renderMarkdownExport({
    vaultPath: request.vaultPath,
    rootNodeId: request.rootNodeId,
    destination,
    overwrite: false
  });
}
