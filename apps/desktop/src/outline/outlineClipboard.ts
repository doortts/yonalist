import type { ImageView } from "../../../../packages/contracts/generated/ImageView";
import type { IpcMarkerKind } from "../../../../packages/contracts/generated/IpcMarkerKind";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { bySiblingOrder } from "./outlineSortKeys";

// One set for both halves of the round trip: the read side in `outlinePaste`
// bounds what it accepts by the very numbers a copy is written under. They live
// here because that module already depends on this one.
export const MAX_CLIPBOARD_NODES = 2_000;
export const MAX_CLIPBOARD_DEPTH = 64;
export const MAX_TEXT_UTF8_BYTES = 100_000;
export const PAYLOAD_KIND = "yonalist-outline-clipboard";
export const PAYLOAD_VERSION = 1;

export function normalizeSelectedRoots(
  nodes: readonly NoteView[],
  selectedIds: readonly string[]
): readonly string[] {
  if (selectedIds.length === 0) return [];
  const selected = new Set(selectedIds);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes
    .filter((node) => selected.has(node.id))
    .filter((node) => {
      let parentId = node.parentId;
      const visited = new Set<string>();
      while (parentId && visited.add(parentId)) {
        if (selected.has(parentId)) return false;
        parentId = byId.get(parentId)?.parentId ?? null;
      }
      return true;
    })
    .map((node) => node.id);
}

/**
 * One copied row, its id dropped: a paste always mints its own, which is what
 * lets the same payload land twice or land on another page.
 */
export interface OutlineClipboardNode {
  readonly text: string;
  readonly note: string;
  readonly marker: IpcMarkerKind;
  readonly completed: boolean;
  readonly collapsed: boolean;
  readonly starred: boolean;
  /** The bytes stay in the asset store; this references them by hash. */
  readonly image: ImageView | null;
  readonly children: readonly OutlineClipboardNode[];
}

export interface OutlineClipboardPayload {
  readonly kind: typeof PAYLOAD_KIND;
  readonly version: typeof PAYLOAD_VERSION;
  readonly nodes: readonly OutlineClipboardNode[];
}

/**
 * What a copy reads a row from. Structural on purpose: the store's snapshot
 * satisfies it, and the serializer stays free of the store. The two draft
 * overlays are named rather than positional because they are the same type --
 * swapping them compiles and pastes the note as the title.
 */
export interface OutlineClipboardSource {
  readonly nodes: readonly NoteView[];
  readonly drafts: Readonly<Record<string, string>>;
  readonly noteDrafts: Readonly<Record<string, string>>;
}

/**
 * What one copy writes: the indented text every other app reads, and the HTML
 * that carries the whole row back to us.
 */
export interface OutlineClipboardFormats {
  readonly plain: string;
  readonly html: string;
  readonly payload: OutlineClipboardPayload;
}

function childrenBySortKey(
  nodes: readonly NoteView[]
): Map<string, NoteView[]> {
  const children = new Map<string, NoteView[]>();
  for (const node of nodes) {
    if (!node.parentId || node.deleted) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort(bySiblingOrder);
  }
  return children;
}

/**
 * The selected subtrees as a tree, or `null` when the selection is outside the
 * bounds a paste accepts. Both written formats render from this one walk, so
 * the text and the payload can never disagree about the shape.
 */
export function buildOutlineClipboardPayload(
  source: OutlineClipboardSource,
  selectedIds: readonly string[]
): OutlineClipboardPayload | null {
  const { nodes, drafts, noteDrafts } = source;
  const roots = normalizeSelectedRoots(nodes, selectedIds);
  if (roots.length === 0 || roots.length > MAX_CLIPBOARD_NODES) return null;

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = childrenBySortKey(nodes);
  const encoder = new TextEncoder();
  let visited = 0;
  const build = (id: string, depth: number): OutlineClipboardNode | null => {
    const node = byId.get(id);
    visited += 1;
    if (
      !node ||
      depth >= MAX_CLIPBOARD_DEPTH ||
      visited > MAX_CLIPBOARD_NODES
    ) {
      return null;
    }
    // A title is one line by contract; a note keeps its own.
    const text = (drafts[id] ?? node.text).replace(/\r\n|\r|\n/g, " ");
    const note = (noteDrafts[id] ?? node.note).replace(/\r\n|\r/g, "\n");
    if (
      encoder.encode(text).byteLength > MAX_TEXT_UTF8_BYTES ||
      encoder.encode(note).byteLength > MAX_TEXT_UTF8_BYTES
    ) {
      return null;
    }
    const built: OutlineClipboardNode[] = [];
    for (const child of children.get(id) ?? []) {
      const subtree = build(child.id, depth + 1);
      if (!subtree) return null;
      built.push(subtree);
    }
    return {
      text,
      note,
      marker: node.marker,
      completed: node.completed,
      collapsed: node.collapsed,
      starred: node.starred,
      image: node.image,
      children: built
    };
  };

  const built: OutlineClipboardNode[] = [];
  for (const id of roots) {
    const subtree = build(id, 0);
    if (!subtree) return null;
    built.push(subtree);
  }
  return {
    kind: PAYLOAD_KIND,
    version: PAYLOAD_VERSION,
    nodes: built
  };
}

