import {
  Clock3,
  FileText,
  ListTree,
  Plus,
  Search,
  Settings2,
  Star,
  Tags,
  Trash2
} from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState
} from "react";
import type { NoteSearchResult } from "../../domain/notes";
import { IconTooltip, TooltipProvider } from "../../components/ui/Tooltip";
import { NotesDataSettingsDialog } from "./NotesDataSettingsDialog";
import { useNotesWorkspaceContext } from "./NotesWorkspaceContext";
import type { NotesLibraryView } from "./useNotesWorkspace";

const libraryViews = [
  { id: "all", label: "All", icon: ListTree },
  { id: "starred", label: "Starred", icon: Star },
  { id: "recent", label: "Recent", icon: Clock3 },
  { id: "tags", label: "Tags", icon: Tags },
  { id: "trash", label: "Trash", icon: Trash2 }
] as const satisfies ReadonlyArray<{
  id: NotesLibraryView;
  label: string;
  icon: typeof ListTree;
}>;

function pageLabel(title: string): string {
  return title.trim() || "Untitled page";
}

function resultLabel(result: NoteSearchResult): string {
  const title = result.title.trim() || "Untitled note";
  const context =
    result.parentTrail.length > 0
      ? `, in ${result.parentTrail.join(" / ")}`
      : "";
  return `${title}${context}, ${result.matchedField} match`;
}

