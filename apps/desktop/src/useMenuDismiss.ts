import {
  useEffect, useLayoutEffect, useRef, useState,
  type KeyboardEvent, type RefObject
} from "react";

const ROVING_KEYS = ["ArrowDown", "ArrowUp", "Home", "End"];

/**
 * The shell every popup menu in the outline shares: focus the first item on
 * open, dismiss on an outside pointerdown, close on `Escape` with focus back on
 * the trigger, and rove with the arrow keys. The trigger counts as inside so a
 * click on it closes through its own toggle instead of reopening.
 *
 * Returns the menu's `onKeyDown`. Effects are keyed on `open` alone — `onClose`
 * is read from a ref — so a re-render while the menu is open never steals focus
 * back to the first item.
 */
export function useMenuDismiss(
  open: boolean,
  menuRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
  onClose: () => void
): (event: KeyboardEvent<HTMLElement>) => void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    });
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) &&
          !triggerRef.current?.contains(target)) {
        closeRef.current();
      }
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", dismiss, true);
    };
  }, [open, menuRef, triggerRef]);

  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeRef.current();
      triggerRef.current?.focus();
      return;
    }
    if (!ROVING_KEYS.includes(event.key)) return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(
      '[role="menuitem"]'
    )];
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };
}

/** Where a row menu sits when nothing pushes it: just under the trigger. */
export const MENU_BLOCK_INSET = 28;
const MENU_FLIP_GAP = 4;

interface MenuBounds {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/**
 * The flip and clamp decision, kept pure because jsdom has no layout: `menu` is
 * the rectangle measured at the default placement and `bounds` the visible box
 * the menu has to stay inside. Flips above the trigger only when the menu
 * overflows below AND the flipped position actually fits.
 */
export function menuPlacement(
  menu: {
    readonly top: number;
    readonly left: number;
    readonly width: number;
    readonly height: number;
  },
  bounds: MenuBounds
): { readonly insetBlockStart: number; readonly insetInlineStart: number } {
  const anchorTop = menu.top - MENU_BLOCK_INSET;
  const flip = menu.top + menu.height > bounds.bottom &&
    anchorTop - MENU_FLIP_GAP - menu.height >= bounds.top;
  const overflowRight = menu.left + menu.width - bounds.right;
  return {
    insetBlockStart: flip ? -(menu.height + MENU_FLIP_GAP) : MENU_BLOCK_INSET,
    insetInlineStart: Math.max(
      Math.min(0, -overflowRight),
      bounds.left - menu.left
    )
  };
}

/**
 * The flip and clamp an anchored outline popup runs once, on mount. Measuring
 * again would buy nothing: the row unmounts when it scrolls out of the
 * virtualized window, which closes the popup with it.
 */
export function useMenuPlacement(menuRef: RefObject<HTMLElement | null>) {
  const [placement, setPlacement] = useState({
    insetBlockStart: MENU_BLOCK_INSET,
    insetInlineStart: 0
  });
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menu) {
      setPlacement(menuPlacement(
        menu.getBoundingClientRect(),
        outlineMenuBounds(menu)
      ));
    }
  }, [menuRef]);
  return placement;
}

/** The box a menu anchored inside the outline has to stay within. */
export function outlineMenuBounds(menu: HTMLElement): MenuBounds {
  const rows = menu.closest<HTMLElement>(".notes-outline-rows");
  const visible = rows?.getBoundingClientRect();
  return {
    top: Math.max(visible?.top ?? 0, 0),
    bottom: Math.min(visible?.bottom ?? window.innerHeight, window.innerHeight),
    left: 0,
    right: window.innerWidth
  };
}
