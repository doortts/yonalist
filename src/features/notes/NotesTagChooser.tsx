import { Dialog } from "@base-ui/react/dialog";
import { Search, X } from "lucide-react";
import {
  type KeyboardEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type {
  NoteSearchTag,
  NoteTagFilter,
  NoteTagPrefix
} from "../../domain/notes";
import "../../components/ui/dialog.css";
import { tokenizeNoteText } from "./noteTokens";
import {
  type NotesFrozenSelectionSnapshot,
  useFrozenOpenValue
} from "./notesSelectionChooser";

export type NotesTagChooserMode = "add" | "remove";

export type NotesTagChooserCommit<Ownership = unknown> =
  | Readonly<{
      mode: "add";
      tag: NoteSearchTag;
      snapshot: NotesFrozenSelectionSnapshot<Ownership>;
    }>
  | Readonly<{
      mode: "remove";
      tag: NoteTagFilter;
      snapshot: NotesFrozenSelectionSnapshot<Ownership>;
    }>;

export interface NotesTagChooserProps<Ownership = unknown> {
  readonly open: boolean;
  readonly initialMode?: NotesTagChooserMode;
  readonly snapshot: NotesFrozenSelectionSnapshot<Ownership>;
  readonly suggestions: readonly NoteSearchTag[];
  /** Exact tag union from the rows named by the opening snapshot. */
  readonly selectedTagUnion: readonly NoteSearchTag[];
  readonly loading?: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCommit: (commit: NotesTagChooserCommit<Ownership>) => void;
  readonly onRequestFocusReturn: () => void;
}

const INVALID_TAG_MESSAGE = "Enter exactly one tag beginning with # or @.";

function tagKey(tag: Pick<NoteTagFilter, "prefix" | "normalizedTag">): string {
  return `${tag.prefix}\u0000${tag.normalizedTag}`;
}

function tagLabel(tag: NoteSearchTag): string {
  return `${tag.prefix}${tag.displayTag}`;
}

function uniqueTags(tags: readonly NoteSearchTag[]): readonly NoteSearchTag[] {
  const seen = new Set<string>();
  return tags.filter((tag) => {
    const key = tagKey(tag);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function parseCanonicalTag(source: string): NoteSearchTag | null {
  const trimmed = source.trim();
  const tokens = tokenizeNoteText(trimmed);
  if (
    tokens.length !== 1 ||
    tokens[0]?.kind !== "tag" ||
    tokens[0].startUtf16 !== 0 ||
    tokens[0].endUtf16 !== trimmed.length ||
    tokens[0].raw !== trimmed
  ) {
    return null;
  }
  return {
    prefix: tokens[0].prefix as NoteTagPrefix,
    normalizedTag: tokens[0].normalized,
    displayTag: tokens[0].display
  };
}

export function NotesTagChooser<Ownership>({
  open,
  initialMode = "add",
  snapshot,
  suggestions,
  selectedTagUnion,
  loading = false,
  onOpenChange,
  onCommit,
  onRequestFocusReturn
}: NotesTagChooserProps<Ownership>) {
  const [mode, setMode] = useState<NotesTagChooserMode>(initialMode);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [validationError, setValidationError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const addTabRef = useRef<HTMLButtonElement>(null);
  const removeTabRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const addTabId = useId();
  const removeTabId = useId();
  const panelId = useId();
  const openedSession = useFrozenOpenValue(open, {
    snapshot,
    selectedTagUnion
  });

  const addSuggestions = useMemo(() => uniqueTags(suggestions), [suggestions]);
  // The selected-row union intentionally stays tied to the opening snapshot.
  const removeSuggestions = uniqueTags(openedSession.selectedTagUnion);
  const candidates = mode === "add" ? addSuggestions : removeSuggestions;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredCandidates = candidates.filter((tag) =>
    tagLabel(tag).toLocaleLowerCase().includes(normalizedQuery)
  );
  const candidateIdentity = candidates.map(tagKey).join("\u0001");
  const visibleActiveIndex =
    !loading && activeIndex >= 0 && activeIndex < filteredCandidates.length
      ? activeIndex
      : -1;

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    setMode(initialMode);
    setQuery("");
    setActiveIndex(-1);
    setValidationError(null);
    inputRef.current?.focus();
  }, [initialMode, open]);

  useLayoutEffect(() => {
    setActiveIndex(-1);
  }, [candidateIdentity]);

  const requestOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      onRequestFocusReturn();
    }
  };

  const commitAdd = (tag: NoteSearchTag) => {
    onCommit({
      mode: "add",
      tag,
      snapshot: openedSession.snapshot
    });
    requestOpenChange(false);
  };

  const commitRemove = (tag: NoteSearchTag) => {
    onCommit({
      mode: "remove",
      tag: { prefix: tag.prefix, normalizedTag: tag.normalizedTag },
      snapshot: openedSession.snapshot
    });
    requestOpenChange(false);
  };

  const commitCandidate = (tag: NoteSearchTag) => {
    if (mode === "add") {
      commitAdd(tag);
    } else {
      commitRemove(tag);
    }
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.key === "Process") {
      return;
    }
    if (
      loading &&
      (event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Enter")
    ) {
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (filteredCandidates.length === 0) {
        return;
      }
      setActiveIndex((current) => {
        const normalizedCurrent =
          current >= 0 && current < filteredCandidates.length ? current : -1;
        return event.key === "ArrowDown"
          ? (normalizedCurrent + 1) % filteredCandidates.length
          : normalizedCurrent <= 0
            ? filteredCandidates.length - 1
            : normalizedCurrent - 1;
      });
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    const activeCandidate = filteredCandidates[visibleActiveIndex];
    if (activeCandidate) {
      commitCandidate(activeCandidate);
      return;
    }
    if (mode === "remove") {
      return;
    }
    const parsed = parseCanonicalTag(query);
    if (!parsed) {
      setValidationError(INVALID_TAG_MESSAGE);
      return;
    }
    setValidationError(null);
    commitAdd(parsed);
  };

  const switchMode = (nextMode: NotesTagChooserMode) => {
    setMode(nextMode);
    setQuery("");
    setActiveIndex(-1);
    setValidationError(null);
  };

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentMode: NotesTagChooserMode
  ) => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    const nextMode =
      event.key === "Home"
        ? "add"
        : event.key === "End"
          ? "remove"
          : currentMode === "add"
            ? "remove"
            : "add";
    switchMode(nextMode);
    (nextMode === "add" ? addTabRef : removeTabRef).current?.focus();
  };

  return (
    <Dialog.Root open={open} onOpenChange={requestOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Popup
          className="modal notes-selection-chooser"
          aria-label="Edit tags"
          initialFocus={inputRef}
        >
          <div className="notes-selection-chooser-header">
            <div>
              <Dialog.Title render={<h2 />}>Edit tags</Dialog.Title>
              <Dialog.Description>
                Add or remove one exact tag from the selected rows.
              </Dialog.Description>
            </div>
            <Dialog.Close
              type="button"
              className="notes-selection-chooser-close"
              aria-label="Close tag chooser"
            >
              <X size={17} aria-hidden="true" />
            </Dialog.Close>
          </div>

          <div className="notes-tag-chooser-tabs" role="tablist" aria-label="Tag action">
            <button
              ref={addTabRef}
              id={addTabId}
              type="button"
              role="tab"
              aria-selected={mode === "add"}
              aria-controls={panelId}
              tabIndex={mode === "add" ? 0 : -1}
              onClick={() => switchMode("add")}
              onKeyDown={(event) => handleTabKeyDown(event, "add")}
            >
              Add
            </button>
            <button
              ref={removeTabRef}
              id={removeTabId}
              type="button"
              role="tab"
              aria-selected={mode === "remove"}
              aria-controls={panelId}
              tabIndex={mode === "remove" ? 0 : -1}
              onClick={() => switchMode("remove")}
              onKeyDown={(event) => handleTabKeyDown(event, "remove")}
            >
              Remove
            </button>
          </div>

          <div
            id={panelId}
            role="tabpanel"
            aria-labelledby={mode === "add" ? addTabId : removeTabId}
          >
            <label className="notes-selection-chooser-search">
              <Search size={15} aria-hidden="true" />
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-label={mode === "add" ? "Tag to add" : "Tag to remove"}
                aria-controls={listboxId}
                aria-expanded={!loading && filteredCandidates.length > 0}
                aria-autocomplete="list"
                aria-activedescendant={
                  visibleActiveIndex >= 0
                    ? `${listboxId}-${visibleActiveIndex}`
                    : undefined
                }
                placeholder={
                  mode === "add"
                    ? "Type #tag or @person"
                    : "Search selected tags"
                }
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setActiveIndex(-1);
                  setValidationError(null);
                }}
                onKeyDown={handleInputKeyDown}
              />
            </label>

            <div
              id={listboxId}
              className="notes-selection-chooser-options"
              role="listbox"
              aria-label={
                mode === "add" ? "Tag suggestions" : "Selected tags"
              }
              aria-busy={loading}
            >
              {!loading &&
                filteredCandidates.map((tag, index) => (
                  <button
                    id={`${listboxId}-${index}`}
                    key={tagKey(tag)}
                    type="button"
                    role="option"
                    className="notes-selection-chooser-option notes-tag-chooser-option"
                    aria-selected={visibleActiveIndex === index}
                    tabIndex={-1}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => commitCandidate(tag)}
                  >
                    {tagLabel(tag)}
                  </button>
                ))}
              {loading ? (
                <p
                  className="notes-selection-chooser-empty"
                  role="status"
                  aria-label="Loading tags"
                >
                  Loading tags...
                </p>
              ) : filteredCandidates.length === 0 ? (
                <p className="notes-selection-chooser-empty">
                  {mode === "remove" && removeSuggestions.length === 0
                    ? "No selected tags to remove"
                    : mode === "remove"
                      ? "No matching selected tags"
                      : "No matching suggestions"}
                </p>
              ) : null}
            </div>

            {validationError && (
              <p className="notes-selection-chooser-error" role="alert">
                {validationError}
              </p>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
