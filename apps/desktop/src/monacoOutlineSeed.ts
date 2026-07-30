import type { NoteView } from "../../../packages/contracts/generated/NoteView";

export function shouldSeedMonacoOutline(
  projectedLineCount: number,
  nodes: readonly NoteView[],
  rootId: string
): boolean {
  return projectedLineCount === 0 &&
    !nodes.some((node) => !node.deleted && node.parentId === rootId);
}
