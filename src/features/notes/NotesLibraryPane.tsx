import {
  Archive,
  Clock3,
  ListTree,
  Plus,
  Search,
  Settings2,
  Star,
  Tags,
  Trash2,
  X
} from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState
} from "react";
import type { NoteSearchResult } from "../../domain/notes";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { IconTooltip, TooltipProvider } from "../../components/ui/Tooltip";
import { NotesDataSettingsDialog } from "./NotesDataSettingsDialog";
import {
  NotesExportControllerProvider,
  useNotesExportController
} from "./NotesExportController";
import { NotesLibraryPageRow } from "./NotesLibraryPageRow";
import {
  noteNodePresentationLabel,
  noteSearchPresentation
} from "./notesPresentation";
import {
  useNotesActions,
  useNotesDrafts,
  useNotesState
} from "./NotesWorkspaceContext";
import type { NotesLibraryView } from "./useNotesWorkspace";

const libraryViews = [
  { id: "all", label: "All", icon: ListTree },
  { id: "starred", label: "Starred", icon: Star },
  { id: "recent", label: "Recent", icon: Clock3 },
  { id: "tags", label: "Tags", icon: Tags },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "trash", label: "Trash", icon: Trash2 }
] as const satisfies ReadonlyArray<{
  id: NotesLibraryView;
  label: string;
  icon: typeof ListTree;
}>;

function resultLabel(
  result: NoteSearchResult,
  presentation: ReturnType<typeof noteSearchPresentation>
): string {
  const { title, parentTrail } = presentation;
  const context =
    parentTrail.length > 0 ? `, in ${parentTrail.join(" / ")}` : "";
  return `${title}${context}, ${result.matchedField} match`;
}

