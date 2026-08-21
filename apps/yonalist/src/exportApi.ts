import type { ExportFormat } from "../../../packages/contracts/generated/ExportFormat";

const EXTENSIONS: Record<ExportFormat, string> = {
  markdown: "md",
  pdf: "pdf"
};
const WINDOWS_RESERVED_STEMS = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)
]);

export function defaultExportFileName(
  title: string | null | undefined,
  format: ExportFormat
): string {
  const extension = EXTENSIONS[format];
  let stem = (title ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  const suffix = `.${extension}`;
  while (stem.toLocaleLowerCase().endsWith(suffix)) {
    stem = stem.slice(0, -suffix.length).replace(/[. ]+$/, "");
  }
  const deviceStem = stem.split(".", 1)[0].toLocaleUpperCase();
  if (!stem || WINDOWS_RESERVED_STEMS.has(deviceStem)) {
    stem = "notes-export";
  }
  return `${stem}.${extension}`;
}

export function exportFormatLabel(format: ExportFormat): string {
  return format === "markdown" ? "Markdown" : "PDF";
}

export function isDestinationConflict(cause: unknown): boolean {
  return Boolean(
    cause &&
    typeof cause === "object" &&
    "code" in cause &&
    cause.code === "destination_exists"
  );
}

export function isRetryableExportError(cause: unknown): boolean {
  return Boolean(
    cause &&
    typeof cause === "object" &&
    "retryable" in cause &&
    cause.retryable === true
  );
}
