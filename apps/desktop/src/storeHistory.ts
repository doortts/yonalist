import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";

export interface NotesMutationHistoryEvent {
  readonly kind: "recordMutation";
  readonly undoDepth: number;
  readonly redoDepth: number;
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
    receipt: MutationReceipt
  ): void {
    const coalesced = group !== null &&
      group === this.lastCommittedGroup &&
      receipt.history.undoDepth === previousUndoDepth;
    if (!coalesced) {
      this.listeners.forEach((listener) => listener({
        kind: "recordMutation",
        undoDepth: receipt.history.undoDepth,
        redoDepth: receipt.history.redoDepth
      }));
    }
    this.lastCommittedGroup = group;
  }
}