/**
 * The Markdown task box as GFM writes it, which is what a paste reads back and
 * what a hand used to Markdown types at a title's start. The character between
 * the brackets is required here; the bare pair `[]` a hand types instead is the
 * typed path's own shorthand and never reaches a paste.
 */
const TODO_BOX = /^\[([ xX])\](?: (.*))?$/u;

export interface TodoBox {
  readonly completed: boolean;
  /** What follows the box and the one space after it. */
  readonly rest: string;
  /** Whether that space was there at all; a bare box ends the line. */
  readonly spaced: boolean;
}

/** One recogniser for both halves of the round trip: reading and writing. */
export function readTodoBox(content: string): TodoBox | null {
  const box = TODO_BOX.exec(content);
  if (!box) return null;
  return {
    completed: box[1]!.toLowerCase() === "x",
    rest: box[2] ?? "",
    spaced: box[2] !== undefined
  };
}

/**
 * The Markdown task box a row carries out of the app, `""` for a plain bullet
 * still open, and bare: each format puts the space where its own syntax wants it.
 * The tick has nowhere else to go in text, so a completed row takes a box
 * whatever its marker: reading that back through the plain path makes a completed
 * bullet a to-do, which is the price of not losing the tick. An in-app paste
 * reads the payload, which keeps the true marker.
 *
 * This is the clipboard's rule alone, and neither export shares it: the PDF
 * prints a box only for a `todo` marker, so a completed bullet prints its dot
 * and loses the tick, and the Markdown export writes a box on every row.
 */
function taskBox(node: OutlineClipboardNode): string {
  if (node.completed) return "[x]";
  return node.marker === "todo" ? "[ ]" : "";
}

function plainLines(
  nodes: readonly OutlineClipboardNode[],
  depth: number,
  lines: string[]
): void {
  for (const node of nodes) {
    const indent = "  ".repeat(depth);
    const box = taskBox(node);
    const marker = `${indent}-${box ? ` ${box}` : ""}`;
    lines.push(node.text ? `${marker} ${node.text}` : marker);
    // A note sits one level in from its own row, as the Markdown export writes
    // it, and before the children so the reading order matches the screen.
    if (node.note.length > 0) {
      for (const line of node.note.split("\n")) {
        lines.push(line ? `${indent}  > ${line}` : `${indent}  >`);
      }
    }
    plainLines(node.children, depth + 1, lines);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/gu, (character) =>
    character === "&" ? "&amp;" : character === "<" ? "&lt;" : "&gt;");
}

function htmlList(nodes: readonly OutlineClipboardNode[]): string {
  const items = nodes.map((node) => {
    // The box stays characters rather than an `<input>`: a rich editor strips
    // form controls on paste, and the tick survives today precisely because it
    // is text. `<s>` carries the screen's strike-through the same way, over the
    // title alone as the stylesheet draws it.
    const box = taskBox(node);
    const title = escapeHtml(node.text);
    const struck = node.completed && title.length > 0 ? `<s>${title}</s>` : title;
    // A rich-text app prefers text/html and never reads the payload comment, so
    // a note left out here is a note that app never sees.
    const note = node.note.length > 0
      ? `<blockquote>${escapeHtml(node.note).replace(/\n/gu, "<br>")}</blockquote>`
      : "";
    const children = node.children.length > 0 ? htmlList(node.children) : "";
    // Workflowy reads this attribute off the `<li>` it walks into and keeps the
    // row a bullet. Without it, one `[ ]` box anywhere in the paste marks the
    // whole sibling group as Markdown, and every row that carries no marker of
    // its own is forced to their paragraph layout, which draws no bullet at all.
    // A box still wins over the attribute on their side, so a todo row stays a
    // todo row, and every other target ignores an attribute it does not know.
    return `<li data-wf-layout="bullet">`
      + `${box ? `${box} ` : ""}${struck}${note}${children}</li>`;
  });
  return `<ul>${items.join("")}</ul>`;
}

