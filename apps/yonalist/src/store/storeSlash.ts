import type { IpcMarkerKind } from "../../../../packages/contracts/generated/IpcMarkerKind";
import type { IpcNotesCommand } from "../../../../packages/contracts/generated/IpcNotesCommand";
import type { NotesState } from "../notesState";
import { confirmedText, freshId } from "./storeSupport";
import { omitKeys } from "./storeState";

interface SlashEditPort {
  readonly getState: () => NotesState;
  readonly cancelDraft: () => void;
  readonly setDraft: (text: string) => void;
  readonly setDrafts: (drafts: Readonly<Record<string, string>>) => void;
  readonly execute: (
    command: IpcNotesCommand,
    historyGroup: string
  ) => Promise<void>;
}

function sameMarker(
  marker: IpcMarkerKind,
  other: IpcMarkerKind | undefined
): boolean {
  if (typeof marker === "string" || typeof other !== "object") {
    return marker === other;
  }
  return marker.ordered.start === other.ordered.start;
}

export async function runSlashEdit(
  port: SlashEditPort,
  id: string,
  text: string,
  marker: IpcMarkerKind | null,
  // What `[x] ` asks for beyond the box itself. It rides the same group, so the
  // tick and the box the same keystroke put on come off in one undo.
  completed?: boolean
): Promise<void> {
  // Per invocation, not per row: the group is here to bind this command's text
  // and marker edits together, and a group keyed by the row alone folds the
  // next slash command on that row into the same undo step.
  const historyGroup = `slash:${freshId()}`;
  port.cancelDraft();
  port.setDraft(text);
  if (text !== confirmedText(port.getState(), id)) {
    await port.execute({ kind: "updateText", id, text }, historyGroup);
  }
  const confirmed = port.getState().nodes.find((node) => node.id === id);
  // A numbered marker carries its start, so the comparison is on the value, not
  // on the reference two snapshots of the same marker never share.
  if (marker && !sameMarker(marker, confirmed?.marker)) {
    await port.execute({ kind: "setMarker", id, marker }, historyGroup);
  }
  if (completed !== undefined && completed !== confirmed?.completed) {
    await port.execute({ kind: "setCompleted", id, completed }, historyGroup);
  }
  const state = port.getState();
  if (state.drafts[id] === text) {
    port.setDrafts(omitKeys(state.drafts, [id]));
  }
}
