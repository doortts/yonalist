import type { IpcNotesCommand } from "../../../packages/contracts/generated/IpcNotesCommand";
import type { NotesState } from "./notesState";
import { confirmedText } from "./storeSupport";
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

export async function runSlashEdit(
  port: SlashEditPort,
  id: string,
  text: string,
  marker: "todo" | null
): Promise<void> {
  const historyGroup = `slash:${id}`;
  port.cancelDraft();
  port.setDraft(text);
  if (text !== confirmedText(port.getState(), id)) {
    await port.execute({ kind: "updateText", id, text }, historyGroup);
  }
  const confirmedMarker = port.getState().nodes.find((node) => node.id === id)?.marker;
  if (marker && marker !== confirmedMarker) {
    await port.execute({ kind: "setMarker", id, marker }, historyGroup);
  }
  const state = port.getState();
  if (state.drafts[id] === text) {
    port.setDrafts(omitKeys(state.drafts, [id]));
  }
}
