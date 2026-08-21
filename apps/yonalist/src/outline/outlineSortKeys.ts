import type { NoteView } from "../../../../packages/contracts/generated/NoteView";

export const SORT_KEY_STEP = 4_294_967_296;

/**
 * Sibling order, which every surface that walks a parent's children sorts by.
 * The id breaks a tie: two rows can share a sortKey until the next rebalance,
 * and a comparator that stopped at the key would order them by however the
 * rows arrived.
 */
export const bySiblingOrder = (left: NoteView, right: NoteView): number =>
  left.sortKey - right.sortKey || left.id.localeCompare(right.id);

export interface SortKeyAllocation {
  readonly sortKey: number;
  readonly rebalancedSortKeys: ReadonlyMap<string, number>;
}

function sparseKey(
  previous: NoteView | undefined,
  next: NoteView | undefined
): number | null {
  if (!previous && !next) return SORT_KEY_STEP;
  if (!previous && next) {
    const candidate = next.sortKey - SORT_KEY_STEP;
    return Number.isSafeInteger(candidate) ? candidate : null;
  }
  if (previous && !next) {
    const candidate = previous.sortKey + SORT_KEY_STEP;
    return Number.isSafeInteger(candidate) ? candidate : null;
  }
  const gap = next!.sortKey - previous!.sortKey;
  if (!Number.isSafeInteger(gap) || gap <= 1) return null;
  const candidate = previous!.sortKey + Math.trunc(gap / 2);
  return Number.isSafeInteger(candidate) ? candidate : null;
}

export function allocateSiblingSortKey(
  nodes: readonly NoteView[],
  parentId: string,
  beforeId: string | null,
  excludeId?: string
): SortKeyAllocation {
  const siblings = nodes
    .filter((node) =>
      node.parentId === parentId &&
      node.id !== excludeId &&
      !node.deleted
    )
    .sort(bySiblingOrder);
  const requestedIndex = beforeId
    ? siblings.findIndex((node) => node.id === beforeId)
    : siblings.length;
  const insertionIndex = requestedIndex < 0 ? siblings.length : requestedIndex;
  const keysAreStrictIntegers = siblings.every((node, index) =>
    Number.isSafeInteger(node.sortKey) &&
    (index === 0 || siblings[index - 1]!.sortKey < node.sortKey)
  );
  const allocated = keysAreStrictIntegers
    ? sparseKey(siblings[insertionIndex - 1], siblings[insertionIndex])
    : null;
  if (allocated !== null) {
    return {
      sortKey: allocated,
      rebalancedSortKeys: new Map()
    };
  }

  const rebalancedSortKeys = new Map<string, number>();
  let sortKey = 0;
  let insertedSortKey = 0;
  for (let index = 0; index <= siblings.length; index += 1) {
    sortKey += SORT_KEY_STEP;
    if (index === insertionIndex) {
      insertedSortKey = sortKey;
      continue;
    }
    const siblingIndex = index < insertionIndex ? index : index - 1;
    rebalancedSortKeys.set(siblings[siblingIndex]!.id, sortKey);
  }
  return { sortKey: insertedSortKey, rebalancedSortKeys };
}

export function applyRebalancedSortKeys(
  nodes: readonly NoteView[],
  sortKeys: ReadonlyMap<string, number>
): readonly NoteView[] {
  if (sortKeys.size === 0) return nodes;
  return nodes.map((node) => {
    const sortKey = sortKeys.get(node.id);
    return sortKey === undefined ? node : { ...node, sortKey };
  });
}
