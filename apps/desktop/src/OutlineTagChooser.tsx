import { Search } from "lucide-react";
import {
  useId, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type RefObject
} from "react";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesStore } from "./notesStore";
import {
  outlineTagKey, OUTLINE_TAG_PARSE_ERROR, OUTLINE_TAG_PICK_ERROR,
  parseSingleTag, planTagEdits, tagsIn, type OutlineTag
} from "./outlineTagEdits";
import { useMenuDismiss, useMenuPlacement } from "./useMenuDismiss";

const TABS = [
  { mode: "add", label: "Add" },
  { mode: "remove", label: "Remove" }
] as const;

/**
 * The tag editor behind `Tags`. Committing rewrites text — a tag is an inline
 * `#tag` / `@person` token that SQLite re-derives on every write — so the
 * whole dialog is a spelling picker in front of `planTagEdits`.
 *
 * Suggestions come from the nodes the client already holds. A tag living only
 * in a part of the outline that has not loaded is therefore missing from the
 * list, though typing it still works: the tokenizer, not the list, decides
 * what a valid tag is.
 *
 * Anchored to the row's menu trigger like the menu it came from, and loaded on
 * first open so it stays out of the first-paint bundle.
 */
export function OutlineTagChooser({
  nodes, targetIds, store, triggerRef, onClose
}: {
  readonly nodes: readonly NoteView[];
  readonly targetIds: readonly string[];
  readonly store: NotesStore;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const dismiss = useMenuDismiss(true, dialogRef, triggerRef, onClose);
  const placement = useMenuPlacement(dialogRef);
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const baseId = useId();
  const optionId = (position: number) => `${baseId}-option-${position}`;

  const workspaceTags = useMemo(() => tagsIn(nodes), [nodes]);
  // Frozen at open: the Remove list must not shrink under the reader as the
  // very removal they are reaching for lands.
  const [rowTags] = useState(() => tagsIn(
    nodes.filter((node) => targetIds.includes(node.id))
  ));
  const source = mode === "add" ? workspaceTags : rowTags;
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return source;
    return source.filter((tag) => outlineTagKey(tag).includes(needle));
  }, [query, source]);
  const index = Math.min(active, Math.max(matches.length - 1, 0));

  const chooseMode = (next: "add" | "remove") => {
    setMode(next);
    setActive(0);
    setError(null);
  };
  const commit = (tag: OutlineTag | undefined) => {
    // Free text is an Add-mode affordance. Remove offers what the rows carry,
    // and a tag they do not carry has nothing to strip.
    const chosen = tag ?? (mode === "add" ? parseSingleTag(query) : null);
    if (!chosen) {
      setError(mode === "add" ? OUTLINE_TAG_PARSE_ERROR : OUTLINE_TAG_PICK_ERROR);
      return;
    }
    onClose();
    triggerRef.current?.focus();
    const snapshot = store.getSnapshot();
    void store.applyTextEdits(planTagEdits(
      snapshot.nodes, snapshot.drafts, snapshot.noteDrafts,
      targetIds, chosen, mode
    ));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // A Korean IME ends its composition with Enter. Acting on that keystroke
    // would apply whatever the list happened to be pointing at, so the guard
    // is the same one `outlineKeyboard.ts` opens with.
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
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>(
      '[role="tab"]'
    )];
    const current = tabs.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(current + step + tabs.length) % tabs.length];
    // Selection follows focus, the way a two-tab strip is expected to behave.
    next?.focus();
    next?.click();
  };

  return (
    <div
      ref={dialogRef}
      className="notes-bullet-menu notes-move-chooser"
      role="dialog"
      aria-label="Edit tags"
      aria-describedby={`${baseId}-description`}
      style={{ position: "absolute", ...placement } as CSSProperties}
      onKeyDown={onKeyDown}
    >
      <p
        id={`${baseId}-description`}
        className="notes-selection-visually-hidden"
      >
        Add or remove one exact tag from the selected rows.
      </p>
      <div
        className="notes-tag-chooser-tabs"
        role="tablist"
        aria-label="Tag action"
        onKeyDown={onTabKeyDown}
      >
        {TABS.map((tab) => (
          <button
            key={tab.mode}
            type="button"
            role="tab"
            aria-selected={mode === tab.mode}
            tabIndex={mode === tab.mode ? 0 : -1}
            onClick={() => chooseMode(tab.mode)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="notes-move-search-field">
        <Search size={14} aria-hidden="true" />
        <input
          type="text"
          role="combobox"
          // The filter is the only thing in the dialog that takes typing, and
          // the arrows drive the list from here without ever leaving it.
          autoFocus
          aria-label={mode === "add" ? "Add a tag" : "Remove a tag"}
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={`${baseId}-list`}
          aria-activedescendant={matches[index] ? optionId(index) : undefined}
          placeholder={mode === "add" ? "#tag or @person" : "Search"}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setError(null);
          }}
        />
      </div>
      {error && (
        <p className="notes-selection-chooser-error" role="alert">{error}</p>
      )}
      <div
        className="notes-move-destinations"
        id={`${baseId}-list`}
        role="listbox"
        aria-label="Tags"
      >
        {matches.length === 0 && (
          <p className="notes-move-empty">
            {mode === "add" ? "No matching tag yet." : "No tag on these rows."}
          </p>
        )}
        {matches.map((tag, position) => (
          <div
            key={outlineTagKey(tag)}
            id={optionId(position)}
            className="notes-move-destination notes-tag-chooser-option"
            role="option"
            aria-selected={position === index}
            style={{ "--notes-move-depth": 0 } as CSSProperties}
            onPointerMove={() => setActive(position)}
            onClick={() => commit(tag)}
          >
            {tag.raw}
          </div>
        ))}
      </div>
    </div>
  );
}
