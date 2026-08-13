import type { ReactNode } from "react";

/**
 * One bullet-menu row: `icon | label | shortcut` in the 3-column grid the
 * stylesheet defines. A disabled item stays visible, dimmed, and focusable so
 * arrow roving can reach it and a screen reader can read `reason`; only its
 * activation is suppressed.
 */
export function RowMenuItem({
  icon, label, shortcut, keyshortcuts, danger = false, disabled = false,
  reason, onClick
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly shortcut?: string;
  readonly keyshortcuts?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly reason?: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      className="notes-bullet-menu-item"
      type="button"
      role="menuitem"
      data-danger={danger ? "true" : undefined}
      data-disabled={disabled ? "true" : undefined}
      aria-disabled={disabled || undefined}
      aria-keyshortcuts={keyshortcuts}
      title={disabled ? reason : undefined}
      style={{ width: "100%", border: 0, background: "transparent" }}
      onClick={() => {
        if (!disabled) onClick();
      }}
    >
      {icon}
      <span>{label}</span>
      {/* `aria-keyshortcuts` already carries the binding, so keeping the
          printed hint out of the accessible name leaves it just "Duplicate". */}
      {shortcut && (
        <span className="notes-bullet-menu-shortcut" aria-hidden="true">
          {shortcut}
        </span>
      )}
    </button>
  );
}
