export const OUTLINE_MINIMUM_ROW_HEIGHT = 28;
const OUTLINE_SCROLL_QUANTUM = 48;
const OUTLINE_CHUNK_SIZE = 24;

export function projectOutlinePrefix(
  totalRows: number,
  viewportHeight: number,
  scrollTop: number,
  targetExpandedLimit = 0,
) {
  const rows = Math.max(0, Math.floor(totalRows));
  const viewportRows = Math.ceil(
    Math.max(0, viewportHeight) / OUTLINE_MINIMUM_ROW_HEIGHT,
  );
  const roundedScroll =
    OUTLINE_SCROLL_QUANTUM *
    Math.ceil(Math.max(0, scrollTop) / OUTLINE_SCROLL_QUANTUM);
  const requestedLimit =
    viewportRows +
    OUTLINE_CHUNK_SIZE *
      Math.ceil(
        roundedScroll /
          (OUTLINE_MINIMUM_ROW_HEIGHT * OUTLINE_CHUNK_SIZE),
      );
  const limit = Math.min(
    rows,
    Math.max(requestedLimit, Math.max(0, targetExpandedLimit)),
  );
  return {
    limit,
    tailHeight: (rows - limit) * OUTLINE_MINIMUM_ROW_HEIGHT,
  } as const;
}