function NotesLibraryPaneContent() {
  const { actions } = useNotesActions();
  const {
    activeTagFilters,
    deletingNotesData,
    libraryView,
    state,
    tagSummaries
  } = useNotesState();
  const { draftsByNodeId } = useNotesDrafts();
  const exportController = useNotesExportController();
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
  const choosingTag = showingTags && activeTagFilters.length === 0;
  const isTagActive = (prefix: "#" | "@", normalizedTag: string) =>
    activeTagFilters.some(
      (filter) =>
        filter.prefix === prefix && filter.normalizedTag === normalizedTag
    );
  const summaryForFilter = (prefix: "#" | "@", normalizedTag: string) =>
    tagSummaries.find(
      (summary) =>
        summary.prefix === prefix && summary.normalizedTag === normalizedTag
    );

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
          {libraryView !== "trash" && libraryView !== "archive" && (
            <button
              className="primary-button notes-new-page"
              type="button"
              disabled={state.status === "loading" || deletingNotesData}
              onClick={() => void actions.createRoot()}
            >
              <Plus size={16} aria-hidden="true" />
              <span>New page</span>
            </button>
          )}

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

          {activeTagFilters.length > 0 && (
            <div
              className="notes-tag-filter-chips"
              role="list"
              aria-label="Active tag filters"
            >
              {activeTagFilters.map((filter) => {
                const summary = summaryForFilter(
                  filter.prefix,
                  filter.normalizedTag
                );
                const displayTag = summary?.displayTag ?? filter.normalizedTag;
                const label = `${filter.prefix}${displayTag}`;
                return (
                  <span
                    className="notes-tag-filter-chip"
                    role="listitem"
                    data-prefix={filter.prefix}
                    key={`${filter.prefix}:${filter.normalizedTag}`}
                  >
                    <span>{label}</span>
                    <span className="notes-tag-count" aria-hidden="true">
                      {summary?.count ?? 0}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${label} filter`}
                      disabled={deletingNotesData}
                      onClick={() => void actions.toggleTagFilter(filter)}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}

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
                  {results.map((result, index) => {
                    const presentation = noteSearchPresentation(
                      result,
                      state.nodesById
                    );
                    const titleLabel = presentation.title;
                    const parentTrail = presentation.parentTrail;
                    return (
                      <button
                        className="notes-search-result"
                        key={result.nodeId}
                        ref={(element) => {
                          resultOptionRefs.current[index] = element;
                        }}
                        type="button"
                        role="option"
                        aria-selected={activeResultIndex === index}
                        aria-label={resultLabel(result, presentation)}
                        disabled={deletingNotesData}
                        tabIndex={activeResultIndex === index ? 0 : -1}
                        onFocus={() => setActiveResultIndex(index)}
                        onKeyDown={(event) => handleResultKeyDown(event, index)}
                        onClick={() => void openResult(result.nodeId)}
                      >
                        <strong>{titleLabel}</strong>
                        <span>
                          {parentTrail.join(" / ") || "Top level"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {showingTags && (
            <div className="notes-tag-list" aria-label="Note tags">
              {tagSummaries.length === 0 ? (
                <p className="notes-pane-state">No tags yet.</p>
              ) : (
                tagSummaries.map((summary) => {
                  const label = `${summary.prefix}${summary.displayTag}`;
                  const countLabel = `${summary.count} ${summary.count === 1 ? "note" : "notes"}`;
                  return (
                    <button
                      type="button"
                      key={`${summary.prefix}:${summary.normalizedTag}`}
                      aria-label={`${label}, ${countLabel}`}
                      aria-pressed={isTagActive(
                        summary.prefix,
                        summary.normalizedTag
                      )}
                      disabled={deletingNotesData}
                      onClick={() => void actions.toggleTagFilter(summary)}
                    >
                      <span className="notes-tag-label">{label}</span>
                      <span className="notes-tag-count">{summary.count}</span>
                    </button>
                  );
                })
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
                  {libraryView === "trash"
                    ? "Trash is empty."
                    : libraryView === "archive"
                      ? "Archive is empty."
                      : "No pages yet."}
                </p>
              )}
            {state.rootIds.map((nodeId) => {
              const node = state.nodesById[nodeId];
              if (!node) {
                return null;
              }
              const draft = draftsByNodeId[nodeId];
              const displayTitle = draft?.title ?? node.title;
              const visibleNote = draft?.note ?? node.note;
              const label = noteNodePresentationLabel(
                node,
                displayTitle,
                "Untitled page"
              );
              return (
                <NotesLibraryPageRow
                  key={nodeId}
                  node={node}
                  displayTitle={displayTitle}
                  mode={
                    libraryView === "archive"
                      ? "archive"
                      : libraryView === "trash"
                        ? "trash"
                        : "active"
                  }
                  active={state.zoomRootId === nodeId}
                  disabled={deletingNotesData || state.status === "loading"}
                  onOpen={() => void actions.zoomTo(nodeId)}
                  onToggleStar={() => void actions.toggleStar(nodeId)}
                  onArchive={() => void actions.archiveNode(nodeId)}
                  onUnarchive={() => void actions.unarchiveNode(nodeId)}
                  onRestore={() => void actions.restoreNode(nodeId)}
                  onMoveToTrash={() => void actions.deleteNode(nodeId)}
                  onDuplicate={() => void actions.duplicateNode(nodeId)}
                  onExport={(format) =>
                    exportController.startExport(nodeId, label, format)
                  }
                  onRename={async (title) => {
                    if (libraryView === "archive" || libraryView === "trash") {
                      return false;
                    }
                    actions.updateNodeDraft(
                      nodeId,
                      { title, note: visibleNote },
                      "title"
                    );
                    return actions.flushNodeDraft(nodeId);
                  }}
                />
              );
            })}
          </div>
        )}

        {exportController.busy && (
          <span className="notes-library-export-feedback" role="status">
            Exporting...
          </span>
        )}
        {!exportController.busy && exportController.feedback && (
          <span
            className="notes-library-export-feedback"
            role={exportController.feedback.kind === "error" ? "alert" : "status"}
          >
            {exportController.feedback.message}
          </span>
        )}

        <ConfirmDialog
          open={exportController.pendingOverwrite !== null}
          onOpenChange={(open) => {
            if (!open) {
              exportController.clearPendingOverwrite();
            }
          }}
          title="Replace existing export?"
          description={
            <>
              Replace the existing export at{" "}
              <code className="notes-export-destination">
                {exportController.pendingOverwrite?.request.destination}
              </code>
              ?
            </>
          }
          confirmLabel="Replace"
          cancelLabel="Cancel"
          popupClassName="notes-export-confirm-dialog"
          onConfirm={exportController.replaceExistingExport}
        />

        <NotesDataSettingsDialog
          open={dataSettingsOpen}
          onOpenChange={setDataSettingsOpen}
        />
      </TooltipProvider>
    </section>
  );
}

export function NotesLibraryPane() {
  const { actions } = useNotesActions();
  const { deletingNotesData, libraryView, state } = useNotesState();
  const lifecycleReadOnly = libraryView === "archive" || libraryView === "trash";

  return (
    <NotesExportControllerProvider
      available={!lifecycleReadOnly && state.rootIds.length > 0}
      disabled={deletingNotesData || lifecycleReadOnly}
      loading={state.status === "loading"}
      onFlushDrafts={actions.flushAllDrafts}
    >
      <NotesLibraryPaneContent />
    </NotesExportControllerProvider>
  );
}
