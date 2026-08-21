import { Search } from "lucide-react";
import {
  useId, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type RefObject
} from "react";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { NotesStore } from "../notesStore";
import type { OutlineMenuMode } from "./outlineMenuCommands";
import {
  outlineMoveInsertion, outlineMoveTargets, type OutlineMoveTarget
} from "./outlineMoveTargets";
import { useMenuDismiss, useMenuPlacement } from "../useMenuDismiss";

/**
 * The destination picker behind `Move To...`, and the lossless alternative Cut
 * points at when a subtree carries an image or a note the clipboard cannot
 * round-trip. It is anchored to the row's menu trigger like the menu it came
 * from, and loads on first open so it stays out of the first-paint bundle.
 *
 * The active option is tracked with `aria-activedescendant` rather than DOM
 * focus, so the filter input keeps the caret while the arrows walk the list.
 */
export function OutlineMoveChooser({
  mode, nodes, movingRootIds, rootId, store, triggerRef, onClose
}: {
  readonly mode: OutlineMenuMode;
  readonly nodes: readonly NoteView[];
  readonly movingRootIds: readonly string[];
  readonly rootId: string;
  readonly store: NotesStore;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const dismiss = useMenuDismiss(true, dialogRef, triggerRef, onClose);
  const placement = useMenuPlacement(dialogRef);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const baseId = useId();
  const optionId = (position: number) => `${baseId}-option-${position}`;
  const title = mode === "selection" ? "Move selection" : "Move item";
  const targets = useMemo(
    () => outlineMoveTargets(nodes, movingRootIds, rootId),
    [movingRootIds, nodes, rootId]
  );
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return targets;
    return targets.filter(
      (target) => target.label.toLowerCase().includes(needle)
    );
  }, [query, targets]);
  const index = Math.min(active, Math.max(matches.length - 1, 0));

  const commit = (target: OutlineMoveTarget | undefined) => {
    if (!target) return;
    onClose();
    triggerRef.current?.focus();
    void store.moveNodes(
      outlineMoveInsertion(target.id, movingRootIds, rootId)
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // A Korean IME ends its composition with Enter. Acting on that keystroke
    // would move whatever the list happened to be pointing at, so the guard is
    // the same one `outlineKeyboard.ts` opens with.
    if (event.nativeEvent.isComposing || event.key === "Process") return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (matches.length === 0) return;
      setActive(event.key === "ArrowDown"
        ? (index + 1) % matches.length
        : (index - 1 + matches.length) % matches.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      commit(matches[index]);
      return;
    }
    dismiss(event);
  };

  return (
    <div
      ref={dialogRef}
      className="notes-bullet-menu notes-move-chooser"
      role="dialog"
      aria-label={title}
      aria-describedby={`${baseId}-description`}
      style={{ position: "absolute", ...placement } as CSSProperties}
      onKeyDown={onKeyDown}
    >
      <p
        id={`${baseId}-description`}
        className="notes-selection-visually-hidden"
      >
        Choose a new parent for the selected outline.
      </p>
      <div className="notes-move-search-field">
        <Search size={14} aria-hidden="true" />
        <input
          type="text"
          role="combobox"
          // The filter is the only thing in the dialog that takes typing, and
          // the arrows drive the list from here without ever leaving it.
          autoFocus
          aria-label="Filter destinations"
          aria-expanded="true"
          aria-controls={`${baseId}-list`}
          aria-activedescendant={matches[index] ? optionId(index) : undefined}
          placeholder="Search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
      </div>
      <div
        className="notes-move-destinations"
        id={`${baseId}-list`}
        role="listbox"
        aria-label="Destinations"
      >
        {matches.length === 0 && (
          <p className="notes-move-empty">No matching destination.</p>
        )}
        {matches.map((target, position) => (
          <div
            key={target.id ?? "top-level"}
            id={optionId(position)}
            className="notes-move-destination"
            role="option"
            aria-selected={position === index}
            style={{ "--notes-move-depth": target.depth } as CSSProperties}
            onPointerMove={() => setActive(position)}
            onClick={() => commit(target)}
          >
            {target.label}
          </div>
        ))}
      </div>
    </div>
  );
}
