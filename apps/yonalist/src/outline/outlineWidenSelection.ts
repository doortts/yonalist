import type { NoteView } from "../../../../packages/contracts/generated/NoteView";

/**
 * The next rung of the band's widening ladder, or `null` once it holds every
 * row the outline is showing.
 *
 * The ladder is read off the band itself rather than counted: a band holding
 * every child of one parent has that parent as its next rung, and any other
 * band has the siblings of the rung it stands on. So the rungs run the row
 * itself, its siblings, their parent, its siblings, and on to the top -- and a
 * band the mouse drew joins the ladder wherever it happens to stand.
 *
 * `fallbackNodeId` is the row the key came from, and with no band up it is the
 * first rung on its own: the row and the children that come with it. Roots at
 * mixed depths take the shallowest one, since widening from a deeper root would
 * hand rows back that the band already holds.
 */
export function widenOutlineSelection(
  visibleNodes: readonly NoteView[],
  rootIds: readonly string[],
  fallbackNodeId: string,
  outlineRootId: string
): readonly string[] | null {
  const byId = new Map(visibleNodes.map((node) => [node.id, node]));
  const depthOf = (id: string): number => {
    let depth = 0;
    let current = byId.get(id);
    const seen = new Set<string>();
    while (current?.parentId && seen.add(current.id)) {
      const parent = byId.get(current.parentId);
      if (!parent) break;
      depth += 1;
      current = parent;
    }
    return depth;
  };
  if (rootIds.length === 0) {
    return byId.has(fallbackNodeId) ? [fallbackNodeId] : null;
  }
  const standing = rootIds
    .map((id) => byId.get(id))
    .filter((node): node is NoteView => node !== undefined)
    .reduce<NoteView | undefined>(
      (shallowest, node) => !shallowest ||
        depthOf(node.id) < depthOf(shallowest.id)
        ? node
        : shallowest,
      undefined
    );
  if (!standing) return null;
  const parentId = standing.parentId ?? outlineRootId;
  const siblings = visibleNodes
    .filter((node) => (node.parentId ?? outlineRootId) === parentId)
    .map((node) => node.id);
  const holdsEveryone = rootIds.length === siblings.length &&
    rootIds.every((id) => siblings.includes(id));
  if (!holdsEveryone) return siblings;
  return parentId === outlineRootId ? null : [parentId];
}
