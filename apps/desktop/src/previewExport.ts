import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesExportRequest } from "../../../packages/contracts/generated/NotesExportRequest";
import type { NotesExportResult } from "../../../packages/contracts/generated/NotesExportResult";
import { previewVisibleSubtree } from "./previewTree";

export async function exportPreviewNotes(
  request: NotesExportRequest,
  context: {
    readonly sessionId: string;
    readonly revision: number;
    readonly nodes: readonly NoteView[];
  }
): Promise<NotesExportResult> {
  if (
    request.sessionId !== context.sessionId ||
    request.baseRevision !== context.revision
  ) {
    throw {
      code: "revision_conflict",
      message: "Preview revision is stale.",
      retryable: true
    };
  }
  const root = context.nodes.find((node) =>
    node.id === request.rootNodeId && !node.deleted
  );
  if (!root) {
    throw {
      code: "not_found",
      message: "The export root no longer exists.",
      retryable: false
    };
  }
  const { downloadPreviewExport, previewPdfBytes } =
    await import("./exportPicker");
  if (request.format === "markdown") {
    const subtree = previewVisibleSubtree(context.nodes, root.id);
    const byId = new Map(subtree.map((node) => [node.id, node]));
    const depth = (node: NoteView) => {
      let value = 0;
      let parentId = node.parentId;
      while (parentId && parentId !== root.parentId && byId.has(parentId)) {
        value += 1;
        parentId = byId.get(parentId)?.parentId ?? null;
      }
      return value;
    };
    const markdown = subtree.map((node) =>
      `${"  ".repeat(depth(node))}- [${node.completed ? "x" : " "}] ${node.text}`
    ).join("\n");
    downloadPreviewExport(
      request.destinationPath,
      [markdown, "\n"],
      "text/markdown;charset=utf-8"
    );
  } else {
    const pdfBytes = previewPdfBytes(root.text);
    const pdfBuffer = pdfBytes.buffer.slice(
      pdfBytes.byteOffset,
      pdfBytes.byteOffset + pdfBytes.byteLength
    ) as ArrayBuffer;
    downloadPreviewExport(
      request.destinationPath,
      [pdfBuffer],
      "application/pdf"
    );
  }
  return {
    revision: context.revision,
    rootNodeId: root.id,
    format: request.format,
    destinationPath: request.destinationPath
  };
}
