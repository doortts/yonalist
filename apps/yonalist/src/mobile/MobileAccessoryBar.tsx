import type { NotesStore } from "../notesStore";
import { localDateIso } from "../outline/outlineSlash";
import { MobileIcon, type MobileIconName } from "./MobileIcon";

/**
 * The row the caret is in, or nothing.
 *
 * Read off the document rather than tracked in state: the outline owns focus
 * and moves it on its own — a commit refocuses, Enter moves to the new row —
 * and a second record of where the caret is would be wrong the moment it
 * disagreed.
 */
function focused(): { field: HTMLTextAreaElement; nodeId: string } | null {
  const field = document.activeElement;
  if (!(field instanceof HTMLTextAreaElement)) return null;
  const nodeId = field.closest<HTMLElement>("[data-outline-id]")?.dataset.outlineId;
  return nodeId ? { field, nodeId } : null;
}

/**
 * Puts text where the caret is and leaves the caret after it, with a space in
 * front where one is needed: a `#` welded to the end of a word is part of that
 * word, not a tag, and the same goes for a date read out of a sentence.
 */
function type(field: HTMLTextAreaElement, text: string) {
  const at = field.selectionStart ?? field.value.length;
  const to = field.selectionEnd ?? at;
  const before = field.value.slice(0, at);
  if (before !== "" && !/\s$/u.test(before)) text = ` ${text}`;
  // Through the native setter so React's own onChange sees the value it would
  // have seen from a keystroke.
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
    ?.set?.call(field, field.value.slice(0, at) + text + field.value.slice(to));
  field.setSelectionRange(at + text.length, at + text.length);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(field: HTMLTextAreaElement, key: string, shiftKey = false) {
  field.dispatchEvent(
    new KeyboardEvent("keydown", { key, code: key, shiftKey, bubbles: true, cancelable: true })
  );
}

/**
 * The strip above the soft keyboard.
 *
 * A phone has no Tab and no modifiers, so the four things the desktop reaches
 * by key need somewhere to live. Indent and outdent are sent as the keys the
 * outline already answers rather than reimplemented: which row becomes the
 * parent, and where an outdented row lands among its new siblings, is decided
 * in one place that way. Completion goes straight to the store, since it names
 * its own row and has nothing to work out.
 *
 * Every button holds the caret where it is: a bar that took focus to press
 * would close the keyboard it sits on.
 */
const keys = [
  { id: "outdent", label: "Outdent", icon: "indent-decrease" },
  { id: "indent", label: "Indent", icon: "indent-increase" },
  { id: "todo", label: "To-do", icon: "square-check" },
  { id: "tag", label: "Tag", icon: "tag" },
  { id: "date", label: "Date", icon: "calendar-event" },
  { id: "hide", label: "Hide keyboard", icon: "keyboard-hide" }
] as const satisfies readonly {
  readonly id: string;
  readonly label: string;
  readonly icon: MobileIconName;
}[];

export function MobileAccessoryBar({ store }: { readonly store: NotesStore }) {
  const run = (id: (typeof keys)[number]["id"]) => {
    const row = focused();
    if (!row) return;
    switch (id) {
      case "outdent":
        press(row.field, "Tab", true);
        return;
      case "indent":
        press(row.field, "Tab");
        return;
      case "todo":
        void store.cycleCompleted(row.nodeId);
        return;
      case "tag":
        type(row.field, "#");
        return;
      case "date":
        type(row.field, localDateIso());
        return;
      case "hide":
        row.field.blur();
    }
  };

  return (
    <div className="mobile-accessory" role="toolbar" aria-label="Row actions">
      {keys.map((key) => (
        <button
          key={key.id}
          className="mobile-accessory-key"
          type="button"
          aria-label={key.label}
          // The press must not move the caret out of the row it acts on.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => run(key.id)}
        >
          <MobileIcon name={key.icon} size={21} />
        </button>
      ))}
    </div>
  );
}
