import type { NotesStore } from "./notesStore";
import { journalDateOf } from "./journal";
import { useNotesNode } from "./useNotesNode";

/**
 * The day an open page is, or `null` if it is an ordinary page. Read off the
 * page's own node rather than the page list, so a day nobody has written in yet
 * -- which has no row in that list -- still knows what day it is.
 *
 * One reader owns this per pane and hands the answer to the parts that need it,
 * since it decides three things at once: the bar above the rows, the references
 * under them, and whether the pane is a stack at all.
 */
export function useJournalDate(
  store: NotesStore,
  pageId: string | undefined
): string | null {
  // The hook has to run whether or not there is a page, so a pane with none
  // subscribes to an id no node answers to and reads an empty title back.
  const title = useNotesNode(store, pageId ?? "").title;
  return pageId ? journalDateOf(title) : null;
}
