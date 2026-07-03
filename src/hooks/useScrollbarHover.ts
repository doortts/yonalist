import { useEffect } from "react";

function findScrollable(start: Element | null): HTMLElement | null {
  let node = start as HTMLElement | null;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    if (
      (style.overflowY === "auto" || style.overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * WebKit does not repaint scrollbars when an ancestor's :hover state
 * changes, so hover-only thumbs never appeared in the desktop webview.
 * This tags the hovered scroll container with a class instead, which
 * WebKit repaints reliably.
 */
export function useScrollbarHover() {
  useEffect(() => {
    let current: HTMLElement | null = null;

    function setCurrent(next: HTMLElement | null) {
      if (next === current) {
        return;
      }
      current?.classList.remove("scrollbar-hover");
      current = next;
      current?.classList.add("scrollbar-hover");
    }

    function handleOver(event: Event) {
      setCurrent(findScrollable(event.target as Element));
    }

    function handleLeave() {
      setCurrent(null);
    }

    document.addEventListener("pointerover", handleOver, true);
    document.addEventListener("pointerleave", handleLeave);
    return () => {
      document.removeEventListener("pointerover", handleOver, true);
      document.removeEventListener("pointerleave", handleLeave);
      setCurrent(null);
    };
  }, []);
}
