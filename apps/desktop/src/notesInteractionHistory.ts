import type { NotesMutationHistoryEvent } from "./storeHistory";

export interface InteractionHistoryStore {
  readonly getSnapshot: () => {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
  };
  subscribeHistory(listener: (event: NotesMutationHistoryEvent) => void): () => void;
  flushAllDrafts(): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  breakHistoryGroup(): void;
}

type InteractionEntry<Location> =
  | { readonly kind: "mutation" }
  | {
      readonly kind: "navigation";
      readonly before: Location;
      readonly after: Location;
    };

const HISTORY_LIMIT = 1_000;

function pushBounded<T>(entries: T[], entry: T): void {
  entries.push(entry);
  if (entries.length > HISTORY_LIMIT) entries.shift();
}

export class NotesInteractionHistory<Location> {
  private readonly past: InteractionEntry<Location>[] = [];
  private readonly future: InteractionEntry<Location>[] = [];
  private readonly unsubscribe: () => void;
  private busy = false;
  private mutationFallbackEnabled = true;

  constructor(
    private readonly store: InteractionHistoryStore,
    private readonly applyNavigation: (location: Location) => Promise<void>
  ) {
    this.unsubscribe = store.subscribeHistory((event) => {
      if (event.kind === "resetMutations") {
        this.removeMutationEntries(this.past);
        this.removeMutationEntries(this.future);
        this.mutationFallbackEnabled = false;
      } else {
        this.mutationFallbackEnabled = true;
        pushBounded(this.past, { kind: "mutation" });
        this.future.length = 0;
      }
    });
  }

  dispose(): void {
    this.unsubscribe();
  }

  recordNavigation(before: Location, after: Location): void {
    this.store.breakHistoryGroup();
    pushBounded(this.past, { kind: "navigation", before, after });
    this.future.length = 0;
  }

  async undo(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.store.flushAllDrafts();
      const entry = this.past.at(-1) ??
        (this.mutationFallbackEnabled && this.store.getSnapshot().canUndo
          ? { kind: "mutation" }
          : null);
      if (!entry) return;
      if (entry.kind === "navigation") {
        await this.applyNavigation(entry.before);
      } else {
        await this.store.undo();
      }
      this.past.pop();
      pushBounded(this.future, entry);
    } finally {
      this.busy = false;
    }
  }

  async redo(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.store.flushAllDrafts();
      const entry = this.future.at(-1) ??
        (this.mutationFallbackEnabled && this.store.getSnapshot().canRedo
          ? { kind: "mutation" }
          : null);
      if (!entry) return;
      if (entry.kind === "navigation") {
        await this.applyNavigation(entry.after);
      } else {
        await this.store.redo();
      }
      this.future.pop();
      pushBounded(this.past, entry);
    } finally {
      this.busy = false;
    }
  }

  private removeMutationEntries(entries: InteractionEntry<Location>[]): void {
    const navigationEntries = entries.filter(
      (entry) => entry.kind === "navigation"
    );
    entries.splice(0, entries.length, ...navigationEntries);
  }
}
