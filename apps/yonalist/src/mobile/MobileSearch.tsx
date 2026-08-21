import { useState } from "react";
import { SearchPanel } from "../SearchPanel";
import type { NotesStore } from "../notesStore";
import { MobileIcon } from "./MobileIcon";

/**
 * The search box and its hits.
 *
 * `SearchPanel` is the desktop's and does the asking, the debouncing and the
 * grouping; what the phone adds is the field to type in, which on the desktop
 * lives in the sidebar. The query syntax is therefore the same one — `date:`,
 * ranges, tags — because it is the same search.
 */
export function MobileSearch({
  store,
  onOpenPage
}: {
  readonly store: NotesStore;
  readonly onOpenPage: (pageId: string) => void;
}) {
  const [query, setQuery] = useState("");

  return (
    <>
      <div className="mobile-search-box">
        <MobileIcon name="search" size={18} />
        <input
          className="mobile-search-field"
          type="search"
          value={query}
          aria-label="Search"
          placeholder="Search notes"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <SearchPanel query={query} store={store} onOpen={onOpenPage} />
    </>
  );
}