/**
 * The payload as an HTML comment at the very start of the markup: base64 keeps
 * a `--` inside the JSON from closing the comment early and needs no escaping
 * of its own, and a consumer that truncates the markup still keeps the comment.
 */
function payloadComment(payload: OutlineClipboardPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  // btoa reads one byte per code unit, so the UTF-8 bytes go in as a byte
  // string -- chunked, because spreading a whole large payload into one call
  // overflows the argument list.
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return `<!--${PAYLOAD_KIND}:${btoa(binary)}-->`;
}

function serializeOutlinePayload(payload: OutlineClipboardPayload): string {
  const lines: string[] = [];
  plainLines(payload.nodes, 0, lines);
  return lines.join("\n");
}

export function buildOutlineClipboardFormats(
  source: OutlineClipboardSource,
  selectedIds: readonly string[]
): OutlineClipboardFormats | null {
  const payload = buildOutlineClipboardPayload(source, selectedIds);
  if (!payload) return null;
  return {
    plain: serializeOutlinePayload(payload),
    html: `${payloadComment(payload)}${htmlList(payload.nodes)}`,
    payload
  };
}

/**
 * The two reasons a Cut is turned down. They live together because the surfaces
 * that cut have to answer with the same words. The row menu shows them on the
 * item it disables rather than in the pane's status line: a bullet menu has no
 * feedback channel of its own, so a write the clipboard refuses after the menu
 * has closed passes there in silence. It leaves the row where it is, which is
 * the part that matters.
 */
export const CUT_OVER_CLIPBOARD_BOUNDS =
  "Cut is unavailable because these rows are too large for the clipboard.";
// Named for the window, not the selection: two of the three surfaces that show
// it are answering for a right-clicked row and for the loaded window itself.
// The wording stays as the users read it.
export const OUTLINE_WINDOW_INCOMPLETE =
  "The complete selection is not available yet.";

export function writeOutlineClipboardEvent(
  clipboardData: Pick<DataTransfer, "setData">,
  formats: OutlineClipboardFormats
): boolean {
  try {
    clipboardData.setData("text/plain", formats.plain);
    clipboardData.setData("text/markdown", formats.plain);
    // The rich payload rides in the HTML: a standard type every engine writes,
    // and a rich-text app still gets a real list out of it.
    clipboardData.setData("text/html", formats.html);
    return true;
  } catch {
    return false;
  }
}

/**
 * `payloadRequired` is what a Cut passes. The plain text below carries no
 * payload, so a caller that deletes against this write would delete rows
 * nothing left on the clipboard could bring back; a copy loses nothing by
 * degrading and keeps the fallback.
 */
export async function writeOutlineClipboard(
  formats: OutlineClipboardFormats,
  // No default: a cut that forgets this would delete against a clipboard the
  // degrade path had emptied, and the compiler is a cheaper guard than a test.
  payloadRequired: boolean
): Promise<void> {
  const clipboard = navigator.clipboard;
  if (!clipboard) throw new Error("Clipboard access is unavailable.");
  if (typeof ClipboardItem === "function" && typeof clipboard.write === "function") {
    try {
      await clipboard.write([new ClipboardItem({
        "text/plain": new Blob([formats.plain], { type: "text/plain" }),
        "text/markdown": new Blob([formats.plain], { type: "text/markdown" }),
        "text/html": new Blob([formats.html], { type: "text/html" })
      })]);
      return;
    } catch {
      // Some WebViews expose ClipboardItem but reject custom MIME writes.
    }
  }
  if (payloadRequired) {
    throw new Error("The clipboard could not take the whole selection.");
  }
  if (typeof clipboard.writeText === "function") {
    await clipboard.writeText(formats.plain);
    return;
  }
  throw new Error("Clipboard write is unavailable.");
}
