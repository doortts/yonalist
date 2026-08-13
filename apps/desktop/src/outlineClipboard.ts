import type { ImageView } from "../../../packages/contracts/generated/ImageView";
import type { IpcMarkerKind } from "../../../packages/contracts/generated/IpcMarkerKind";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";

const MAX_CLIPBOARD_NODES = 2_000;
const MAX_CLIPBOARD_DEPTH = 64;
const MAX_TEXT_UTF8_BYTES = 100_000;
const PAYLOAD_KIND = "yonalist-outline-clipboard";
const PAYLOAD_VERSION = 1;

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
  /** Which session wrote it, so a paste can weigh how stale it is. */
  readonly sessionId: string;
  readonly nodes: readonly OutlineClipboardNode[];
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
    siblings.sort((left, right) =>
      left.sortKey - right.sortKey || left.id.localeCompare(right.id));
  }
  return children;
}

/**
 * The selected subtrees as a tree, or `null` when the selection is outside the
 * bounds a paste accepts. Both written formats render from this one walk, so
 * the text and the payload can never disagree about the shape.
 */
export function buildOutlineClipboardPayload(
  nodes: readonly NoteView[],
  drafts: Readonly<Record<string, string>>,
  noteDrafts: Readonly<Record<string, string>>,
  selectedIds: readonly string[],
  sessionId: string
): OutlineClipboardPayload | null {
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
    sessionId,
    nodes: built
  };
}

function plainLines(
  nodes: readonly OutlineClipboardNode[],
  depth: number,
  lines: string[]
): void {
  for (const node of nodes) {
    const indent = "  ".repeat(depth);
    // Only a to-do row gets a box: a completed plain bullet stays a bullet, the
    // rule the PDF export already prints by.
    const box = node.marker === "todo"
      ? node.completed ? " [x]" : " [ ]"
      : "";
    const marker = `${indent}-${box}`;
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
    const box = node.marker === "todo"
      ? node.completed ? "[x] " : "[ ] "
      : "";
    // A rich-text app prefers text/html and never reads the payload comment, so
    // a note left out here is a note that app never sees.
    const note = node.note.length > 0
      ? `<blockquote>${escapeHtml(node.note).replace(/\n/gu, "<br>")}</blockquote>`
      : "";
    const children = node.children.length > 0 ? htmlList(node.children) : "";
    return `<li>${box}${escapeHtml(node.text)}${note}${children}</li>`;
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
      typeof parsed.sessionId !== "string" ||
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
      sessionId: parsed.sessionId,
      nodes
    };
  } catch {
    return null;
  }
}

function serializeOutlinePayload(payload: OutlineClipboardPayload): string {
  const lines: string[] = [];
  plainLines(payload.nodes, 0, lines);
  return lines.join("\n");
}

export function buildOutlineClipboardFormats(
  nodes: readonly NoteView[],
  drafts: Readonly<Record<string, string>>,
  noteDrafts: Readonly<Record<string, string>>,
  selectedIds: readonly string[],
  sessionId: string
): OutlineClipboardFormats | null {
  const payload = buildOutlineClipboardPayload(
    nodes,
    drafts,
    noteDrafts,
    selectedIds,
    sessionId
  );
  if (!payload) return null;
  return {
    plain: serializeOutlinePayload(payload),
    html: `${payloadComment(payload)}${htmlList(payload.nodes)}`,
    payload
  };
}

const CUT_REFUSED_EMPTY = "Select at least one row to cut.";

/**
 * The other two reasons a Cut is turned down. They live beside the refusal
 * above because every surface that cuts -- the pane, the selection hook, the
 * row menu -- has to answer with the same words.
 */
export const CUT_OVER_CLIPBOARD_BOUNDS =
  "Cut is unavailable because these rows are too large for the clipboard.";
export const SELECTION_INCOMPLETE =
  "The complete selection is not available yet.";

/**
 * Why the selected subtrees cannot be cut, or `null` when the copy-then-delete
 * round trip is lossless. The payload carries the note, the marker, the tick
 * and the image hash now, so the losses this used to refuse over are no longer
 * losses -- an empty selection is all there is left to turn down. The pane's
 * own gate on an incomplete forest is a separate one and lives with the
 * selection.
 */
export function outlineCutRefusal(
  nodes: readonly NoteView[],
  selectedIds: readonly string[]
): string | null {
  return normalizeSelectedRoots(nodes, selectedIds).length === 0
    ? CUT_REFUSED_EMPTY
    : null;
}

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
  payloadRequired = false
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
