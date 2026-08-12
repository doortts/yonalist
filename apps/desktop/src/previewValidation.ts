import type { IpcImportNode } from "../../../packages/contracts/generated/IpcImportNode";
import type { IpcNotesCommand } from "../../../packages/contracts/generated/IpcNotesCommand";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";

const IMAGE_CONTENT_HASH = /^[0-9a-f]{64}$/u;
// notes-core derives an asset's extension from these four and rejects the rest.
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp"
]);
const MAX_IMPORT_TEXT_BYTES = 100_000;

/** Answers whether the asset store still holds exactly those bytes. */
export type PreviewImageResidency = (
  contentHash: string,
  byteLength: number
) => boolean;

/**
 * Every check the Rust conversion runs before a row lands, so a paste the
 * desktop would refuse is refused here too — and refused before the caller
 * touches history, so a rejected paste leaves undo and redo alone.
 */
function validateImportedNode(
  node: IpcImportNode,
  holdsImage: PreviewImageResidency
): void {
  const encoder = new TextEncoder();
  if (
    encoder.encode(node.text).byteLength > MAX_IMPORT_TEXT_BYTES ||
    encoder.encode(node.note ?? "").byteLength > MAX_IMPORT_TEXT_BYTES
  ) {
    throw new Error("An imported title or note is too large.");
  }
  const image = node.image;
  if (!image) return;
  if (
    !IMAGE_CONTENT_HASH.test(image.contentHash) ||
    !IMAGE_MIME_TYPES.has(image.mimeType)
  ) {
    throw new Error("A pasted image reference is invalid.");
  }
  if (!holdsImage(image.contentHash, image.byteLength)) {
    throw new Error("A pasted image is no longer in the image store.");
  }
  // notes-core answers DomainError::InvalidImage here: an image node carries
  // its file name as text.
  if (node.text && node.text !== image.originalName) {
    throw new Error("an imported image node's text must be its file name");
  }
}

export function validatePreviewBatch(
  nodes: readonly NoteView[],
  command: IpcNotesCommand,
  holdsImage: PreviewImageResidency
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
        validateImportedNode(node, holdsImage);
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
