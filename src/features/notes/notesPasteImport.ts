/**
 * Pure parser for Phase 4.4b's paste-import: turn a Markdown list or
 * multi-line indented plain text into the `ImportNode` forest
 * `notes_import_subtree` expects. No IO, no Tauri, no React — this module only
 * reads a string and returns a tree or `null`.
 *
 * Indentation rules (documented, not just implemented, since there is no
 * single universally "correct" convention for plain-text outlines):
 *  - A line's indent depth is measured from its leading whitespace only.
 *    - If that whitespace contains at least one tab, depth = the number of
 *      tab characters (any spaces mixed in are ignored — tabs are the
 *      primary signal).
 *    - Otherwise (spaces only, or no leading whitespace), depth =
 *      `floor(leadingSpaceCount / 2)` — every 2 spaces is one level. A
 *      single leading space does not add a level (tolerates ragged/odd
 *      indentation from a sloppy paste source).
 *  - The FIRST non-blank line's raw depth is the baseline (that line becomes
 *    depth 0); every other line's depth is measured relative to it. Content
 *    that starts less indented than the baseline clamps to depth 0 rather
 *    than going negative.
 *  - Blank lines (whitespace-only, including empty) are skipped entirely —
 *    they produce no node and do not participate in the indent stack. They
 *    are never promoted to empty nodes.
 *  - A line's actual tree depth is its position in the indent *stack*, not
 *    its raw computed depth: a line can only nest one level deeper than its
 *    nearest preceding shallower line, however far its own indentation jumps
 *    ahead. (Standard indentation-outline parsing — this is what lets a
 *    ["a", "        b"] pair with a huge indent jump still parse as `a > b`
 *    instead of `b` floating at some enormous, meaningless depth.)
 *  - Every line's content (after stripping its leading indent) has its
 *    trailing whitespace trimmed. Leading whitespace beyond the indent itself
 *    is preserved as part of the title (only the *recognized* indent prefix
 *    is consumed).
 *
 * Markdown list rules:
 *  - Every non-blank line is `-`, `- title`, or the same marker indented by
 *    exactly two spaces per raw depth.
 *  - A single Markdown item is structural, including `-` for an empty title.
 *  - Tabs, odd indentation, and a mix of Markdown and legacy lines are
 *    rejected instead of being reinterpreted as a different tree.
 *
 * Not an import:
 *  - Legacy text with no newline at all (a single line) — this is normal text
 *    paste, never a subtree import.
 *  - Text that yields zero nodes, or legacy text that yields exactly one
 *    node after blank-line skipping. Markdown's explicit marker makes one
 *    item structural.
 *  - Text that would blow the defensive caps below — this rejects to `null`
 *    so the caller falls back to plain paste rather than sending an
 *    oversized/degenerate payload to the backend (which enforces the same
 *    caps and would otherwise just reject it there instead).
 */

export interface ImportNode {
  title: string;
  note?: string;
  children: ImportNode[];
}

/**
 * Mirrors the backend's `MAX_IMPORT_SUBTREE_NODES` /
 * `MAX_IMPORT_SUBTREE_DEPTH` / `MAX_IMPORT_SUBTREE_FIELD_UTF8_BYTES`
 * (src-tauri/src/notes/types.rs). Kept here — rather than imported, since the
 * frontend has no build-time link to the Rust crate — so a paste that would
 * be rejected server-side is instead recognized as "not an import" before it
 * ever reaches IPC, and falls back to plain text paste.
 */
export const MAX_PASTE_IMPORT_NODES = 2000;
export const MAX_PASTE_IMPORT_DEPTH = 64;
export const MAX_PASTE_IMPORT_FIELD_UTF8_BYTES = 100_000;

interface RawImportLine {
  depth: number;
  title: string;
}

interface ParsedMarkdownLine extends RawImportLine {
  isMarkdownCandidate: boolean;
  isValid: boolean;
}

function leadingIndentDepth(line: string): { depth: number; contentStart: number } {
  let index = 0;
  let tabCount = 0;
  let spaceCount = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === "\t") {
      tabCount += 1;
    } else if (char === " ") {
      spaceCount += 1;
    } else {
      break;
    }
    index += 1;
  }
  const depth = tabCount > 0 ? tabCount : Math.floor(spaceCount / 2);
  return { depth, contentStart: index };
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function parseMarkdownLine(line: string): ParsedMarkdownLine {
  let indentEnd = 0;
  let hasTab = false;
  while (indentEnd < line.length) {
    if (line[indentEnd] === " ") {
      indentEnd += 1;
      continue;
    }
    if (line[indentEnd] === "\t") {
      hasTab = true;
      indentEnd += 1;
      continue;
    }
    break;
  }

  const marker = line[indentEnd];
  const afterMarker = line[indentEnd + 1];
  const isMarkdownCandidate =
    marker === "-" && (afterMarker === undefined || afterMarker === " ");
  const isValid =
    isMarkdownCandidate && !hasTab && indentEnd % 2 === 0;
  const title =
    afterMarker === undefined ? "" : line.slice(indentEnd + 2);

  return {
    depth: indentEnd / 2,
    title,
    isMarkdownCandidate,
    isValid
  };
}

