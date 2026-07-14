import { Dialog } from "@base-ui/react/dialog";
import { Search, X } from "lucide-react";
import {
  forwardRef,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type RefAttributes,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { NoteId, NoteNode } from "../../domain/notes";
import "../../components/ui/dialog.css";
import {
  buildNotesMoveDestinations,
  isActiveMoveNode,
  type NotesMoveDestination
} from "./notesMoveTargets";
import {
  type NotesFrozenSelectionSnapshot,
  useFrozenOpenValue,
  useFrozenReadyOpenValue
} from "./notesSelectionChooser";

const EMPTY_DESTINATIONS: readonly NotesMoveDestination[] = Object.freeze([]);

export interface NotesMoveChooserCommit<Ownership = unknown> {
  readonly destinationId: NoteId | null;
  readonly snapshot: NotesFrozenSelectionSnapshot<Ownership>;
}

export interface NotesMoveChooserProps<Ownership = unknown> {
  readonly open: boolean;
  /** Router-owned selection/ownership captured for this chooser session. */
  readonly snapshot: NotesFrozenSelectionSnapshot<Ownership>;
  /** Complete active workspace source, never a filtered projection. */
  readonly nodesById: Readonly<Record<NoteId, NoteNode>> | null;
  readonly loading?: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onChoose: (commit: NotesMoveChooserCommit<Ownership>) => void;
  readonly onRequestFocusReturn: () => void;
}

function NotesMoveChooserInner<Ownership>(
  {
    open,
    snapshot,
    nodesById,
    loading = false,
    onOpenChange,
    onChoose,
    onRequestFocusReturn
  }: NotesMoveChooserProps<Ownership>,
  forwardedRef: React.ForwardedRef<HTMLDivElement>
) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const openedSnapshot = useFrozenOpenValue(open, snapshot);

  const liveDestinations = useMemo(() => {
    if (
      !nodesById ||
      openedSnapshot.nodeIds.length === 0 ||
      openedSnapshot.nodeIds.some(
        (nodeId) => !isActiveMoveNode(nodesById[nodeId])
      )
    ) {
      return [];
    }
    return buildNotesMoveDestinations(nodesById, openedSnapshot.nodeIds);
  }, [nodesById, openedSnapshot]);
  const destinations = useFrozenReadyOpenValue(
    open,
    !loading && nodesById !== null,
    liveDestinations,
    EMPTY_DESTINATIONS
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredDestinations = useMemo(
    () =>
      destinations.filter((destination) =>
        destination.label.toLocaleLowerCase().includes(normalizedQuery)
      ),
    [destinations, normalizedQuery]
  );
  const visibleActiveIndex =
    !loading && activeIndex >= 0 && activeIndex < filteredDestinations.length
      ? activeIndex
      : -1;

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    setQuery("");
    setActiveIndex(-1);
    searchRef.current?.focus();
  }, [open]);

  const requestOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      onRequestFocusReturn();
    }
  };

  const choose = (destinationId: NoteId | null) => {
    onChoose({ destinationId, snapshot: openedSnapshot });
    requestOpenChange(false);
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
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
      if (filteredDestinations.length === 0) {
        return;
      }
      setActiveIndex((current) => {
        const normalizedCurrent =
          current >= 0 && current < filteredDestinations.length ? current : -1;
        return event.key === "ArrowDown"
          ? (normalizedCurrent + 1) % filteredDestinations.length
          : normalizedCurrent <= 0
            ? filteredDestinations.length - 1
            : normalizedCurrent - 1;
      });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const destination = filteredDestinations[visibleActiveIndex];
      if (destination) {
        choose(destination.id);
      }
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={requestOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Popup
          ref={forwardedRef}
          className="modal notes-selection-chooser"
          aria-label="Move selection"
          initialFocus={searchRef}
        >
          <div className="notes-selection-chooser-header">
            <div>
              <Dialog.Title render={<h2 />}>Move selection</Dialog.Title>
              <Dialog.Description>
                Choose a new parent for the selected outline.
              </Dialog.Description>
            </div>
            <Dialog.Close
              type="button"
              className="notes-selection-chooser-close"
              aria-label="Close Move To"
            >
              <X size={17} aria-hidden="true" />
            </Dialog.Close>
          </div>

          <label className="notes-selection-chooser-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              role="searchbox"
              aria-label="Search destinations"
              aria-controls={listboxId}
              aria-activedescendant={
                visibleActiveIndex >= 0
                  ? `${listboxId}-${visibleActiveIndex}`
                  : undefined
              }
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setActiveIndex(-1);
              }}
              onKeyDown={handleSearchKeyDown}
            />
          </label>

          <div
            id={listboxId}
            className="notes-selection-chooser-options"
            role="listbox"
            aria-label="Move destinations"
            aria-busy={loading}
          >
            {!loading &&
              filteredDestinations.map((destination, index) => (
                <button
                  id={`${listboxId}-${index}`}
                  key={destination.id ?? "top-level"}
                  type="button"
                  role="option"
                  className="notes-selection-chooser-option"
                  aria-selected={visibleActiveIndex === index}
                  tabIndex={-1}
                  style={
                    {
                      "--notes-selection-choice-depth": destination.depth
                    } as CSSProperties
                  }
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => choose(destination.id)}
                >
                  {destination.label}
                </button>
              ))}
            {loading ? (
              <p
                className="notes-selection-chooser-empty"
                role="status"
                aria-label="Loading move destinations"
              >
                Loading destinations...
              </p>
            ) : filteredDestinations.length === 0 ? (
              <p className="notes-selection-chooser-empty">
                No destinations found
              </p>
            ) : null}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const NotesMoveChooser = forwardRef(NotesMoveChooserInner) as <Ownership>(
  props: NotesMoveChooserProps<Ownership> & RefAttributes<HTMLDivElement>
) => ReactElement;
