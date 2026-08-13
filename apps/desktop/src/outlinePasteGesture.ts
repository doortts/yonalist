import type { ClipboardEvent } from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesStore } from "./notesStore";
import { focusAfterCommit } from "./outlineFocus";
import {
  extractOutlinePayload, parsePastedOutline, pastedOutlineFromPayload
} from "./outlinePaste";
import { clipboardImageCandidates } from "./imageClipboard";
import { freshId, messageFrom } from "./storeSupport";
import { bySiblingOrder } from "./outlineSortKeys";

// The one import failure worth naming: both backends answer with this phrase
// when the hash on the clipboard outlived the bytes it points at.
const STALE_IMAGE = /image store/iu;
const PASTE_REFUSED_IMAGE =
  "Could not paste: that image is no longer available.";
const PASTE_REFUSED = "Could not paste the copied outline.";

/**
 * The row a paste on this one has to land before: its own next sibling, or
 * `null` at the end of the run. Both paste branches anchor off this, so the
 * bytes and the outline land in the same place.
 */
export function nextSiblingId(store: NotesStore, node: NoteView): string | null {
  const siblings = store.getSnapshot().nodes
    .filter((candidate) =>
      candidate.parentId === node.parentId && !candidate.deleted)
    .sort(bySiblingOrder);
  const position = siblings.findIndex((candidate) => candidate.id === node.id);
  return position >= 0 ? siblings[position + 1]?.id ?? null : null;
}

/**
 * A bullet with nothing in it -- the row Enter just made, which is where a
 * paste is nearly always aimed. That row is replaced rather than pasted beside,
 * so the outline does not keep the blank line the paste was typed into. A note,
 * a box, a picture or a child all mean the row is carrying something, and a row
 * carrying something stays.
 */
export function isEmptyBullet(store: NotesStore, node: NoteView): boolean {
  const state = store.getSnapshot();
  return node.kind === "bullet" &&
    node.marker === "bullet" &&
    (state.drafts[node.id] ?? node.text).trim().length === 0 &&
    (state.noteDrafts[node.id] ?? node.note).length === 0 &&
    !state.nodes.some((candidate) =>
      candidate.parentId === node.id && !candidate.deleted);
}

export function handleMultilinePaste(
  event: ClipboardEvent<HTMLElement>,
  store: NotesStore,
  node: NoteView,
  onRefused?: (message: string) => void
) {
  // Our own copy outranks everything, the image files included: a copied
  // picture rides the clipboard twice -- as its bytes and inside the payload --
  // and importing the bytes would land a fresh lone row with the children, the
  // note and the marker left behind. A screenshot carries no payload of ours,
  // so it still takes the branch below.
  const payload = extractOutlinePayload(
    event.clipboardData.getData("text/html")
  );
  const images = payload
    ? []
    : clipboardImageCandidates(event.clipboardData);
  if (images.length > 0 && node.parentId) {
    event.preventDefault();
    const scope = event.currentTarget.closest<HTMLElement>(".notes-outline");
    void store.images
      .importAfter(node.parentId, nextSiblingId(store, node), images)
      .then((id) => {
        if (scope) focusAfterCommit(scope, id, "start");
      });
    return;
  }
  // The payload in the HTML carries the marker, the tick, the note and the
  // image that the plain text has to leave behind. Anything else -- another
  // app's markup, a payload this build cannot read -- falls through to the
  // text, which is where an outside outline comes in.
  const roots = payload
    ? pastedOutlineFromPayload(payload)
    : parsePastedOutline(event.clipboardData.getData("text/plain"));
  if (!roots) return;
  // Before the import leaves: WebKit disowns a gesture that waits on anything.
  event.preventDefault();
  const scope = event.currentTarget.closest<HTMLElement>(".notes-outline");
  // Beside the caret row, not beneath it -- Workflowy's placement, and the hand
  // the users arrive with. A row with no parent of its own is a page, and a
  // page has no siblings, so a paste on one stays a child of it.
  const landing = node.parentId
    ? { parentId: node.parentId, beforeId: nextSiblingId(store, node) }
    : { parentId: node.id, beforeId: null };
  const replaced = node.parentId && isEmptyBullet(store, node) ? node.id : null;
  // One gesture, one undo step: the removal carries the import's own history
  // group, which is what folds the two commands into a single entry. A paste
  // past the coalescer's own 256-mutation bound is the one that still takes
  // two, and two steps there beat one entry too large to hold. The browser
  // preview backend coalesces nothing -- every command is its own entry there,
  // so the same gesture takes two undos in `npm run dev`.
  const historyGroup = replaced ? `paste:${freshId()}` : null;
  void store.importOutline(
    landing.parentId,
    landing.beforeId,
    roots,
    historyGroup
  ).then(
    (id) => {
      // After the import, never before it: a refused paste leaves the row the
      // caret is standing in exactly where it was.
      if (replaced) {
        void store.beginRemoveEmptyNode(replaced, historyGroup)
          .committed.catch(() => undefined);
      }
      if (scope) focusAfterCommit(scope, id, "start");
    },
    // A refused import lands nothing at all, and a half paste behind a quiet
    // fallback would be worse than saying so -- including when the bytes are
    // right there on the clipboard: importing them would answer a stale hash
    // with a lone picture stripped of everything the row carried.
    (cause: unknown) => onRefused?.(
      STALE_IMAGE.test(messageFrom(cause)) ? PASTE_REFUSED_IMAGE : PASTE_REFUSED
    )
  );
}
