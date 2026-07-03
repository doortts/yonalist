import { useEffect } from "react";

const SCROLLBAR_ACTIVE_MS = 800;

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

function eventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) {
    return target;
  }
  if (target instanceof Document) {
    return target.scrollingElement;
  }
  return null;
}

/**
 * WebKit does not repaint scrollbars when an ancestor's :hover state
 * changes, so hover-only thumbs never appeared in the desktop webview.
 * This tags the hovered or actively scrolling container with a class instead,
 * which WebKit repaints reliably.
 */
export function useScrollbarHover() {
  useEffect(() => {
    let current: HTMLElement | null = null;
    const activeTimers = new Map<HTMLElement, number>();

    function setCurrent(next: HTMLElement | null) {
      if (next === current) {
        return;
      }
      current?.classList.remove("scrollbar-hover");
      current = next;
      current?.classList.add("scrollbar-hover");
    }

    function markActive(element: HTMLElement | null) {
      if (!element) {
        return;
      }

      element.classList.add("scrollbar-active");
      const previous = activeTimers.get(element);
      if (previous !== undefined) {
        window.clearTimeout(previous);
      }

      activeTimers.set(
        element,
        window.setTimeout(() => {
          element.classList.remove("scrollbar-active");
          activeTimers.delete(element);
        }, SCROLLBAR_ACTIVE_MS)
      );
    }

    function handleOver(event: Event) {
      setCurrent(findScrollable(eventElement(event.target)));
    }

    function handleMove(event: Event) {
      setCurrent(findScrollable(eventElement(event.target)));
    }

    function handleScroll(event: Event) {
      markActive(findScrollable(eventElement(event.target)));
    }

    function handleWheel(event: Event) {
      markActive(findScrollable(eventElement(event.target)));
    }

    function handleLeave() {
      setCurrent(null);
    }

    document.addEventListener("pointerover", handleOver, true);
    document.addEventListener("pointermove", handleMove, true);
    document.addEventListener("scroll", handleScroll, true);
    document.addEventListener("wheel", handleWheel, true);
    document.addEventListener("pointerleave", handleLeave);
    return () => {
      document.removeEventListener("pointerover", handleOver, true);
      document.removeEventListener("pointermove", handleMove, true);
      document.removeEventListener("scroll", handleScroll, true);
      document.removeEventListener("wheel", handleWheel, true);
      document.removeEventListener("pointerleave", handleLeave);
      setCurrent(null);
      for (const [element, timer] of activeTimers) {
        window.clearTimeout(timer);
        element.classList.remove("scrollbar-active");
      }
      activeTimers.clear();
    };
  }, []);
}
