import { useEffect, useState } from "react";
import type { SearchHit } from "../../../packages/contracts/generated/SearchHit";
import type { NotesStore } from "./notesStore";

export function SearchPanel({
  query,
  store,
  onOpen
}: {
  readonly query: string;
  readonly store: NotesStore;
  readonly onOpen: (pageId: string) => void;
}) {
  const [hits, setHits] = useState<readonly SearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      setError(null);
      void store.search(query).then(
        (page) => active && setHits(page.hits),
        (cause: unknown) => active && setError(
          cause instanceof Error ? cause.message : "Search failed."
        )
      );
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, store]);

  if (error) return <p className="notes-pane-state notes-pane-error">{error}</p>;
  return (
    <div className="notes-search-results" role="listbox" aria-label="Search results">
      {hits.map((hit) => (
        <div key={hit.node.id}>
          <button
            className="notes-search-result"
            type="button"
            role="option"
            aria-selected="false"
            onClick={() => onOpen(hit.pageId)}
          >
            <strong>{hit.node.text || "Untitled"}</strong>
            <span>{hit.snippet}</span>
          </button>
          {query === "is:trash" && (
            <button
              className="text-button"
              type="button"
              onClick={() => {
                void store.restoreSubtree(hit.node.id)
                  .then(() => store.search(query))
                  .then((page) => setHits(page.hits), (cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : "Restore failed.");
                  });
              }}
            >
              Restore
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
