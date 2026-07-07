import { useEffect } from "react";

const SCROLLBAR_ACTIVE_MS = 800;
const MIN_SCROLLBAR_THUMB_PX = 24;
// Visual placement of the thumb relative to the container's right edge:
// 4px inset + 6px wide (mirrors the CSS width below).
const SCROLLBAR_THUMB_RIGHT_INSET_PX = 4;
const SCROLLBAR_THUMB_WIDTH_PX = 6;

function isScrollableOverflow(value: string) {
  return value === "auto" || value === "scroll" || value === "overlay";
}

function updateScrollbarOverlay(element: HTMLElement) {
  if (element.scrollHeight <= element.clientHeight) {
    // The element used to overflow but no longer does — drop any stale thumb
    // so a resize/content change doesn't leave an orphaned overlay behind.
    resetScrollbarOverlay(element);
    return;
  }

  const thumbHeight = Math.max(
    MIN_SCROLLBAR_THUMB_PX,
    Math.round((element.clientHeight / element.scrollHeight) * element.clientHeight)
  );
  const maxScrollTop = element.scrollHeight - element.clientHeight;
  const maxThumbViewportTop = element.clientHeight - thumbHeight;
  const thumbViewportTop =
    maxScrollTop > 0 ? (element.scrollTop / maxScrollTop) * maxThumbViewportTop : 0;

  // The thumb is drawn as a position: fixed pseudo-element, so it lives outside
  // the scrolling content and cannot bounce with it. Anchor it to the
  // container's current viewport rect rather than its scroll offset.
  const rect = element.getBoundingClientRect();

  element.classList.add("scrollbar-overlay");
  element.style.setProperty("--scrollbar-overlay-height", `${thumbHeight}px`);
  element.style.setProperty(
    "--scrollbar-overlay-top",
    `${Math.round(rect.top + thumbViewportTop)}px`
  );
  element.style.setProperty(
    "--scrollbar-overlay-left",
    `${Math.round(rect.right - SCROLLBAR_THUMB_RIGHT_INSET_PX - SCROLLBAR_THUMB_WIDTH_PX)}px`
  );
}

function resetScrollbarOverlay(element: HTMLElement) {
  element.classList.remove("scrollbar-overlay", "scrollbar-hover", "scrollbar-active");
  element.style.removeProperty("--scrollbar-overlay-height");
  element.style.removeProperty("--scrollbar-overlay-top");
  element.style.removeProperty("--scrollbar-overlay-left");
}

function findScrollable(start: Element | null): HTMLElement | null {
  let node = start as HTMLElement | null;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    if (
      isScrollableOverflow(style.overflowY) &&
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
    const overlayElements = new Set<HTMLElement>();

    function markOverlay(element: HTMLElement) {
      overlayElements.add(element);
      updateScrollbarOverlay(element);
    }

    function setCurrent(next: HTMLElement | null) {
      if (next === current) {
        if (next) {
          markOverlay(next);
        }
        return;
      }
      current?.classList.remove("scrollbar-hover");
      current = next;
      if (current) {
        markOverlay(current);
        current.classList.add("scrollbar-hover");
      }
    }

    function markActive(element: HTMLElement | null) {
      if (!element) {
        return;
      }

      // Refresh geometry before tagging the class: if the element quietly
      // stopped overflowing, markOverlay resets it and we must not re-add the
      // active class on a non-scrollable element.
      markOverlay(element);
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

    function handleResize() {
      // Viewport-anchored thumbs drift when the container moves or resizes
      // without a scroll event (window/pane resize). Re-solve every tracked
      // overlay against its fresh rect.
      for (const element of overlayElements) {
        updateScrollbarOverlay(element);
      }
    }

    document.addEventListener("pointerover", handleOver, true);
    document.addEventListener("pointermove", handleMove, true);
    document.addEventListener("scroll", handleScroll, true);
    document.addEventListener("wheel", handleWheel, true);
    document.addEventListener("pointerleave", handleLeave);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("pointerover", handleOver, true);
      document.removeEventListener("pointermove", handleMove, true);
      document.removeEventListener("scroll", handleScroll, true);
      document.removeEventListener("wheel", handleWheel, true);
      document.removeEventListener("pointerleave", handleLeave);
      window.removeEventListener("resize", handleResize);
      setCurrent(null);
      for (const [element, timer] of activeTimers) {
        window.clearTimeout(timer);
      }
      activeTimers.clear();
      for (const element of overlayElements) {
        resetScrollbarOverlay(element);
      }
      overlayElements.clear();
    };
  }, []);
}
