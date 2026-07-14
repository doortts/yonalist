import { type RefObject, useLayoutEffect, useState } from "react";

function hasRenderedExpectedMarkdownBodies(
  root: HTMLElement | null,
  expectedMarkdownBodies: number
): boolean {
  if (expectedMarkdownBodies <= 0) {
    return true;
  }
  if (!root) {
    return false;
  }
  const renderedBodies = root.querySelectorAll(
    '[data-markdown-body="true"][data-markdown-rendered="true"]'
  );
  return renderedBodies.length >= expectedMarkdownBodies;
}

export function useDetailContentPaintReady(
  detailRootRef: RefObject<HTMLElement | null>,
  activeDetailKey: string | null,
  detailReady: boolean,
  expectedMarkdownBodies: number
): boolean {
  const [contentReady, setContentReady] = useState(false);

  useLayoutEffect(() => {
    setContentReady(false);
    if (!activeDetailKey || !detailReady) {
      return;
    }

    const root = detailRootRef.current;
    const checkReady = () => {
      setContentReady(
        hasRenderedExpectedMarkdownBodies(root, expectedMarkdownBodies)
      );
    };

    checkReady();
    if (hasRenderedExpectedMarkdownBodies(root, expectedMarkdownBodies)) {
      return;
    }
    if (!root || typeof MutationObserver === "undefined") {
      return;
    }

    const observer = new MutationObserver(checkReady);
    observer.observe(root, {
      attributeFilter: ["data-markdown-rendered"],
      attributes: true,
      childList: true,
      subtree: true
    });
    return () => observer.disconnect();
  }, [activeDetailKey, detailReady, detailRootRef, expectedMarkdownBodies]);

  return contentReady;
}
