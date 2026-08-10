import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import {
  capturePane,
  paneScope,
  type PaneCaret
} from "./appNavigation";
import { resolveHistoryFocus } from "./historyFocus";
import { focusOutlineSnapshot } from "./outlineFocus";
import type { NotesMutationHistoryEvent } from "./storeHistory";

export interface InteractionHistoryStore {
  readonly getSnapshot: () => {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    readonly nodes: readonly NoteView[];
  };
  subscribeHistory(listener: (event: NotesMutationHistoryEvent) => void): () => void;
  setCaretCapture(capture: () => PaneCaret | null): void;
  flushAllDrafts(): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  breakHistoryGroup(): void;
}

type InteractionEntry<Location> =
  | {
      readonly kind: "mutation";
      /** The caret the command started from; undo puts it back. */
      readonly before: PaneCaret | null;
      /** Where the caret was when this step was undone; redo puts it back. */
      after: PaneCaret | null;
    }
  | {
      readonly kind: "navigation";
      readonly before: Location;
      readonly after: Location;
      /** Also replay the store step that moved the view. */
      readonly replaysStore?: boolean;
    };

const HISTORY_LIMIT = 1_000;

const PANE_IDS = ["primary", "secondary"] as const;

// Whichever pane holds the caret, if either does. capturePane already reports
// focus only for the pane containing document.activeElement, so the first hit
// is the one. Every command asks for this, so the cheap answer -- nothing is
// being edited -- comes before capturePane sweeps the panes.
function focusedPane(): PaneCaret | null {
  if (!(document.activeElement instanceof HTMLTextAreaElement)) return null;
  for (const paneId of PANE_IDS) {
    const { focus } = capturePane(paneId);
    if (focus) return { paneId, focus };
  }
  return null;
}

function pushBounded<T>(entries: T[], entry: T): void {
  entries.push(entry);
  if (entries.length > HISTORY_LIMIT) entries.shift();
}

export class NotesInteractionHistory<Location> {
  private readonly past: InteractionEntry<Location>[] = [];
  private readonly future: InteractionEntry<Location>[] = [];
  private readonly unsubscribe: () => void;
  private busy = false;

  constructor(
    private readonly store: InteractionHistoryStore,
    private readonly applyNavigation: (location: Location) => Promise<void>
  ) {
    this.unsubscribe = store.subscribeHistory((event) => {
      pushBounded(this.past, {
        kind: "mutation",
        before: event.caret,
        after: null
      });
      this.future.length = 0;
    });
    // The store asks for this at the command seam, before the mutation and
    // before the flush that precedes it.
    store.setCaretCapture(focusedPane);
  }

  dispose(): void {
    this.unsubscribe();
  }

  recordNavigation(before: Location, after: Location): void {
    this.record({ kind: "navigation", before, after });
  }

  /**
   * For the mutations that move the view themselves -- creating a page, moving
   * one to Trash. Those are one action, so the mutation entry the command has
   * already pushed folds into this one and a single Undo does both. Only the
   * caller knows the pair belongs together: a draft flushed on the way out
   * leaves the same mutation-then-navigation shape and must stay two steps.
   */
  recordMutationNavigation(before: Location, after: Location): void {
    if (this.past.at(-1)?.kind === "mutation") this.past.pop();
    this.record({ kind: "navigation", before, after, replaysStore: true });
  }

  private record(entry: InteractionEntry<Location>): void {
    this.store.breakHistoryGroup();
    pushBounded(this.past, entry);
    this.future.length = 0;
  }

  async undo(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.store.flushAllDrafts();
      const entry: InteractionEntry<Location> | null = this.past.at(-1) ??
        (this.store.getSnapshot().canUndo
          ? { kind: "mutation", before: null, after: null }
          : null);
      if (!entry) return;
      if (entry.kind === "navigation") {
        // The store step runs first either way: undoing "New page" must drop
        // the page before the view leaves it, and undoing a page deletion must
        // bring it back before the view returns to it.
        if (entry.replaysStore) await this.store.undo();
        await this.applyNavigation(entry.before);
      } else {
        // Where the action left the caret, which is what a redo owes back.
        entry.after = focusedPane();
        await this.replayStore(() => this.store.undo(), entry.before);
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
      const entry: InteractionEntry<Location> | null = this.future.at(-1) ??
        (this.store.getSnapshot().canRedo
          ? { kind: "mutation", before: null, after: null }
          : null);
      if (!entry) return;
      if (entry.kind === "navigation") {
        if (entry.replaysStore) await this.store.redo();
        await this.applyNavigation(entry.after);
      } else {
        await this.replayStore(() => this.store.redo(), entry.after);
      }
      this.future.pop();
      pushBounded(this.past, entry);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Runs a store history step and puts the caret back where the entry recorded
   * it. Only the mutation branch needs this -- a navigation entry carries its
   * own focus and applyNavigation restores it.
   *
   * `resolveHistoryFocus` is the fallback, not the source: it covers the entry
   * that recorded nothing (the caret was outside the outline when the command
   * ran) and the recorded row that the step itself removed.
   */
  private async replayStore(
    step: () => Promise<void>,
    recorded: PaneCaret | null
  ): Promise<void> {
    const live = focusedPane();
    const before = this.store.getSnapshot().nodes;
    await step();
    const caret = recorded ?? live;
    if (!caret) return;
    const next = resolveHistoryFocus(
      caret.focus, before, this.store.getSnapshot().nodes);
    if (!next) return;
    // Nothing recorded and the row survived: the DOM still holds that caret,
    // and refocusing would drag it back out from under the typist.
    if (!recorded && next === caret.focus) return;
    const scope = paneScope(caret.paneId);
    if (scope) focusOutlineSnapshot(scope, next);
  }
}
