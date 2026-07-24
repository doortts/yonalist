import type { NoteId } from "../../domain/notes";
import type { FlattenedOutlineRow } from "./outlineTree";

const OUTLINE_ROW_FIELDS = [
  "id",
  "parentId",
  "depth",
  "isCollapsed",
  "ancestorIds",
  "ancestorGuideDepths",
  "visibleDescendantEndId"
] as const satisfies readonly (keyof FlattenedOutlineRow)[];
const ALL_ROW_FIELDS_LISTED: Exclude<
  keyof FlattenedOutlineRow,
  (typeof OUTLINE_ROW_FIELDS)[number]
> extends never
  ? true
  : never = true;
void ALL_ROW_FIELDS_LISTED;

function equalIds(
  previous: readonly NoteId[],
  next: readonly NoteId[]
): boolean {
  return (
    previous.length === next.length &&
    previous.every((id, index) => id === next[index])
  );
}

function equalDepths(
  previous: readonly number[],
  next: readonly number[]
): boolean {
  return (
    previous.length === next.length &&
    previous.every((depth, index) => depth === next[index])
  );
}

function equalRow(
  previous: FlattenedOutlineRow,
  next: FlattenedOutlineRow
): boolean {
  return (
    previous.id === next.id &&
    previous.parentId === next.parentId &&
    previous.depth === next.depth &&
    previous.isCollapsed === next.isCollapsed &&
    equalIds(previous.ancestorIds, next.ancestorIds) &&
    equalDepths(
      previous.ancestorGuideDepths,
      next.ancestorGuideDepths
    ) &&
    previous.visibleDescendantEndId === next.visibleDescendantEndId
  );
}

export function retainOutlineRowProjection(
  previous: readonly FlattenedOutlineRow[],
  next: readonly FlattenedOutlineRow[]
): readonly FlattenedOutlineRow[] {
  const previousById = new Map(previous.map((row) => [row.id, row]));
  const retained = next.map((row) => {
    const previousRow = previousById.get(row.id);
    return previousRow && equalRow(previousRow, row) ? previousRow : row;
  });

  return previous.length === retained.length &&
    retained.every((row, index) => row === previous[index])
    ? previous
    : retained;
}
