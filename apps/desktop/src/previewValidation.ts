import type { IpcNotesCommand } from "../../../packages/contracts/generated/IpcNotesCommand";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";

export function validatePreviewBatch(
  nodes: readonly NoteView[],
  command: IpcNotesCommand
): void {
  const existing = new Set(nodes.map((node) => node.id));
  const requireIds = (ids: readonly string[]) => {
    if (ids.some((id) => !existing.has(id))) {
      throw new Error("Preview batch contains a stale node.");
    }
  };
  switch (command.kind) {
    case "importNodes": {
      if (!existing.has(command.parent_id)) throw new Error("Preview parent is stale.");
      const available = new Set(existing);
      for (const node of command.nodes) {
        if (available.has(node.id) || !available.has(node.parentId)) {
          throw new Error("Preview import is invalid.");
        }
        available.add(node.id);
      }
      break;
    }
    case "moveNodes":
      requireIds(command.moves.flatMap((move) => [move.id, move.parentId]));
      break;
    case "mergeNodeBackward": {
      requireIds([command.id, command.previous_id]);
      const current = nodes.find((node) => node.id === command.id)!;
      const previous = nodes.find((node) => node.id === command.previous_id)!;
      const siblings = nodes
        .filter((node) =>
          node.parentId === current.parentId &&
          !node.deleted
        )
        .sort((left, right) =>
          left.sortKey - right.sortKey || left.id.localeCompare(right.id)
        );
      const currentIndex = siblings.findIndex((node) => node.id === current.id);
      const eligible = current.parentId !== null &&
        previous.parentId === current.parentId &&
        previous.note.trim().length === 0 &&
        !nodes.some((node) => node.parentId === previous.id && !node.deleted) &&
        currentIndex > 0 &&
        siblings[currentIndex - 1]?.id === previous.id;
      if (!eligible) throw new Error("Preview backward merge is invalid.");
      break;
    }
    case "duplicateNodes":
      requireIds(command.duplicates.flatMap((duplicate) => [
        duplicate.id,
        duplicate.parentId
      ]));
      if (command.duplicates.some((duplicate) => existing.has(duplicate.newId))) {
        throw new Error("Preview duplicate ID already exists.");
      }
      break;
    case "setCompletedMany":
    case "deleteSubtrees":
      requireIds(command.ids);
      break;
  }
}
