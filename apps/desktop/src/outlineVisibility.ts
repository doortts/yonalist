import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { OutlineIndex } from "./outlineIndex";

export function hideCompletedSubtrees(
  nodes: readonly NoteView[],
  pageId: string,
  index: OutlineIndex
): readonly NoteView[] {
  let hiddenDepth: number | null = null;
  return nodes.filter((node) => {
    const depth = index.depthOf(node.id, pageId);
    if (hiddenDepth !== null) {
      if (depth > hiddenDepth) return false;
      hiddenDepth = null;
    }
    if (!node.completed) return true;
    hiddenDepth = depth;
    return false;
  });
}

export function hideCollapsedSubtrees(
  nodes: readonly NoteView[],
  pageId: string,
  index: OutlineIndex
): readonly NoteView[] {
  let hiddenDepth: number | null = null;
  return nodes.filter((node) => {
    const depth = index.depthOf(node.id, pageId);
    if (hiddenDepth !== null) {
      if (depth > hiddenDepth) return false;
      hiddenDepth = null;
    }
    if (node.collapsed) hiddenDepth = depth;
    return true;
  });
}
