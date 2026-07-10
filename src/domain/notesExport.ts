import type { NoteId } from "./notes";

export type NotesExportFormat = "markdown";

export interface NotesExportRequest {
  vaultPath: string;
  rootNodeId: NoteId;
  destination: string;
  overwrite: boolean;
}

export interface NotesExportSaveRequest {
  vaultPath: string;
  rootNodeId: NoteId;
  format: "markdown";
  defaultFileName?: string;
}

export interface NotesExportResult {
  destination: string;
  format: NotesExportFormat;
}

const NOTES_EXPORT_CONFLICT_MESSAGE = "Destination already exists.";
const DEFAULT_MARKDOWN_FILE_NAME = "notes-export.md";
const WINDOWS_RESERVED_DEVICE_NAME =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

export function defaultNotesExportFileName(
  title: string | null | undefined
): string {
  const baseName = (title ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .replace(/(?:\.md)+$/i, "");

  return baseName && !WINDOWS_RESERVED_DEVICE_NAME.test(baseName)
    ? `${baseName}.md`
    : DEFAULT_MARKDOWN_FILE_NAME;
}

export function isNotesExportResult(value: unknown): value is NotesExportResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const result = value as Record<string, unknown>;
  return (
    Object.keys(result).length === 2 &&
    typeof result.destination === "string" &&
    result.destination.length > 0 &&
    result.format === "markdown"
  );
}

export function isNotesExportConflictMessage(cause: unknown): cause is string {
  return cause === NOTES_EXPORT_CONFLICT_MESSAGE;
}

export class NotesExportConflictError extends Error {
  readonly name = "NotesExportConflictError";

  constructor(
    public readonly destination: string,
    public readonly request: NotesExportRequest
  ) {
    super(NOTES_EXPORT_CONFLICT_MESSAGE);
  }
}
