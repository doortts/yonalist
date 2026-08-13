import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import {
  capturePane,
  paneScope,
  type PaneSnapshot
} from "./appNavigation";
import { liveHistorySelection, resolveHistoryFocus } from "./historyFocus";
import { focusOutlineSnapshot } from "./outlineFocus";
import { outlinePane } from "./outlinePaneRegistry";
import type { NotesMutationHistoryEvent } from "./storeHistory";

export interface InteractionHistoryStore {
  readonly getSnapshot: () => {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    readonly nodes: readonly NoteView[];
  };
  subscribeHistory(listener: (event: NotesMutationHistoryEvent) => void): () => void;
  setPaneCapture(capture: () => PaneSnapshot | null): void;
  flushAllDrafts(): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  breakHistoryGroup(): void;
}

type InteractionEntry<Location> =
  | {
      readonly kind: "mutation";
      /** The band and caret the command started from; undo puts them back. */
      readonly before: PaneSnapshot | null;
      /** What the pane held when this step was undone; redo puts it back. */
      after: PaneSnapshot | null;
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

/**
 * The pane a command is about: the one holding the caret, or -- when a toolbar
 * button has taken focus out of the outline -- the one holding a band. The
 * caret wins, because a split can have the band in one pane and the typist in
 * the other, and the caret is the half every command has.
 *
 * Between two banded panes the button that was pressed decides, since the
 * action bar renders inside its own pane's section: a leftover band in the other
 * pane would otherwise win by pane order alone, and the split's live band would
 * never come back. Only a split with a band in both panes and focus outside
 * both is left to pane order.
 *
 * Null only when the outline holds neither, which is history's signal to leave
 * both alone rather than restore an empty pane over a live one.
 */
function activePane(): PaneSnapshot | null {
  const panes = PANE_IDS.map((paneId) => capturePane(paneId));
  const active = document.activeElement;
  const pressed = active && PANE_IDS.find(
    (paneId) => paneScope(paneId)?.contains(active));
  return panes.find((pane) => pane.focus) ??
    panes.find((pane) =>
      pane.paneId === pressed && pane.selectedIds.length > 0) ??
    panes.find((pane) => pane.selectedIds.length > 0) ??
    null;
}

function pushBounded<T>(entries: T[], entry: T): void {
  entries.push(entry);
  if (entries.length > HISTORY_LIMIT) entries.shift();
}

export class NotesInteractionHistory<Location> {
  private readonly past: InteractionEntry<Location>[] = [];
  private readonly future: InteractionEntry<Location>[] = [];
  private busy = false;

  constructor(
    private readonly store: InteractionHistoryStore,
    private readonly applyNavigation: (location: Location) => Promise<void>
  ) {}

  /**
   * Subscribes, and returns the teardown. This belongs to an effect and not to
   * the constructor: StrictMode double-invokes render, so a constructor that
   * subscribes leaves the discarded instance listening while the one the app
   * actually undoes through gets torn down -- deaf, with an empty `past`, and
   * every undo falling back to guessing the caret.
   */
  connect(): () => void {
    // The store asks for this at the command seam, before the mutation and
    // before the flush that precedes it.
    this.store.setPaneCapture(activePane);
    return this.store.subscribeHistory((event) => {
      pushBounded(this.past, {
        kind: "mutation",
        before: event.pane,
        after: null
      });
      this.future.length = 0;
    });
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
        // What the action left behind, which is what a redo owes back -- a cut
        // left no band, so redoing it takes the restored one away again.
        entry.after = activePane();
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
   * Runs a store history step and puts the band and the caret back where the
   * entry recorded them. Only the mutation branch needs this -- a navigation
   * entry carries its own selection and focus, and applyNavigation restores
   * both through the pane's restore request.
   *
   * `resolveHistoryFocus` is the fallback, not the source: it covers the entry
   * that recorded nothing (the caret was outside the outline when the command
   * ran) and the recorded row that the step itself removed.
   */
  private async replayStore(
    step: () => Promise<void>,
    recorded: PaneSnapshot | null
  ): Promise<void> {
    const live = activePane();
    const before = this.store.getSnapshot().nodes;
    await step();
    const after = this.store.getSnapshot().nodes;
    // Only the recorded band goes back, and it goes back first: `live` is the
    // band already up, which re-applying would only fight, and the caret placed
    // below has to be the last word over the render this schedules. An entry
    // that recorded nothing at all leaves a band raised since then standing --
    // it has no empty band of its own to clear one with.
    const bandScope = recorded && paneScope(recorded.paneId);
    if (recorded && bandScope) {
      outlinePane(bandScope)?.replaceSelection(
        liveHistorySelection(recorded.selectedIds, after));
    }
    // The two halves are taken apart, not chosen between: a toolbar command
    // records a band and no caret, because the button owns focus, and the live
    // caret is then the only one there is to repair.
    const caretFrom = recorded?.focus ? recorded : live ?? recorded;
    if (!caretFrom) return;
    const next = resolveHistoryFocus(caretFrom.focus, before, after);
    if (!next) return;
    // The caret was borrowed and its row survived: the DOM still holds it, and
    // refocusing would drag it back out from under the typist.
    if (caretFrom !== recorded && next === caretFrom.focus) return;
    const caretScope = paneScope(caretFrom.paneId);
    if (caretScope) focusOutlineSnapshot(caretScope, next);
  }
}
