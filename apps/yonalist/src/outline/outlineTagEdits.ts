import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import { parseOutlinePresentation } from "./outlinePresentation";

/**
 * A tag is not an entity here. It is an inline `#tag` / `@person` token inside
 * a node's title or note, and `notes_tags` is rebuilt from that text on every
 * write, so editing tags is editing text — no schema, no command of its own.
 *
 * Everything below therefore runs through the one tokenizer the renderer and
 * the SQLite derivation already agree on. A second parser would drift, and a
 * tag it invented would be one the search index silently never indexes.
 */
export interface OutlineTag {
  readonly prefix: "#" | "@";
  /** NFC + lowercased body without the prefix, straight off the tokenizer. */
  readonly normalized: string;
  /** The spelling to write: as typed, or as the workspace already spells it. */
  readonly raw: string;
}

export interface OutlineTagEdit {
  readonly id: string;
  readonly text?: string;
  readonly note?: string;
}

export const OUTLINE_TAG_PARSE_ERROR =
  "Enter exactly one tag beginning with # or @.";
export const OUTLINE_TAG_PICK_ERROR =
  "Choose one of the tags already on these rows.";

/**
 * The rows one tag operation may cover. `MAX_HISTORY_MUTATIONS_PER_ENTRY` in
 * `crates/notes-application/src/service.rs` is 256, one command produces one
 * mutation per touched node, and a removal can touch a row twice (title and
 * note). 128 rows is therefore the largest batch that cannot silently split
 * into more than one undo entry.
 */
export const OUTLINE_TAG_MAX_ROWS = 128;

/** `#ada` and `@ada` are two tags: `normalized` alone drops the prefix. */
export function outlineTagKey(tag: OutlineTag): string {
  return tag.prefix + tag.normalized;
}

/**
 * `markdown: false` on purpose. The Rust derivation scans the raw string, so a
 * leading `# ` heading marker must not shift or swallow a token here that the
 * index would still find.
 */
function tagTokens(text: string): readonly {
  readonly prefix: "#" | "@";
  readonly normalized: string;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}[] {
  return parseOutlinePresentation(text, { markdown: false }).tokens
    .filter((token) => token.kind === "tag");
}

function hasTag(text: string, tag: OutlineTag): boolean {
  const key = outlineTagKey(tag);
  return tagTokens(text).some((token) => outlineTagKey(token) === key);
}

/** Appends the tag, or writes it bare when there is nothing to append to. */
export function addTag(text: string, tag: OutlineTag): string {
  if (hasTag(text, tag)) return text;
  const base = text.trimEnd();
  return base.length === 0 ? tag.raw : `${base} ${tag.raw}`;
}

/**
 * Strips every occurrence of the tag together with one adjacent space —
 * the one before it when there is one, otherwise the one after — so
 * `buy milk #shop today` loses neither a word nor a second space.
 */
export function removeTag(text: string, tag: OutlineTag): string {
  const key = outlineTagKey(tag);
  const matches = tagTokens(text)
    .filter((token) => outlineTagKey(token) === key);
  let result = text;
  // Backwards: every earlier token keeps the offsets it was found at.
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    let { start, end } = matches[index];
    if (start > 0 && result[start - 1] === " ") start -= 1;
    else if (result[end] === " ") end += 1;
    result = result.slice(0, start) + result.slice(end);
  }
  return result;
}

/** Every tag carried by the given rows, in first-seen order. */
export function tagsIn(nodes: readonly NoteView[]): readonly OutlineTag[] {
  const found = new Map<string, OutlineTag>();
  for (const node of nodes) {
    if (node.kind === "image") continue;
    for (const source of [node.text, node.note]) {
      for (const token of tagTokens(source)) {
        const key = outlineTagKey(token);
        if (!found.has(key)) {
          found.set(key, {
            prefix: token.prefix,
            normalized: token.normalized,
            raw: token.raw
          });
        }
      }
    }
  }
  return [...found.values()];
}

/** Free text the chooser will accept: exactly one tag and nothing else. */
export function parseSingleTag(input: string): OutlineTag | null {
  const trimmed = input.trim();
  const tokens = tagTokens(trimmed);
  const token = tokens[0];
  if (tokens.length !== 1 || token.start !== 0 || token.end !== trimmed.length) {
    return null;
  }
  return {
    prefix: token.prefix,
    normalized: token.normalized,
    raw: token.raw
  };
}

/**
 * The text rewrites one tag operation needs, drafts included so the edit lands
 * on what the reader can actually see rather than on the last saved value.
 *
 * Image nodes are skipped in both directions: their title is their filename
 * and `notes-core` refuses to change it, which fails the whole batch.
 */
export function planTagEdits(
  nodes: readonly NoteView[],
  drafts: Readonly<Record<string, string>>,
  noteDrafts: Readonly<Record<string, string>>,
  ids: readonly string[],
  tag: OutlineTag,
  mode: "add" | "remove"
): readonly OutlineTagEdit[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edits: OutlineTagEdit[] = [];
  for (const id of ids) {
    const node = byId.get(id);
    if (!node || node.kind === "image") continue;
    const text = drafts[id] ?? node.text;
    const note = noteDrafts[id] ?? node.note;
    if (mode === "add") {
      if (hasTag(text, tag) || hasTag(note, tag)) continue;
      const next = addTag(text, tag);
      if (next !== text) edits.push({ id, text: next });
      continue;
    }
    const nextText = removeTag(text, tag);
    const nextNote = removeTag(note, tag);
    if (nextText === text && nextNote === note) continue;
    edits.push({
      id,
      ...(nextText === text ? {} : { text: nextText }),
      ...(nextNote === note ? {} : { note: nextNote })
    });
  }
  return edits;
}