export function NotesLibraryPane() {
  const { actions, activeTag, deletingNotesData, libraryView, state, tags } =
    useNotesWorkspaceContext();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly NoteSearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [activeResultIndex, setActiveResultIndex] = useState(-1);
  const [dataSettingsOpen, setDataSettingsOpen] = useState(false);
  const searchRequestRef = useRef(0);
  const resultOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const initialLoading = state.status === "loading" && state.rootIds.length === 0;
  const showingTags = libraryView === "tags";
  const choosingTag = showingTags && activeTag === null;

  useEffect(() => {
    const requestId = ++searchRequestRef.current;
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setResults([]);
      setSearchError(null);
      setSearching(false);
      setActiveResultIndex(-1);
      return;
    }
    setResults([]);
    setSearching(true);
    setSearchError(null);
    setActiveResultIndex(-1);
    void actions.searchNotes(trimmedQuery).then(
      (nextResults) => {
        if (searchRequestRef.current !== requestId) {
          return;
        }
        setResults(nextResults);
        setSearching(false);
        setActiveResultIndex(nextResults.length > 0 ? 0 : -1);
      },
      (cause: unknown) => {
        if (searchRequestRef.current !== requestId) {
          return;
        }
        setResults([]);
        setActiveResultIndex(-1);
        setSearchError(
          cause instanceof Error ? cause.message : "Notes search failed."
        );
        setSearching(false);
      }
    );
  }, [actions, query]);

  useEffect(() => {
    if (!deletingNotesData) {
      return;
    }
    searchRequestRef.current += 1;
    resultOptionRefs.current = [];
    setResults([]);
    setActiveResultIndex(-1);
    setSearchError(null);
    setSearching(false);
  }, [deletingNotesData]);

  const handleSearchChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextQuery = event.target.value;
    searchRequestRef.current += 1;
    resultOptionRefs.current = [];
    setQuery(nextQuery);
    setResults([]);
    setActiveResultIndex(-1);
    setSearchError(null);
    setSearching(nextQuery.trim().length > 0);
  };

  const openResult = async (nodeId: string) => {
    await actions.openSearchResult(nodeId);
    searchRequestRef.current += 1;
    resultOptionRefs.current = [];
    setQuery("");
    setResults([]);
    setActiveResultIndex(-1);
  };

  const focusResult = (index: number) => {
    if (results.length === 0) {
      return;
    }
    const nextIndex = (index + results.length) % results.length;
    setActiveResultIndex(nextIndex);
    resultOptionRefs.current[nextIndex]?.focus();
  };

  const handleResultKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusResult(index + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        focusResult(index - 1);
        return;
      case "Home":
        event.preventDefault();
        focusResult(0);
        return;
      case "End":
        event.preventDefault();
        focusResult(results.length - 1);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        void openResult(results[index].nodeId);
    }
  };

  return (
    <section
      className="list-pane notes-library-pane"
      aria-label="Notes library"
      aria-busy={state.status === "loading" || deletingNotesData}
    >
      <TooltipProvider>
        <div className="pane-titlebar-spacer" />
        <header className="notes-library-header">
          <h2>Notes</h2>
          <div className="notes-library-header-actions">
            {libraryView !== "trash" && (
              <button
                className="text-button notes-new-page"
                type="button"
                disabled={state.status === "loading" || deletingNotesData}
                onClick={() => void actions.createRoot()}
              >
                <Plus size={16} aria-hidden="true" />
                <span>New page</span>
              </button>
            )}
            <IconTooltip label="Notes data settings" side="bottom">
              <button
                className="notes-library-icon-button"
                type="button"
                aria-label="Notes data settings"
                disabled={deletingNotesData}
                onClick={() => setDataSettingsOpen(true)}
              >
                <Settings2 size={16} aria-hidden="true" />
              </button>
            </IconTooltip>
          </div>
        </header>

        <div className="notes-library-discovery">
          <label className="notes-search-field">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search notes"
              placeholder="Search notes"
              value={query}
              disabled={deletingNotesData}
              onChange={handleSearchChange}
            />
          </label>

          <div className="notes-library-views" role="group" aria-label="Notes library views">
            {libraryViews.map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={libraryView === id}
                disabled={deletingNotesData}
                onClick={() => void actions.selectLibraryView(id)}
              >
                <Icon size={14} aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </div>

          {query.trim() && (
            <div className="notes-search-results" aria-busy={searching}>
              {searchError && (
                <p className="notes-inline-error" role="alert">
                  {searchError}
                </p>
              )}
              {!searchError && !searching && results.length === 0 && (
                <p className="notes-pane-state">No matches.</p>
              )}
              {results.length > 0 && (
                <div role="listbox" aria-label="Search results">
                  {results.map((result, index) => (
                    <button
                      className="notes-search-result"
                      key={result.nodeId}
                      ref={(element) => {
                        resultOptionRefs.current[index] = element;
                      }}
                      type="button"
                      role="option"
                      aria-selected={activeResultIndex === index}
                      aria-label={resultLabel(result)}
                      disabled={deletingNotesData}
                      tabIndex={activeResultIndex === index ? 0 : -1}
                      onFocus={() => setActiveResultIndex(index)}
                      onKeyDown={(event) => handleResultKeyDown(event, index)}
                      onClick={() => void openResult(result.nodeId)}
                    >
                      <strong>{pageLabel(result.title)}</strong>
                      <span>
                        {result.parentTrail.join(" / ") || "Top level"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {showingTags && (
            <div className="notes-tag-list" aria-label="Note tags">
              {tags.length === 0 ? (
                <p className="notes-pane-state">No tags yet.</p>
              ) : (
                tags.map((tag) => (
                  <button
                    type="button"
                    key={tag}
                    aria-pressed={activeTag === tag}
                    disabled={deletingNotesData}
                    onClick={() => void actions.selectTag(tag)}
                  >
                    <Tags size={14} aria-hidden="true" />
                    <span>{tag}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {!choosingTag && (
          <div className="notes-library-list">
            {initialLoading && <p className="notes-pane-state">Loading notes...</p>}
            {state.status === "error" && (
              <p className="notes-pane-state notes-pane-error">{state.error}</p>
            )}
            {!initialLoading &&
              state.status !== "error" &&
              state.rootIds.length === 0 && (
                <p className="notes-pane-state">
                  {libraryView === "trash" ? "Trash is empty." : "No pages yet."}
                </p>
              )}
            {state.rootIds.map((nodeId) => {
              const node = state.nodesById[nodeId];
              if (!node) {
                return null;
              }
              const label = pageLabel(node.title);
              return (
                <button
                  className="notes-library-page"
                  data-active={state.zoomRootId === nodeId ? "true" : undefined}
                  type="button"
                  key={nodeId}
                  aria-label={label}
                  aria-current={state.zoomRootId === nodeId ? "page" : undefined}
                  disabled={deletingNotesData}
                  onClick={() => void actions.zoomTo(nodeId)}
                >
                  <FileText size={16} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        )}

        <NotesDataSettingsDialog
          open={dataSettingsOpen}
          onOpenChange={setDataSettingsOpen}
        />
      </TooltipProvider>
    </section>
  );
}
