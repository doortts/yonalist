import {
  MAX_PASTE_IMPORT_DEPTH,
  MAX_PASTE_IMPORT_FIELD_UTF8_BYTES,
  MAX_PASTE_IMPORT_NODES
} from "./notesPasteImport";

/**
 * Title-only tree prepared by the selection router after pending drafts have
 * been flushed. Callers may carry additional node metadata; the serializer
 * deliberately reads only these two fields so internal data cannot leak.
 */
export interface NotesClipboardOutlineNode {
  readonly title: string;
  readonly children: readonly NotesClipboardOutlineNode[];
}

interface PendingOutlineNode {
  readonly node: NotesClipboardOutlineNode;
  readonly depth: number;
}

function flattenTitleNewlines(title: string): string {
  return title.replace(/\r\n|\r|\n/g, " ");
}

function utf8ByteLength(text: string): number {
  let length = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    length +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return length;
}

/**
 * Serializes a title-only forest as a deterministic Markdown list. Returns
 * `null` when the forest cannot round-trip through the bounded paste-import
 * contract.
 */
export function serializeNotesClipboardOutline(
  roots: readonly NotesClipboardOutlineNode[]
): string | null {
  if (roots.length === 0) {
    return null;
  }

  const pending: PendingOutlineNode[] = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    pending.push({ node: roots[index], depth: 0 });
  }

  const lines: string[] = [];
  let nodeCount = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    nodeCount += 1;
    if (
      nodeCount > MAX_PASTE_IMPORT_NODES ||
      current.depth >= MAX_PASTE_IMPORT_DEPTH
    ) {
      return null;
    }

    const title = flattenTitleNewlines(current.node.title);
    if (utf8ByteLength(title) > MAX_PASTE_IMPORT_FIELD_UTF8_BYTES) {
      return null;
    }

    const marker = title.length === 0 ? "-" : `- ${title}`;
    lines.push(`${"  ".repeat(current.depth)}${marker}`);

    for (
      let index = current.node.children.length - 1;
      index >= 0;
      index -= 1
    ) {
      pending.push({
        node: current.node.children[index],
        depth: current.depth + 1
      });
    }
  }

  return lines.join("\n");
}
