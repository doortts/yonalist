import type { ImageView } from "../../../packages/contracts/generated/ImageView";
import type { IpcImportImage } from "../../../packages/contracts/generated/IpcImportImage";
import type { IpcImportNode } from "../../../packages/contracts/generated/IpcImportNode";
import type { IpcMarkerKind } from "../../../packages/contracts/generated/IpcMarkerKind";
import {
  MAX_CLIPBOARD_DEPTH,
  MAX_CLIPBOARD_NODES,
  MAX_TEXT_UTF8_BYTES,
  PAYLOAD_KIND,
  PAYLOAD_VERSION,
  type OutlineClipboardNode,
  type OutlineClipboardPayload
} from "./outlineClipboard";
import { readTodoBox } from "./outlineSlash";

/**
 * One pasted row. Everything past the title is optional: plain outside text
 * fills in the title alone, and our own copy fills in the rest.
 */
export interface PastedOutlineNode {
  readonly title: string;
  readonly note?: string;
  readonly marker?: IpcMarkerKind;
  readonly completed?: boolean;
  readonly collapsed?: boolean;
  readonly starred?: boolean;
  /** The bytes stay in the asset store; the import references them by hash. */
  readonly image?: IpcImportImage;
  readonly children: PastedOutlineNode[];
}

const PAYLOAD_COMMENT = new RegExp(
  `<!--${PAYLOAD_KIND}:([A-Za-z0-9+/=]*)-->`,
  "u"
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A measurement the other side reads as a `u32`/`u64`: whole, in range, and
 * neither a fraction nor a NaN. Plain `typeof` lets all three through, and the
 * bounds further in only refuse what is too large -- so a `-5` or a `1.5` would
 * reach the browser preview and be refused only by Rust's own serde.
 */
function isCount(value: unknown, least: number): value is number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= least;
}

/** `undefined` for a malformed reference; `null` is a row with no image. */
function readClipboardImage(source: unknown): ImageView | null | undefined {
  if (source === null) return null;
  if (!isRecord(source)) return undefined;
  const {
    contentHash, originalName, mimeType, byteLength,
    pixelWidth, pixelHeight, displayWidth
  } = source;
  if (
    typeof contentHash !== "string" ||
    typeof originalName !== "string" ||
    typeof mimeType !== "string" ||
    // The floors notes-core writes an image by: one byte, one pixel each way.
    // The display width's own floor of 120 stays with the validation that
    // refuses the whole import, so a narrow one is refused by its message.
    !isCount(byteLength, 1) ||
    !isCount(pixelWidth, 1) ||
    !isCount(pixelHeight, 1) ||
    !isCount(displayWidth, 0)
  ) {
    return undefined;
  }
  return {
    contentHash, originalName, mimeType, byteLength,
    pixelWidth, pixelHeight, displayWidth
  };
}

function readClipboardNode(
  source: unknown,
  depth: number,
  budget: { left: number }
): OutlineClipboardNode | null {
  budget.left -= 1;
  if (!isRecord(source) || depth >= MAX_CLIPBOARD_DEPTH || budget.left < 0) {
    return null;
  }
  const { text, note, marker, completed, collapsed, starred, children } = source;
  const encoder = new TextEncoder();
  if (
    typeof text !== "string" ||
    typeof note !== "string" ||
    (marker !== "bullet" && marker !== "todo") ||
    typeof completed !== "boolean" ||
    typeof collapsed !== "boolean" ||
    typeof starred !== "boolean" ||
    !Array.isArray(children) ||
    encoder.encode(text).byteLength > MAX_TEXT_UTF8_BYTES ||
    encoder.encode(note).byteLength > MAX_TEXT_UTF8_BYTES
  ) {
    return null;
  }
  const image = readClipboardImage(source.image);
  if (image === undefined) return null;
  const built: OutlineClipboardNode[] = [];
  for (const child of children) {
    const subtree = readClipboardNode(child, depth + 1, budget);
    if (!subtree) return null;
    built.push(subtree);
  }
  return {
    text, note, marker, completed, collapsed, starred, image, children: built
  };
}

/**
 * The payload back out of a copy's HTML, or `null` when the markup carries none
 * this build can read -- a caller falls through to the plain text then. What
 * comes off the clipboard is someone else's JSON, so every field is read by
 * name into a fresh object rather than trusted as the shape it claims to be,
 * and nothing here throws.
 */
export function extractOutlinePayload(
  html: string
): OutlineClipboardPayload | null {
  const encoded = PAYLOAD_COMMENT.exec(html)?.[1];
  if (encoded === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
    ));
    if (
      !isRecord(parsed) ||
      parsed.kind !== PAYLOAD_KIND ||
      parsed.version !== PAYLOAD_VERSION ||
      !Array.isArray(parsed.nodes) ||
      // A copy never writes an empty one. Reading it as a payload would take
      // the paste over and then import nothing, where `null` hands the gesture
      // to the plain text behind it.
      parsed.nodes.length === 0
    ) {
      return null;
    }
    const budget = { left: MAX_CLIPBOARD_NODES };
    const nodes: OutlineClipboardNode[] = [];
    for (const source of parsed.nodes) {
      const node = readClipboardNode(source, 0, budget);
      if (!node) return null;
      nodes.push(node);
    }
    return {
      kind: PAYLOAD_KIND,
      version: PAYLOAD_VERSION,
      nodes
    };
  } catch {
    return null;
  }
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
    // A collapsed subtree pastes back collapsed rather than thrown open.
    collapsed: node.collapsed,
    starred: node.starred,
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
      collapsed: source.collapsed,
      starred: source.starred,
      image: source.image
    });
    source.children.forEach((child) => append(child, id));
    return id;
  };
  return { rootIds: roots.map((root) => append(root, parentId)), nodes };
}

const MAX_SOURCE_CHARACTERS = 2_000_000;
const MARKDOWN_ROW = /^-(?: |$)/u;

interface ParsedLine {
  readonly depth: number;
  readonly title: string;
  readonly note?: string;
  readonly marker?: IpcMarkerKind;
  readonly completed?: boolean;
}

function markdownRow(depth: number, content: string): ParsedLine {
  // The same recogniser the typed box goes through, so the two cannot drift.
  const box = readTodoBox(content);
  if (!box) return { depth, title: content };
  return {
    depth,
    title: box.rest,
    marker: "todo",
    completed: box.completed
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
  if (lines.length === 0 || lines.length > MAX_CLIPBOARD_NODES) return null;

  const hasMarkdown = lines.some((line) =>
    MARKDOWN_ROW.test(line.slice(line.match(/^[\t ]*/u)?.[0].length ?? 0)));
  const parsed = hasMarkdown
    ? markdownLines(lines)
    : lines.map(plainLine);
  if (!parsed) return null;
  if (!hasMarkdown && parsed.length < 2) return null;
  const encoder = new TextEncoder();
  if (parsed.some((line) =>
    encoder.encode(line.title).byteLength > MAX_TEXT_UTF8_BYTES ||
    encoder.encode(line.note ?? "").byteLength > MAX_TEXT_UTF8_BYTES)) {
    return null;
  }

  const roots: PastedOutlineNode[] = [];
  const stack: PastedOutlineNode[] = [];
  const baseline = parsed[0].depth;
  for (const line of parsed) {
    const depth = Math.min(Math.max(0, line.depth - baseline), stack.length);
    if (depth >= MAX_CLIPBOARD_DEPTH) return null;
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
