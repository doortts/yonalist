import { useEffect, useRef, useState, type ReactNode } from "react";
import "./sticky-title.css";

/**
 * Walks up from `node` to the nearest scrollable ancestor so the observer can
 * use it as its root. This aligns the "header left the viewport" moment with
 * the point where the sticky bar actually pins (the top of the scroll
 * container), rather than the browser viewport, which may sit further up.
 */
function findScrollParent(node: HTMLElement | null): HTMLElement | null {
  let current = node?.parentElement ?? null;
  while (current) {
    const { overflowY } = getComputedStyle(current);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

interface StickyTitleProps {
  /** Title text shown in the thin bar once the header scrolls away. */
  title: string;
  /** The original detail header; rendered in normal flow above the sentinel. */
  children: ReactNode;
}

/**
 * Wraps a detail header and reveals a thin, title-only bar pinned to the top of
 * the scroll container once the real header scrolls out of view. Only the title
 * text appears in the bar — no badges, buttons, or meta — and it is hidden from
 * assistive tech since it duplicates the header heading.
 *
 * A zero-height sticky slot sits above the header so the bar can overflow it
 * without ever taking layout space (the body never shifts while the header is
 * visible). A zero-height sentinel placed just below the header is observed;
 * when it leaves the scroll root, the header is gone and the bar is shown.
 */
export function StickyTitle({ title, children }: StickyTitleProps) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) {
          // Sentinel visible → header still on screen → hide the bar.
          setVisible(!entry.isIntersecting);
        }
      },
      { root: findScrollParent(sentinel), threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div className="sticky-title-slot" aria-hidden="true">
        {visible && (
          <div className="sticky-title-bar">
            <span className="sticky-title-text">{title}</span>
          </div>
        )}
      </div>
      {children}
      <div ref={sentinelRef} className="sticky-title-sentinel" aria-hidden="true" />
    </>
  );
}
