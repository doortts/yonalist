import type { ExportFormat } from "../../../packages/contracts/generated/ExportFormat";
import { defaultExportFileName } from "./exportApi";

export async function pickExportPath(
  title: string,
  format: ExportFormat
): Promise<string | null> {
  const defaultPath = defaultExportFileName(title, format);
  if (!("__TAURI_INTERNALS__" in window)) {
    return defaultPath;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({
    defaultPath,
    filters: [{
      name: format === "markdown" ? "Markdown" : "PDF",
      extensions: [format === "markdown" ? "md" : "pdf"]
    }]
  });
}

export function downloadPreviewExport(
  fileName: string,
  bytes: BlobPart[],
  type: string
): void {
  const url = URL.createObjectURL(new Blob(bytes, { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  queueMicrotask(() => URL.revokeObjectURL(url));
}

export function previewPdfBytes(title: string): Uint8Array {
  const safeTitle = [...title]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code <= 126 ? character : "?";
    })
    .join("")
    .replace(/([\\()])/g, "\\$1");
  const stream = `BT /F1 18 Tf 54 780 Td (${safeTitle}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1)
    .map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
