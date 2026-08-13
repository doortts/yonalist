import type { IpcImportImage } from "../../../packages/contracts/generated/IpcImportImage";
import type { IpcImportNode } from "../../../packages/contracts/generated/IpcImportNode";
import type { IpcMarkerKind } from "../../../packages/contracts/generated/IpcMarkerKind";
import type {
  OutlineClipboardNode,
  OutlineClipboardPayload
} from "./outlineClipboard";

/**
 * One pasted row. Everything past the title is optional: plain outside text
 * fills in the title alone, and our own copy fills in the rest.
 */
export interface PastedOutlineNode {
  readonly title: string;
  readonly note?: string;
  readonly marker?: IpcMarkerKind;
  readonly completed?: boolean;
  /** The bytes stay in the asset store; the import references them by hash. */
  readonly image?: IpcImportImage;
  readonly children: PastedOutlineNode[];
}

/** A copied payload as the shape the import path already flattens. */
export function pastedOutlineFromPayload(
  payload: OutlineClipboardPayload
): PastedOutlineNode[] {
  const convert = (node: OutlineClipboardNode): PastedOutlineNode => ({
    title: node.text,
    note: node.note,
    marker: node.marker,
    completed: node.completed,
    // Field for field rather than a spread: what crosses to the command is the
    // wire shape, not whatever the view type happens to carry.
    image: node.image
      ? {
        contentHash: node.image.contentHash,
        originalName: node.image.originalName,
        mimeType: node.image.mimeType,
        byteLength: node.image.byteLength,
        pixelWidth: node.image.pixelWidth,
        pixelHeight: node.image.pixelHeight,
        displayWidth: node.image.displayWidth
      }
      : undefined,
    children: node.children.map(convert)
  });
  return payload.nodes.map(convert);
}

export function flattenPastedOutline(
  roots: readonly PastedOutlineNode[],
  parentId: string,
  createId: () => string
): {
  readonly rootIds: readonly string[];
  readonly nodes: readonly IpcImportNode[];
} {
  const nodes: IpcImportNode[] = [];
  const append = (source: PastedOutlineNode, importedParentId: string) => {
    const id = createId();
    nodes.push({
      id,
      parentId: importedParentId,
      text: source.title,
      note: source.note,
      marker: source.marker,
      completed: source.completed,
      image: source.image
    });
    source.children.forEach((child) => append(child, id));
    return id;
  };
  return { rootIds: roots.map((root) => append(root, parentId)), nodes };
}

const MAX_NODES = 2_000;
const MAX_DEPTH = 64;
const MAX_TITLE_BYTES = 100_000;
const MAX_SOURCE_CHARACTERS = 2_000_000;
const MARKDOWN_ROW = /^-(?: |$)/u;
// The Markdown task list, which is what a copy writes for a to-do row.
const TODO_BOX = /^\[([ xX])\](?: (.*))?$/u;

interface ParsedLine {
  readonly depth: number;
  readonly title: string;
  readonly note?: string;
  readonly marker?: IpcMarkerKind;
  readonly completed?: boolean;
}

function markdownRow(depth: number, content: string): ParsedLine {
  const box = TODO_BOX.exec(content);
  if (!box) return { depth, title: content };
  return {
    depth,
    title: box[2] ?? "",
    marker: "todo",
    completed: box[1]!.toLowerCase() === "x"
  };
}

/**
 * Markdown rows with the note lines that belong to them, or `null` when a line
 * is neither. A note sits one level in from its own row and before that row's
 * children, which is the shape a copy writes and the only one read back here.
 */
function markdownLines(lines: readonly string[]): ParsedLine[] | null {
  const rows: ParsedLine[] = [];
  const noteLines: string[] = [];
  let noteIndent = -1;
  const closeNote = () => {
    if (noteLines.length === 0) return;
    rows[rows.length - 1] = {
      ...rows[rows.length - 1]!,
      note: noteLines.join("\n")
    };
    noteLines.length = 0;
  };
  for (const line of lines) {
    const indent = line.match(/^[\t ]*/u)?.[0] ?? "";
    const content = line.slice(indent.length);
    if (MARKDOWN_ROW.test(content)) {
      if (indent.includes("\t") || indent.length % 2 !== 0) return null;
      closeNote();
      rows.push(markdownRow(
        indent.length / 2,
        content === "-" ? "" : content.slice(2)
      ));
      noteIndent = indent.length + 2;
      continue;
    }
    if (
      rows.length > 0 &&
      indent.length === noteIndent &&
      (content === ">" || content.startsWith("> "))
    ) {
      noteLines.push(content === ">" ? "" : content.slice(2));
      continue;
    }
    return null;
  }
  closeNote();
  return rows;
}

function plainLine(line: string): ParsedLine {
  const indent = line.match(/^[\t ]*/u)?.[0] ?? "";
  const tabCount = [...indent].filter((character) => character === "\t").length;
  return {
    depth: tabCount > 0 ? tabCount : Math.floor(indent.length / 2),
    title: line.slice(indent.length).trimEnd()
  };
}

export function parsePastedOutline(source: string): PastedOutlineNode[] | null {
  if (
    source.length === 0 ||
    source.length > MAX_SOURCE_CHARACTERS ||
    !/[\r\n]/u.test(source)
  ) {
    return null;
  }
  const lines = source
    .replace(/\r\n?|\n/gu, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0 || lines.length > MAX_NODES) return null;

  const hasMarkdown = lines.some((line) =>
    MARKDOWN_ROW.test(line.slice(line.match(/^[\t ]*/u)?.[0].length ?? 0)));
  const parsed = hasMarkdown
    ? markdownLines(lines)
    : lines.map(plainLine);
  if (!parsed) return null;
  if (!hasMarkdown && parsed.length < 2) return null;
  const encoder = new TextEncoder();
  if (parsed.some((line) =>
    encoder.encode(line.title).byteLength > MAX_TITLE_BYTES ||
    encoder.encode(line.note ?? "").byteLength > MAX_TITLE_BYTES)) {
    return null;
  }

  const roots: PastedOutlineNode[] = [];
  const stack: PastedOutlineNode[] = [];
  const baseline = parsed[0].depth;
  for (const line of parsed) {
    const depth = Math.min(Math.max(0, line.depth - baseline), stack.length);
    if (depth >= MAX_DEPTH) return null;
    stack.length = depth;
    const node: PastedOutlineNode = {
      title: line.title,
      note: line.note,
      marker: line.marker,
      completed: line.completed,
      children: []
    };
    if (depth === 0) roots.push(node);
    else stack[depth - 1].children.push(node);
    stack.push(node);
  }
  return roots;
}
