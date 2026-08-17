import type { NotesState } from "../notesState";
import type { StoreCommands } from "./storeCommands";
import type { StoreInvalidation } from "./storeSubscriptions";
import {
  cancelTimer,
  confirmedNote,
  confirmedText,
  DRAFT_DEBOUNCE_MS,
  titleHistoryGroup,
  TYPING_IDLE_MS
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
  private readonly typingRuns = new Map<string, number>();
  private activeBackspaceGroup: string | null = null;
  private backspaceSequence = 0;

  constructor(private readonly host: StoreDraftHost) {}

  /**
   * One typing run is one undo step. The run stays open while the keystrokes
   * keep coming and closes on the first long pause, so ⌘Z gives back the last
   * thing typed rather than everything typed since the row was opened.
   */
  private continueTypingRun(key: string): void {
    const now = Date.now();
    const last = this.typingRuns.get(key);
    this.typingRuns.set(key, now);
    if (last !== undefined && now - last <= TYPING_IDLE_MS) return;
    this.host.breakHistoryGroup();
  }

  /**
   * Leaving the field closes the run too. Forgetting it is enough -- the fence
   * only has to move before the next commit, and moving it here would split a
   * Backspace gesture, whose focus hop fires blur in the middle of the run.
   */
  endTypingRun(id: string): void {
    this.typingRuns.delete(`text:${id}`);
    this.typingRuns.delete(`note:${id}`);
  }

  setTitle(id: string, text: string): void {
    if (this.activeBackspaceGroup) {
      this.titleHistoryGroups.set(id, this.activeBackspaceGroup);
    } else {
      this.titleHistoryGroups.delete(id);
      this.continueTypingRun(`text:${id}`);
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
    if (submittedText === undefined) return;
    // A draft equal to the committed text needs no command, but it still has
    // to go: the row renders the draft over the node, so one left behind here
    // outlives the next undo and the keystroke after it commits it back.
    if (submittedText !== confirmedText(state, id)) {
      const historyGroup =
        this.titleHistoryGroups.get(id) ?? titleHistoryGroup(id);
      await this.host.execute(
        { kind: "updateText", id, text: submittedText },
        historyGroup
      );
    }
    const current = this.host.read();
    if (current.drafts[id] === submittedText) {
      const drafts = { ...current.drafts };
      delete drafts[id];
      this.titleHistoryGroups.delete(id);
      this.host.write({ drafts }, { nodeIds: [id] });
    }
  }

  setNote(id: string, note: string): void {
    this.continueTypingRun(`note:${id}`);
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

  /**
   * Submits every pending draft without waiting on the command queue. The
   * command choke point calls this, and the queue by then already holds the
   * command that asked for the flush -- waiting on it here would deadlock.
   */
  flushPending(): Promise<void> {
    const state = this.host.read();
    return Promise.all([
      ...Object.keys(state.drafts).map((id) => this.flushTitle(id)),
      ...Object.keys(state.noteDrafts).map((id) => this.flushNote(id))
    ]).then(() => undefined);
  }

  async flushAll(): Promise<void> {
    await this.flushPending();
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
      this.endTypingRun(id);
    });
  }
}
