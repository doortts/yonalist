import type { ForestSnapshot } from "../../../../packages/contracts/generated/ForestSnapshot";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";

export function previewForest(
  nodes: readonly NoteView[],
  rootIds: readonly string[],
  limit: number,
  revision: number
): ForestSnapshot {
  const requested = new Set(rootIds);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const forest = nodes.filter((node) => {
    let current: NoteView | undefined = node;
    const visited = new Set<string>();
    while (current && visited.add(current.id)) {
      if (requested.has(current.id)) return true;
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return false;
  });
  return {
    revision,
    nodes: forest.slice(0, limit).map((node) => ({ ...node })),
    complete: forest.length <= limit && rootIds.every((id) => byId.has(id))
  };
}
