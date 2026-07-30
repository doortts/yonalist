const MIN_ROW_HEIGHT = 20;
const MAX_ROW_HEIGHT = 240;

export function measuredOutlineRowHeight(
  renderedHeight: number,
  renderedCount: number
): number {
  if (renderedCount <= 0 || !Number.isFinite(renderedHeight)) return 28;
  return Math.round(Math.min(
    MAX_ROW_HEIGHT,
    Math.max(MIN_ROW_HEIGHT, renderedHeight / renderedCount)
  ));
}

export function observeProgressiveOutline({
  root,
  sentinel,
  list,
  advance,
  renderedCount,
  spacerHeight,
  remainingCount
}: {
  readonly root: HTMLElement;
  readonly sentinel: HTMLElement;
  readonly list: HTMLOListElement;
  readonly advance: () => void;
  readonly renderedCount: number;
  readonly spacerHeight: number;
  readonly remainingCount: number;
}): () => void {
  const dispose: Array<() => void> = [];
  if (typeof IntersectionObserver === "undefined") {
    const handleScroll = () => {
      const remaining =
        root.scrollHeight - root.scrollTop - root.clientHeight;
      if (remaining <= 560) advance();
    };
    root.addEventListener("scroll", handleScroll, { passive: true });
    dispose.push(() => root.removeEventListener("scroll", handleScroll));
  } else {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) advance();
    }, {
      root,
      rootMargin: "0px 0px 560px 0px"
    });
    observer.observe(sentinel);
    dispose.push(() => observer.disconnect());
  }

  if (renderedCount > 0 && typeof ResizeObserver !== "undefined") {
    let currentSpacerHeight = spacerHeight;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      currentSpacerHeight = remainingCount * measuredOutlineRowHeight(
        Math.max(0, entry.contentRect.height - currentSpacerHeight),
        renderedCount
      );
      sentinel.style.height = `${currentSpacerHeight}px`;
    });
    observer.observe(list);
    dispose.push(() => observer.disconnect());
  }
  return () => dispose.forEach((release) => release());
}
