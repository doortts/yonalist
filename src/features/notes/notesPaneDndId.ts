import type { NoteId } from "../../domain/notes";
import type { NotesPaneId } from "./notesPaneSession";

export type NotesPaneDropZone = "row" | "before" | "inside" | "tail";

export interface ParsedNotesPaneDndId {
  readonly paneId: NotesPaneId;
  readonly nodeId: NoteId | null;
  readonly zone: NotesPaneDropZone;
}

export function notesPaneDndId(
  paneId: NotesPaneId,
  nodeId: NoteId | null,
  zone: NotesPaneDropZone
): string {
  return `${paneId}:${encodeURIComponent(nodeId ?? "")}:${zone}`;
}

export function parseNotesPaneDndId(
  value: string
): ParsedNotesPaneDndId | null {
  const parts = value.split(":");
  if (parts.length !== 3) return null;
  const [paneId, encodedNodeId, zone] = parts;
  if (paneId !== "primary" && paneId !== "secondary") return null;
  if (
    zone !== "row" &&
    zone !== "before" &&
    zone !== "inside" &&
    zone !== "tail"
  ) {
    return null;
  }
  let nodeId: string;
  try {
    nodeId = decodeURIComponent(encodedNodeId!);
  } catch {
    return null;
  }
  if (nodeId.length === 0 && zone !== "tail") return null;
  return {
    paneId,
    nodeId: nodeId.length === 0 ? null : nodeId,
    zone
  };
}
