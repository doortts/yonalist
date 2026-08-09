import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import {
  capturePane,
  paneScope,
  type PaneFocusSnapshot
} from "./appNavigation";
import { resolveHistoryFocus } from "./historyFocus";
import { focusOutlineEditorAt } from "./outlineFocus";
import type { NotesMutationHistoryEvent } from "./storeHistory";

export interface InteractionHistoryStore {
  readonly getSnapshot: () => {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    readonly nodes: readonly NoteView[];
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

const PANE_IDS = ["primary", "secondary"] as const;

// Whichever pane holds the caret, if either does. capturePane already reports
// focus only for the pane containing document.activeElement, so the first hit
// is the one.
function focusedPane(): {
  readonly scope: HTMLElement;
  readonly focus: PaneFocusSnapshot;
} | null {
  for (const paneId of PANE_IDS) {
    const scope = paneScope(paneId);
    const { focus } = capturePane(paneId);
    if (scope && focus) return { scope, focus };
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
    this.unsubscribe = store.subscribeHistory(() => {
      pushBounded(this.past, { kind: "mutation" });
      this.future.length = 0;
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
        (this.store.getSnapshot().canUndo ? { kind: "mutation" } : null);
      if (!entry) return;
      if (entry.kind === "navigation") {
        await this.applyNavigation(entry.before);
      } else {
        await this.replayStore(() => this.store.undo());
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
        (this.store.getSnapshot().canRedo ? { kind: "mutation" } : null);
      if (!entry) return;
      if (entry.kind === "navigation") {
        await this.applyNavigation(entry.after);
      } else {
        await this.replayStore(() => this.store.redo());
      }
      this.future.pop();
      pushBounded(this.past, entry);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Runs a store history step and puts the caret back when the step unmounted
   * the row that held it. Only the mutation branch needs this -- a navigation
   * entry carries its own focus and applyNavigation restores it.
   */
  private async replayStore(step: () => Promise<void>): Promise<void> {
    const pane = focusedPane();
    const before = this.store.getSnapshot().nodes;
    await step();
    if (!pane) return;
    const next = resolveHistoryFocus(
      pane.focus, before, this.store.getSnapshot().nodes);
    // An unchanged snapshot means the row survived and the DOM still holds
    // that caret; refocusing would drag it back out from under the typist.
    if (!next || next === pane.focus) return;
    focusOutlineEditorAt(pane.scope, next.nodeId, next.selectionStart);
  }
}
