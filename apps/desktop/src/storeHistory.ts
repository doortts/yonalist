import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";
import type { PaneCaret } from "./appNavigation";

export interface NotesMutationHistoryEvent {
  readonly kind: "recordMutation";
  readonly undoDepth: number;
  readonly redoDepth: number;
  /**
   * Where the caret sat before the first command of this entry ran, so undo
   * can put it back instead of guessing. Null when nothing in the outline held
   * it -- a menu click, a flush after blur.
   */
  readonly caret: PaneCaret | null;
}

export class StoreHistoryEvents {
  private readonly listeners =
    new Set<(event: NotesMutationHistoryEvent) => void>();
  private fence = 0;
  private lastCommittedGroup: string | null = null;

  readonly subscribe = (
    listener: (event: NotesMutationHistoryEvent) => void
  ): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  breakGroup(): void {
    this.fence += 1;
    this.lastCommittedGroup = null;
  }

  scopedGroup(group: string | null): string | null {
    if (group === null || this.fence === 0) return group;
    return `${group}:${this.fence}`;
  }

  record(
    group: string | null,
    previousUndoDepth: number,
    receipt: MutationReceipt,
    caret: PaneCaret | null
  ): void {
    const coalesced = group !== null &&
      group === this.lastCommittedGroup &&
      receipt.history.undoDepth === previousUndoDepth;
    // Only the first command of a group emits, so a coalesced typing run keeps
    // the caret that run started from rather than the latest keystroke's.
    if (!coalesced) {
      this.listeners.forEach((listener) => listener({
        kind: "recordMutation",
        undoDepth: receipt.history.undoDepth,
        redoDepth: receipt.history.redoDepth,
        caret
      }));
    }
    this.lastCommittedGroup = group;
  }
}
