import type { IpcNotesCommand } from "../../../../packages/contracts/generated/IpcNotesCommand";
import type { MutationReceipt } from "../../../../packages/contracts/generated/MutationReceipt";
import type { PaneSnapshot } from "../appNavigation";
import type { NotesApi } from "../api";
import type { NotesState } from "../notesState";
import {
  StoreHistoryEvents,
  type NotesMutationHistoryEvent
} from "./storeHistory";
import type { StoreInvalidation } from "./storeSubscriptions";
import { freshId, messageFrom } from "./storeSupport";

export interface StoreCommandHost {
  readonly read: () => NotesState;
  readonly write: (
    patch: Partial<NotesState>,
    invalidation: StoreInvalidation
  ) => void;
  readonly applyReceipt: (receipt: MutationReceipt) => void;
  readonly flushDrafts: () => Promise<void>;
  /**
   * Writes the page the user opened but has not written into yet, when the
   * command about to run is about that page. Called before anything else here,
   * so the creation takes the queue slot ahead of it. The image commands carry
   * no command object and pass none: those are always about the page in front
   * of the user.
   */
  readonly materializePage: (
    command?: IpcNotesCommand
  ) => Promise<void>;
  /**
   * The band and the caret as the app layer sees them right now. Injected the
   * same way `flushDrafts` is, so nothing in here has to reach into the DOM.
   */
  readonly capturePaneSnapshot: () => PaneSnapshot | null;
}

/**
 * Commands that carry the text they mean to write, so nothing may be flushed
 * ahead of them: the split and the two merges spell out both halves, and
 * `removeEmptyNode` is preceded by its own blanking edit under the same history
 * group. This is also what keeps the flush from recursing -- a flush IS an
 * `updateText`/`updateNote`, and both sit in here.
 */
const TEXT_OWNING_COMMANDS: ReadonlySet<IpcNotesCommand["kind"]> = new Set([
  "updateText",
  "updateNote",
  "splitNode",
  "mergeNodeBackward",
  "mergeNodeIntoParent",
  "removeEmptyNode"
]);

export interface ExternalCommandContext {
  readonly sessionId: string;
  readonly requestId: string;
  readonly baseRevision: number;
  readonly historyGroup: string | null;
}

export class StoreCommands {
  private readonly historyEvents = new StoreHistoryEvents();
  private commandQueue: Promise<void> = Promise.resolve();
  /**
   * Commands handed over but not finished yet, counted the moment they are
   * queued rather than when their turn comes -- `pendingWrites` only ever sees
   * the one command running, so it cannot tell a gesture's follow-up from a
   * fresh one. Zero means the queue has drained and the next command opens a
   * run of its own.
   */
  private queuedCommands = 0;

  constructor(
    private readonly api: NotesApi,
    private readonly host: StoreCommandHost
  ) {}

  readonly subscribeHistory = (
    listener: (event: NotesMutationHistoryEvent) => void
  ): (() => void) => this.historyEvents.subscribe(listener);

  breakHistoryGroup(): void {
    this.historyEvents.breakGroup();
  }

  execute(
    command: IpcNotesCommand,
    historyGroup: string | null = null,
    /**
     * The page's own creation passes `false`. The drafts waiting to be flushed
     * are the ones typed into the row this command is about to make, so
     * flushing first would send them ahead of it, to a row the backend has
     * never seen. They go out right behind it instead.
     */
    flushFirst = true
  ): Promise<MutationReceipt> {
    const created = this.host.materializePage(command);
    // Read before the flush below: a flush is itself a command, and its own
    // write can re-render the row out from under the caret this entry means to
    // remember.
    const pane = this.host.capturePaneSnapshot();
    // Kicked off synchronously, before this command is queued, so the drafts'
    // own `updateText`/`updateNote` take the earlier slots and the queue runs
    // them first. Awaiting it inside the operation only propagates its failure.
    const flushed = !flushFirst || TEXT_OWNING_COMMANDS.has(command.kind)
      ? null
      : this.host.flushDrafts();
    const scopedHistoryGroup = this.historyEvents.scopedGroup(historyGroup);
    return this.enqueue(async () => {
      await created;
      await flushed;
      const state = this.host.read();
      if (!state.sessionId) throw new Error("Notes session is not ready.");
      const previousUndoDepth = state.undoDepth;
      const receipt = await this.api.execute({
        sessionId: state.sessionId,
        requestId: freshId(),
        baseRevision: state.revision,
        historyGroup: scopedHistoryGroup,
        command
      });
      this.host.applyReceipt(receipt);
      this.historyEvents.record(
        scopedHistoryGroup,
        previousUndoDepth,
        receipt,
        pane
      );
      return receipt;
    });
  }

  executeExternal(
    operation: (
      context: ExternalCommandContext
    ) => Promise<MutationReceipt>,
    historyGroup: string | null = null,
    requestId: string = freshId()
  ): Promise<MutationReceipt> {
    const created = this.host.materializePage();
    const pane = this.host.capturePaneSnapshot();
    // Same choke point as `execute`, for the same reason: an image dropped
    // inside the text debounce would otherwise land ahead of the keystrokes
    // that preceded it and put the two in the wrong order in history. Nothing
    // here owns text, so none of it is exempt and a flush cannot recurse.
    const flushed = this.host.flushDrafts();
    const scopedHistoryGroup = this.historyEvents.scopedGroup(historyGroup);
    return this.enqueue(async () => {
      await created;
      await flushed;
      const state = this.host.read();
      if (!state.sessionId) throw new Error("Notes session is not ready.");
      const previousUndoDepth = state.undoDepth;
      const receipt = await operation({
        sessionId: state.sessionId,
        requestId,
        baseRevision: state.revision,
        historyGroup: scopedHistoryGroup
      });
      this.host.applyReceipt(receipt);
      this.historyEvents.record(
        scopedHistoryGroup,
        previousUndoDepth,
        receipt,
        pane
      );
      return receipt;
    });
  }

  executeHistory(direction: "undo" | "redo"): Promise<void> {
    return this.enqueue(async () => {
      const state = this.host.read();
      if (!state.sessionId) throw new Error("Notes session is not ready.");
      const receipt = await this.api[direction]({
        sessionId: state.sessionId,
        baseRevision: state.revision
      });
      this.host.applyReceipt(receipt);
      this.breakHistoryGroup();
    });
  }

  async settled(): Promise<void> {
    await this.commandQueue;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const opensRun = this.queuedCommands === 0;
    this.queuedCommands += 1;
    const queued = this.commandQueue.then(async () => {
      try {
        this.host.write({
          pendingWrites: this.host.read().pendingWrites + 1,
          // Only the command that opens a run clears the banner. A gesture
          // whose first command failed queued the rest of itself against a row
          // nothing made, and their own failures say nothing the user can act
          // on. Inside the `try`, so a throwing subscriber cannot leave the
          // count above zero and every later run unable to clear the banner.
          ...(opensRun ? { error: null } : {})
        }, { shell: true });
        return await operation();
      } catch (cause) {
        if (this.host.read().error === null) {
          this.host.write(
            { error: messageFrom(cause) },
            { shell: true }
          );
        }
        throw cause;
      } finally {
        this.queuedCommands -= 1;
        this.host.write({
          pendingWrites: Math.max(0, this.host.read().pendingWrites - 1)
        }, { shell: true });
      }
    });
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }
}
