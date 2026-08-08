import type { NotesState } from "./notesState";
import type { StoreCommands } from "./storeCommands";
import type { StoreInvalidation } from "./storeSubscriptions";
import {
  cancelTimer,
  confirmedNote,
  confirmedText,
  DRAFT_DEBOUNCE_MS
} from "./storeSupport";

export interface StoreDraftHost {
  readonly read: () => NotesState;
  readonly write: (
    patch: Partial<NotesState>,
    invalidation: StoreInvalidation
  ) => void;
  readonly execute: StoreCommands["execute"];
  readonly settled: StoreCommands["settled"];
  readonly breakHistoryGroup: () => void;
}

export class StoreDrafts {
  private readonly titleTimers =
    new Map<string, ReturnType<typeof setTimeout>>();
  private readonly noteTimers =
    new Map<string, ReturnType<typeof setTimeout>>();
  private readonly titleHistoryGroups = new Map<string, string>();
  private activeBackspaceGroup: string | null = null;
  private backspaceSequence = 0;

  constructor(private readonly host: StoreDraftHost) {}

  setTitle(id: string, text: string): void {
    if (this.activeBackspaceGroup) {
      this.titleHistoryGroups.set(id, this.activeBackspaceGroup);
    } else {
      this.titleHistoryGroups.delete(id);
    }
    const state = this.host.read();
    this.host.write(
      { drafts: { ...state.drafts, [id]: text } },
      { nodeIds: [id] }
    );
    this.cancelTitle(id);
    this.titleTimers.set(id, setTimeout(
      () => void this.flushTitle(id),
      DRAFT_DEBOUNCE_MS
    ));
  }

  async flushTitle(id: string): Promise<void> {
    this.cancelTitle(id);
    const state = this.host.read();
    const submittedText = state.drafts[id];
    if (
      submittedText === undefined ||
      submittedText === confirmedText(state, id)
    ) {
      return;
    }
    // An image node's text is its filename, which the domain refuses to
    // change. Every surface routes its title writes through here, so this is
    // the one place that can keep such a draft from reaching the backend.
    if (state.nodes.find((node) => node.id === id)?.kind === "image") {
      const { [id]: _discarded, ...drafts } = state.drafts;
      this.host.write({ drafts }, { nodeIds: [id] });
      return;
    }
    const historyGroup = this.titleHistoryGroups.get(id) ?? `text:${id}`;
    await this.host.execute(
      { kind: "updateText", id, text: submittedText },
      historyGroup
    );
    const current = this.host.read();
    if (current.drafts[id] === submittedText) {
      const drafts = { ...current.drafts };
      delete drafts[id];
      this.titleHistoryGroups.delete(id);
      this.host.write({ drafts }, { nodeIds: [id] });
    }
  }

  setNote(id: string, note: string): void {
    const state = this.host.read();
    this.host.write(
      { noteDrafts: { ...state.noteDrafts, [id]: note } },
      { nodeIds: [id] }
    );
    this.cancelNote(id);
    this.noteTimers.set(id, setTimeout(
      () => void this.flushNote(id),
      DRAFT_DEBOUNCE_MS
    ));
  }

  async flushNote(id: string): Promise<void> {
    this.cancelNote(id);
    const state = this.host.read();
    const submittedNote = state.noteDrafts[id];
    if (submittedNote === undefined) return;
    if (submittedNote !== confirmedNote(state, id)) {
      await this.host.execute(
        { kind: "updateNote", id, note: submittedNote },
        `note:${id}`
      );
    }
    const current = this.host.read();
    if (current.noteDrafts[id] === submittedNote) {
      const noteDrafts = { ...current.noteDrafts };
      delete noteDrafts[id];
      this.host.write({ noteDrafts }, { nodeIds: [id] });
    }
  }

  async flushAll(): Promise<void> {
    const state = this.host.read();
    await Promise.all([
      ...Object.keys(state.drafts).map((id) => this.flushTitle(id)),
      ...Object.keys(state.noteDrafts).map((id) => this.flushNote(id))
    ]);
    await this.host.settled();
  }

  beginBackspace(repeat: boolean): string {
    if (!repeat || this.activeBackspaceGroup === null) {
      this.host.breakHistoryGroup();
      this.backspaceSequence += 1;
      this.activeBackspaceGroup = `backspace:${this.backspaceSequence}`;
    }
    return this.activeBackspaceGroup;
  }

  endBackspace(): void {
    this.activeBackspaceGroup = null;
  }

  cancelTitle(id: string): void {
    cancelTimer(this.titleTimers, id);
  }

  cancelNote(id: string): void {
    cancelTimer(this.noteTimers, id);
  }

  cancel(ids: readonly string[]): void {
    ids.forEach((id) => {
      this.cancelTitle(id);
      this.cancelNote(id);
      this.titleHistoryGroups.delete(id);
    });
  }
}
