import { useRef, type CSSProperties } from "react";
import { CalendarDays, Search } from "lucide-react";
import { useMenuDismiss } from "./useMenuDismiss";

export interface JournalDateMenuTarget {
  readonly date: string;
  readonly top: number;
  readonly left: number;
}

/**
 * What a date in a row can do: be opened as its day, or be asked which rows
 * name it. It sits where the token is rather than in the pane, since the same
 * menu answers for a date in the outline, in a note, and in a page title.
 */
export function JournalDateMenu({
  target,
  onOpenDay,
  onShowLinkedRows,
  onClose
}: {
  readonly target: JournalDateMenuTarget;
  readonly onOpenDay: (date: string) => void;
  readonly onShowLinkedRows: (date: string) => void;
  readonly onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  // The token that opened this is in a pane that may have re-rendered since,
  // so there is nothing stable to hand back focus to: an outside press closes
  // the menu and leaves focus where the press put it.
  const triggerRef = useRef<HTMLElement>(null);
  const onKeyDown = useMenuDismiss(true, menuRef, triggerRef, onClose);
  return (
    <div
      ref={menuRef}
      className="notes-date-menu"
      role="menu"
      aria-label={`Date ${target.date}`}
      style={{
        position: "fixed",
        insetBlockStart: target.top,
        insetInlineStart: target.left
      } as CSSProperties}
      onKeyDown={onKeyDown}
    >
      <button
        className="notes-date-menu-item"
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          onOpenDay(target.date);
        }}
      >
        <CalendarDays size={14} aria-hidden="true" />
        <span>Open journal</span>
      </button>
      <button
        className="notes-date-menu-item"
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          onShowLinkedRows(target.date);
        }}
      >
        <Search size={14} aria-hidden="true" />
        <span>Show linked rows</span>
      </button>
    </div>
  );
}
