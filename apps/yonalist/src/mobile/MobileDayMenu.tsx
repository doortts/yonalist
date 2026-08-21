import { useRef, useState } from "react";
import { useMenuDismiss } from "../useMenuDismiss";
import { MobileIcon } from "./MobileIcon";

/**
 * The day's overflow menu.
 *
 * It exists because the phone shell keeps the outline bare, and the toolbar it
 * drops was the only way to reach one thing the rows need: whether finished
 * items are shown at all. Everything else that toolbar carried is either
 * desktop-only or outside v1, so the menu holds exactly the one entry until
 * something else earns a place in it.
 *
 * Dismissal, focus and the arrow keys come from `useMenuDismiss`, which every
 * other menu in the app already uses — a second set of rules for closing a
 * popup is how two menus start behaving differently.
 */
export function MobileDayMenu({
  showCompleted,
  onShowCompletedChange
}: {
  readonly showCompleted: boolean;
  readonly onShowCompletedChange: (visible: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const onKeyDown = useMenuDismiss(open, menuRef, triggerRef, () => setOpen(false));

  return (
    <div className="mobile-day-menu">
      <button
        ref={triggerRef}
        className="mobile-day-step"
        type="button"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
      >
        <MobileIcon name="dots" size={18} />
      </button>
      {open && (
        <div
          ref={menuRef}
          className="mobile-menu"
          role="menu"
          aria-label="Day"
          onKeyDown={onKeyDown}
        >
          <button
            className="mobile-menu-item"
            type="button"
            role="menuitemcheckbox"
            aria-checked={showCompleted}
            onClick={() => {
              onShowCompletedChange(!showCompleted);
              setOpen(false);
            }}
          >
            <span className="mobile-menu-tick">
              {showCompleted && <MobileIcon name="check" size={16} />}
            </span>
            <span>Completed items</span>
          </button>
        </div>
      )}
    </div>
  );
}
