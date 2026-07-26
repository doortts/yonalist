import { Dialog } from "@base-ui/react/dialog";
import { Search } from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState
} from "react";
import type { NoteId, NoteNode, NoteSearchResult } from "../../domain/notes";
import "../../components/ui/dialog.css";
import { noteSearchPresentation } from "./notesPresentation";

export interface NotesQuickJumpProps {
  /** Whether the palette is currently open. */
  open: boolean;
  /** Called when the dialog requests to open/close (Esc, backdrop, selection). */
  onOpenChange(open: boolean): void;
  /** Reuses the workspace's existing FTS search action. */
  onSearch(query: string): Promise<readonly NoteSearchResult[]>;
  /** Reuses the workspace's existing zoom action to jump to a node. */
  onJump(nodeId: NoteId): void | Promise<void>;
  /** Loaded nodes preserve text labels while kind-aware search metadata lands. */
  nodesById?: Readonly<Record<NoteId, NoteNode>>;
  /** Debounce delay before firing a search, in ms. Defaults to 120ms. */
  debounceMs?: number;
}

function resultAriaLabel(
  presentation: ReturnType<typeof noteSearchPresentation>
): string {
  return presentation.parentTrail.length > 0
    ? `${presentation.title}, in ${presentation.parentTrail.join(" / ")}`
    : presentation.title;
}

/**
 * Cmd/Ctrl+K quick-jump palette. Reuses the Notes workspace's existing search
 * (`onSearch`, backed by `actions.searchNotes`) and zoom (`onJump`, backed by
 * `actions.zoomTo`) actions rather than adding a new backend command. Built on
 * Base UI's Dialog, matching the modal look used by `NotesDataSettingsDialog`
 * and `ConfirmDialog` (`.modal-backdrop` / `.modal`), which gives focus
 * trapping and focus restoration to the previously focused element for free.
 */
export function NotesQuickJump({
  open,
  onOpenChange,
  onSearch,
  onJump,
  nodesById,
  debounceMs = 120
}: NotesQuickJumpProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly NoteSearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listboxId = useId();

  // Reset transient state whenever the palette opens (or closes) so a stale
  // query/result set from the previous visit never flashes.
  useEffect(() => {
    requestRef.current += 1;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setQuery("");
    setResults([]);
    setActiveIndex(-1);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const trimmed = query.trim();
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (!trimmed) {
      requestRef.current += 1;
      setResults([]);
      setActiveIndex(-1);
      setError(null);
      return;
    }
    const requestId = ++requestRef.current;
    debounceTimerRef.current = setTimeout(() => {
      void onSearch(trimmed).then(
        (nextResults) => {
          if (requestRef.current !== requestId) {
            return;
          }
          setResults(nextResults);
          setActiveIndex(nextResults.length > 0 ? 0 : -1);
          setError(null);
        },
        (cause: unknown) => {
          if (requestRef.current !== requestId) {
            return;
          }
          setResults([]);
          setActiveIndex(-1);
          setError(
            cause instanceof Error ? cause.message : "Notes search failed."
          );
        }
      );
    }, debounceMs);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
    // onSearch is intentionally omitted: it's a stable action from
    // useNotesActions(), and including it would re-run on every render,
    // defeating the debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, debounceMs]);

  const commit = (nodeId: NoteId) => {
    onOpenChange(false);
    void onJump(nodeId);
  };

  const handleQueryChange = (event: ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.key === "Process") {
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (results.length === 0) return;
        setActiveIndex((current) => (current + 1) % results.length);
        return;
      case "ArrowUp":
        event.preventDefault();
        if (results.length === 0) return;
        setActiveIndex((current) =>
          current <= 0 ? results.length - 1 : current - 1
        );
        return;
      case "Enter": {
        event.preventDefault();
        const selected = results[activeIndex];
        if (selected) {
          commit(selected.nodeId);
        }
        return;
      }
      case "Escape":
        // Base UI's Dialog already closes on Escape; avoid double-handling
        // so onOpenChange isn't invoked twice.
        return;
      default:
        return;
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Popup
          className="modal notes-quick-jump"
          aria-label="Jump to Yonalist page"
        >
          <Dialog.Title className="notes-quick-jump-visually-hidden">
            Jump to Yonalist page
          </Dialog.Title>
          <Dialog.Description className="notes-quick-jump-visually-hidden">
            Search Yonalist pages by title and press Enter to jump to one.
          </Dialog.Description>
          <label className="notes-quick-jump-field">
            <Search size={15} aria-hidden="true" />
            <input
              type="text"
              role="combobox"
              aria-expanded={results.length > 0}
              aria-controls={listboxId}
              aria-activedescendant={
                activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined
              }
              aria-autocomplete="list"
              aria-label="Jump to Yonalist page"
              placeholder="Jump to a Yonalist page..."
              value={query}
              onChange={handleQueryChange}
              onKeyDown={handleKeyDown}
            />
          </label>
          <div
            id={listboxId}
            className="notes-quick-jump-results"
            role="listbox"
            aria-label="Matching notes"
          >
            {results.map((result, index) => {
              const presentation = noteSearchPresentation(result, nodesById);
              return (
                <button
                  id={`${listboxId}-${index}`}
                  key={result.nodeId}
                  type="button"
                  role="option"
                  aria-selected={activeIndex === index}
                  aria-label={resultAriaLabel(presentation)}
                  className="notes-quick-jump-result"
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => commit(result.nodeId)}
                >
                  <span className="notes-quick-jump-result-title">
                    {presentation.title}
                  </span>
                  {presentation.parentTrail.length > 0 && (
                    <span className="notes-quick-jump-result-trail">
                      {presentation.parentTrail.join(" / ")}
                    </span>
                  )}
                </button>
              );
            })}
            {query.trim().length > 0 && results.length === 0 && !error && (
              <p className="notes-quick-jump-empty">No matching notes</p>
            )}
            {error && (
              <p className="notes-quick-jump-empty" role="alert">
                {error}
              </p>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
