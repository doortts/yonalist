export const OUTLINE_WINDOW_INITIAL_COUNT = 60;
export const OUTLINE_WINDOW_BATCH_COUNT = 60;
export const OUTLINE_WINDOW_ESTIMATED_ROW_HEIGHT = 28;

export interface ProgressiveOutlineWindow {
  readonly renderedCount: number;
  readonly remainingCount: number;
  readonly spacerHeight: number;
}

function count(value: number): number {
  return Math.max(0, Math.floor(value));
}

export function initialOutlineWindowCount(total: number): number {
  return Math.min(count(total), OUTLINE_WINDOW_INITIAL_COUNT);
}

export function advanceOutlineWindow(
  current: number,
  total: number
): number {
  const boundedTotal = count(total);
  return Math.min(
    boundedTotal,
    Math.max(count(current), initialOutlineWindowCount(boundedTotal)) +
      OUTLINE_WINDOW_BATCH_COUNT
  );
}

export function materializeOutlineThrough(
  current: number,
  targetIndex: number,
  total: number
): number {
  const boundedTotal = count(total);
  const targetCount = Math.ceil(
    (Math.max(0, Math.floor(targetIndex)) + 1) /
      OUTLINE_WINDOW_BATCH_COUNT
  ) * OUTLINE_WINDOW_BATCH_COUNT;
  return Math.min(
    boundedTotal,
    Math.max(count(current), initialOutlineWindowCount(boundedTotal), targetCount)
  );
}

export function describeOutlineWindow(
  rendered: number,
  total: number,
  estimatedRowHeight = OUTLINE_WINDOW_ESTIMATED_ROW_HEIGHT
): ProgressiveOutlineWindow {
  const boundedTotal = count(total);
  const renderedCount = Math.min(count(rendered), boundedTotal);
  const remainingCount = boundedTotal - renderedCount;
  return {
    renderedCount,
    remainingCount,
    spacerHeight: remainingCount * Math.max(0, estimatedRowHeight)
  };
}
