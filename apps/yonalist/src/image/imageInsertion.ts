import type { OutlineIndex } from "../outline/outlineIndex";

export interface ImageInsertionAnchor {
  readonly parentId: string;
  readonly beforeId: string | null;
}

export function imageInsertionAnchor(
  targetId: string,
  outlineRootId: string,
  index: OutlineIndex
): ImageInsertionAnchor | null {
  if (targetId === outlineRootId) {
    const root = index.node(outlineRootId);
    if (root?.deleted) return null;
    return {
      parentId: outlineRootId,
      beforeId: index.firstChildId(outlineRootId)
    };
  }
  const target = index.node(targetId);
  if (!target || target.deleted || !target.parentId) return null;
  return {
    parentId: target.parentId,
    beforeId: index.nextSiblingId(target.id)
  };
}
