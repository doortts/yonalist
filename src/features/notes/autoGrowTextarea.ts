import { type RefObject, useEffect, useLayoutEffect } from "react";

const observedWidths = new Map<HTMLTextAreaElement, number>();
let sharedObserver: ResizeObserver | null = null;

export function resizeTextarea(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) {
    return;
  }
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function getSharedObserver(): ResizeObserver | null {
  if (typeof ResizeObserver === "undefined") {
    return null;
  }
  if (sharedObserver) {
    return sharedObserver;
  }

  sharedObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const textarea = entry.target as HTMLTextAreaElement;
      const width = entry.contentRect.width;
      const previousWidth = observedWidths.get(textarea);
      if (
        previousWidth !== undefined &&
        Math.abs(previousWidth - width) < 0.5
      ) {
        continue;
      }
      observedWidths.set(textarea, width);
      resizeTextarea(textarea);
    }
  });
  return sharedObserver;
}

function observeWidth(textarea: HTMLTextAreaElement): () => void {
  const observer = getSharedObserver();
  if (!observer) {
    return () => undefined;
  }
  observedWidths.set(textarea, textarea.getBoundingClientRect().width);
  observer.observe(textarea);

  return () => {
    observer.unobserve(textarea);
    observedWidths.delete(textarea);
    if (observedWidths.size === 0) {
      observer.disconnect();
      if (sharedObserver === observer) {
        sharedObserver = null;
      }
    }
  };
}

export function useAutoGrowTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  active = true
): void {
  useLayoutEffect(() => {
    if (active) {
      resizeTextarea(ref.current);
    }
  }, [active, ref, value]);

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const textarea = ref.current;
    return textarea ? observeWidth(textarea) : undefined;
  }, [active, ref]);
}
