import { notesErrorHasCode } from "./notes";
import type { NoteId } from "./notes";

export type NotesExportFormat = "markdown" | "pdf";

export interface NotesExportRequest {
  vaultPath: string;
  rootNodeId: NoteId;
  destination: string;
  overwrite: boolean;
}

export interface NotesExportSaveRequest {
  vaultPath: string;
  rootNodeId: NoteId;
  format: NotesExportFormat;
  defaultFileName?: string;
}

export interface NotesExportResult {
  destination: string;
  format: NotesExportFormat;
}

/**
 * User-facing message for the destination-exists conflict. Retained purely as
 * the display text of {@link NotesExportConflictError}; the conflict is
 * *detected* by the backend `destinationExists` code (see
 * {@link isNotesExportConflict}), never by matching this string.
 */
const NOTES_EXPORT_CONFLICT_MESSAGE = "Destination already exists.";
const NOTES_EXPORT_EXTENSIONS: Record<NotesExportFormat, string> = {
  markdown: "md",
  pdf: "pdf"
};
const WINDOWS_RESERVED_DEVICE_STEMS = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
  "COM\u00b9",
  "COM\u00b2",
  "COM\u00b3",
  "LPT\u00b9",
  "LPT\u00b2",
  "LPT\u00b3"
]);

function sanitizeNotesExportTitle(title: string): string {
  return title
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTerminalFileNameEdges(value: string): string {
  return value.replace(/^\.+/, "").replace(/[. ]+$/, "");
}

function consumeTerminalExportSuffixes(
  value: string,
  extension: string
): string {
  let baseName = value;
  const suffix = `.${extension}`;

  while (baseName.toLowerCase().endsWith(suffix)) {
    baseName = normalizeTerminalFileNameEdges(
      baseName.slice(0, -suffix.length)
    );
  }

  return baseName;
}

function windowsComparisonStem(baseName: string): string {
  const firstDotIndex = baseName.indexOf(".");
  const stem =
    firstDotIndex === -1 ? baseName : baseName.slice(0, firstDotIndex);

  return stem.replace(/^[. ]+/, "").replace(/[. ]+$/, "");
}

function isWindowsReservedDeviceStem(stem: string): boolean {
  return WINDOWS_RESERVED_DEVICE_STEMS.has(stem.toUpperCase());
}

export function defaultNotesExportFileName(
  title: string | null | undefined,
  format: NotesExportFormat = "markdown"
): string {
  const extension = NOTES_EXPORT_EXTENSIONS[format];
  const sanitizedTitle = sanitizeNotesExportTitle(title ?? "");
  const baseName = consumeTerminalExportSuffixes(
    normalizeTerminalFileNameEdges(sanitizedTitle),
    extension
  );
  const comparableStem = windowsComparisonStem(baseName);

  return baseName && !isWindowsReservedDeviceStem(comparableStem)
    ? `${baseName}.${extension}`
    : `notes-export.${extension}`;
}

export function isNotesExportResult(
  value: unknown,
  expectedFormat?: NotesExportFormat
): value is NotesExportResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const result = value as Record<string, unknown>;
  return (
    Object.keys(result).length === 2 &&
    typeof result.destination === "string" &&
    result.destination.length > 0 &&
    (result.format === "markdown" || result.format === "pdf") &&
    (expectedFormat === undefined || result.format === expectedFormat)
  );
}

/**
 * True when a rejected export IPC cause is the backend's destination-exists
 * conflict, identified by its structured `destinationExists` code rather than
 * by any message text.
 */
export function isNotesExportConflict(cause: unknown): boolean {
  return notesErrorHasCode(cause, "destinationExists");
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