function parseRawLines(lines: readonly string[]): {
  rawLines: RawImportLine[];
  isMarkdown: boolean;
} | null {
  const markdownLines = lines.map(parseMarkdownLine);
  const hasMarkdownCandidate = markdownLines.some(
    (line) => line.isMarkdownCandidate
  );

  if (hasMarkdownCandidate) {
    if (!markdownLines.every((line) => line.isValid)) {
      return null;
    }
    return {
      isMarkdown: true,
      rawLines: markdownLines.map(({ depth, title }) => ({ depth, title }))
    };
  }

  return {
    isMarkdown: false,
    rawLines: lines.map((line) => {
      const { depth, contentStart } = leadingIndentDepth(line);
      return {
        depth,
        title: line.slice(contentStart).replace(/\s+$/, "")
      };
    })
  };
}

function collectBoundedContentLines(text: string): {
  readonly contentLines: string[];
  readonly hadLineBreak: boolean;
} | null {
  const contentLines: string[] = [];
  let lineStart = 0;
  let hadLineBreak = false;

  const appendLine = (lineEnd: number): boolean => {
    const line = text.slice(lineStart, lineEnd);
    if (line.trim().length === 0) {
      return true;
    }
    if (contentLines.length === MAX_PASTE_IMPORT_NODES) {
      return false;
    }
    contentLines.push(line);
    return true;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== "\n" && character !== "\r") {
      continue;
    }
    hadLineBreak = true;
    if (!appendLine(index)) {
      return null;
    }
    if (character === "\r" && text[index + 1] === "\n") {
      index += 1;
    }
    lineStart = index + 1;
  }
  if (!appendLine(text.length)) {
    return null;
  }
  return { contentLines, hadLineBreak };
}

/**
 * Parses `text` into a forest of `ImportNode`s, or returns `null` when the
 * text is not a multi-line structural paste (single line, no structural
 * content after blank-line skipping, or over a defensive cap — see the
 * module doc comment).
 */
export function parsePastedOutline(text: string): ImportNode[] | null {
  const collected = collectBoundedContentLines(text);
  if (collected === null) {
    return null;
  }
  const parsed = parseRawLines(collected.contentLines);
  if (parsed === null) {
    return null;
  }
  const { rawLines, isMarkdown } = parsed;

  if (
    rawLines.length === 0 ||
    (!isMarkdown &&
      (rawLines.length < 2 || !collected.hadLineBreak))
  ) {
    return null;
  }

  const baseline = rawLines[0].depth;
  for (const rawLine of rawLines) {
    if (
      utf8ByteLength(rawLine.title) > MAX_PASTE_IMPORT_FIELD_UTF8_BYTES
    ) {
      return null;
    }
  }

  const roots: ImportNode[] = [];
  // `stack[i]` is the most recently emitted node currently at tree depth `i`.
  // A new line's tree depth is capped at `stack.length` (one deeper than its
  // nearest shallower predecessor), never its raw computed depth.
  const stack: ImportNode[] = [];
  for (const rawLine of rawLines) {
    const relativeDepth = Math.max(0, rawLine.depth - baseline);
    const treeDepth = Math.min(relativeDepth, stack.length);
    // `treeDepth` is 0-indexed (roots = 0), but the backend counts roots as
    // depth 1 and rejects `depth > MAX_IMPORT_SUBTREE_DEPTH`
    // (src-tauri/src/notes/types.rs) — i.e. it accepts 0-indexed depths
    // 0..MAX_PASTE_IMPORT_DEPTH-1. Rejecting `>=` here (rather than `>`) keeps
    // the two caps in sync so a tree the backend would refuse never gets past
    // `event.preventDefault()` only to have the import silently dropped when
    // IPC rejects it.
    if (treeDepth >= MAX_PASTE_IMPORT_DEPTH) {
      return null;
    }
    stack.length = treeDepth;
    const node: ImportNode = { title: rawLine.title, children: [] };
    if (treeDepth === 0) {
      roots.push(node);
    } else {
      stack[treeDepth - 1].children.push(node);
    }
    stack.push(node);
  }

  return roots;
}

export function parseExternalTitlePaste(text: string): ImportNode[] | null {
  return text.includes("\n") || text.includes("\r")
    ? parsePastedOutline(text)
    : null;
}
