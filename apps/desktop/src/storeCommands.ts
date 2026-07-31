import type { IpcNotesCommand } from "../../../packages/contracts/generated/IpcNotesCommand";
import type { IpcEditorCommand } from "../../../packages/contracts/generated/IpcEditorCommand";
import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";
import type { NotesApi } from "./api";
import type { NotesState } from "./notesState";
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
}

export interface ExternalCommandContext {
  readonly sessionId: string;
  readonly requestId: string;
  readonly baseRevision: number;
  readonly historyGroup: string | null;
}

export class StoreCommands {
  private readonly historyEvents = new StoreHistoryEvents();
  private commandQueue: Promise<void> = Promise.resolve();

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
    historyGroup: string | null = null
  ): Promise<MutationReceipt> {
    const scopedHistoryGroup = this.historyEvents.scopedGroup(historyGroup);
    return this.enqueue(async () => {
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
        receipt
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
    const scopedHistoryGroup = this.historyEvents.scopedGroup(historyGroup);
    return this.enqueue(async () => {
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
        receipt
      );
      return receipt;
    });
  }

  executeSessionOwned(
    commands: readonly IpcEditorCommand[],
    requestId: string
  ): Promise<MutationReceipt> {
    return this.enqueue(async () => {
      const state = this.host.read();
      if (!state.sessionId) throw new Error("Notes session is not ready.");
      const receipt = await this.api.execute({
        sessionId: state.sessionId,
        requestId,
        baseRevision: state.revision,
        historyGroup: null,
        command: {
          kind: "applyEditorBatch",
          commands: [...commands]
        }
      });
      this.host.applyReceipt(receipt);
      this.historyEvents.resetMutations();
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
    const queued = this.commandQueue.then(async () => {
      const state = this.host.read();
      this.host.write({
        pendingWrites: state.pendingWrites + 1,
        error: null
      }, { shell: true });
      try {
        return await operation();
      } catch (cause) {
        this.host.write(
          { error: messageFrom(cause) },
          { shell: true }
        );
        throw cause;
      } finally {
        this.host.write({
          pendingWrites: Math.max(0, this.host.read().pendingWrites - 1)
        }, { shell: true });
      }
    });
    this.commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }
}
