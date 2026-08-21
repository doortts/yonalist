import { useEffect, useState, useSyncExternalStore } from "react";
import type { SearchHit } from "../../../packages/contracts/generated/SearchHit";
import type { NotesStore } from "./notesStore";

/**
 * The rows elsewhere that name this day. Nothing new is indexed for this: a
 * date in any row already lands in `notes_dates`, and `date:` already asks for
 * it. What the day adds is the one exclusion -- its own rows name it by being
 * on it, and a page is not a reference to itself.
 */
export function JournalReferences({
  store,
  pageId,
  date,
  onOpenPage
}: {
  readonly store: NotesStore;
  readonly pageId: string;
  readonly date: string;
  readonly onOpenPage: (pageId: string) => void;
}) {
  const shell = useSyncExternalStore(
    store.subscribeShell,
    store.getShellSnapshot,
    store.getShellSnapshot
  );
  const [hits, setHits] = useState<readonly SearchHit[]>([]);
  // Re-read on every revision: a row written on another page while this day is
  // open is exactly the row this list exists to show.
  const revision = shell.revision;
  useEffect(() => {
    let active = true;
    void store.search(`date:${date}`).then(
      (page) => {
        if (active) setHits(page.hits);
      },
      () => {
        // A search that failed says nothing about the day, so the section says
        // nothing either rather than claiming there are none.
        if (active) setHits([]);
      }
    );
    return () => {
      active = false;
    };
  }, [date, revision, store]);

  const elsewhere = hits.filter((hit) => hit.pageId !== pageId);
  return (
    <section className="notes-journal-references" aria-label="Linked references">
      <h3 className="notes-journal-references-heading">
        <span>Linked references</span>
        <span className="notes-journal-references-count">
          {elsewhere.length}
        </span>
      </h3>
      {elsewhere.length === 0
        ? (
          <p className="notes-journal-references-empty">
            No other row names this day yet.
          </p>
        )
        : elsewhere.map((hit) => (
          <button
            className="notes-journal-reference"
            type="button"
            key={hit.node.id}
            onClick={() => onOpenPage(hit.pageId)}
          >
            <span className="notes-journal-reference-source">
              {shell.pages.find((page) => page.id === hit.pageId)?.title ||
                "Untitled page"}
            </span>
            <span className="notes-journal-reference-text">
              {hit.node.text}
            </span>
          </button>
        ))}
    </section>
  );
}
