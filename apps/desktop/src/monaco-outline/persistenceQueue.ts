import type { IpcEditorCommand } from "../../../../packages/contracts/generated/IpcEditorCommand";
import type { MutationReceipt } from "../../../../packages/contracts/generated/MutationReceipt";
import {
  DRAFT_DEBOUNCE_MS,
  freshId,
  hasErrorCode,
  messageFrom
} from "../storeSupport";

export type EditorPersistenceState =
  | { readonly kind: "saved"; readonly pending: 0 }
  | { readonly kind: "unsaved"; readonly pending: number }
  | { readonly kind: "saving"; readonly pending: number }
  | {
      readonly kind: "conflict";
      readonly pending: number;
      readonly message: string;
    }
  | {
      readonly kind: "fatal";
      readonly pending: number;
      readonly message: string;
    }
  | { readonly kind: "closed"; readonly pending: 0 };

export interface MonacoPersistencePort {
  executeEditorBatch(
    requestId: string,
    commands: readonly IpcEditorCommand[]
  ): Promise<MutationReceipt>;
}

type SaveUrgency = "text" | "structural";
type FlushReason = "blur" | "navigation" | "close";

interface PendingBatch {
  readonly requestId: string;
  readonly commands: readonly IpcEditorCommand[];
}

const MAX_BATCH_COMMANDS = 256;
const MAX_RETAINED_COMMANDS = 1_024;

function isRetryable(cause: unknown): boolean {
  return Boolean(
    cause &&
    typeof cause === "object" &&
    "retryable" in cause &&
    cause.retryable === true
  );
}

export class MonacoOutlinePersistenceQueue {
  private readonly listeners =
    new Set<() => void>();
  private readonly pendingCommands: IpcEditorCommand[] = [];
  private state: EditorPersistenceState = { kind: "saved", pending: 0 };
  private activeBatch: PendingBatch | null = null;
  private tail: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private lastFailure: unknown = null;

  constructor(private readonly port: MonacoPersistencePort) {}

  enqueue(commands: readonly IpcEditorCommand[], urgency: SaveUrgency): void {
    if (this.state.kind === "closed") {
      throw new Error("The Monaco outline persistence queue is closed.");
    }
    if (commands.length === 0) return;
    if (this.pendingCount() + commands.length > MAX_RETAINED_COMMANDS) {
      const error = new Error(
        `The Monaco outline retained more than ${MAX_RETAINED_COMMANDS} unsaved commands.`
      );
      this.paused = true;
      this.lastFailure = error;
      this.updateState({
        kind: "fatal",
        pending: this.pendingCount(),
        message: error.message
      });
      throw error;
    }

    if (urgency === "text") {
      commands.forEach((command) => this.coalesceTextCommand(command));
      this.markUnsaved();
      this.scheduleTextSave();
      return;
    }

    this.pendingCommands.push(...commands);
    this.markUnsaved();
    this.cancelTimer();
    void this.scheduleDrain().catch(() => undefined);
  }

  async flush(reason: FlushReason): Promise<void> {
    this.cancelTimer();
    await this.tail;
    if (this.paused) throw this.lastFailure;
    await this.scheduleDrain();
    if (reason === "close") {
      this.updateState({ kind: "closed", pending: 0 });
    }
  }

  async retry(): Promise<void> {
    if (this.state.kind === "closed") return;
    this.paused = false;
    this.lastFailure = null;
    this.markUnsaved();
    await this.scheduleDrain();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot(): EditorPersistenceState {
    return this.state;
  }

  get pendingCommandCount(): number {
    return this.pendingCount();
  }

  private coalesceTextCommand(command: IpcEditorCommand): void {
    if (command.kind !== "updateText") {
      this.pendingCommands.push(command);
      return;
    }
    const index = this.pendingCommands.findIndex((candidate) =>
      candidate.kind === "updateText" && candidate.id === command.id
    );
    if (index === -1) {
      this.pendingCommands.push(command);
    } else {
      this.pendingCommands[index] = command;
    }
  }

  private scheduleTextSave(): void {
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.scheduleDrain().catch(() => undefined);
    }, DRAFT_DEBOUNCE_MS);
  }

  private scheduleDrain(): Promise<void> {
    const operation = this.tail.then(() => this.drain());
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async drain(): Promise<void> {
    if (this.paused) throw this.lastFailure;
    while (this.activeBatch || this.pendingCommands.length > 0) {
      if (!this.activeBatch) {
        this.activeBatch = {
          requestId: freshId(),
          commands: this.pendingCommands.splice(0, MAX_BATCH_COMMANDS)
        };
      }
      const batch = this.activeBatch;
      this.updateState({
        kind: "saving",
        pending: this.pendingCount()
      });
      try {
        await this.port.executeEditorBatch(batch.requestId, batch.commands);
      } catch (cause) {
        this.pauseAfterFailure(cause);
        throw cause;
      }
      this.activeBatch = null;
      this.lastFailure = null;
      if (this.pendingCommands.length > 0) {
        this.markUnsaved();
      }
    }
    this.updateState({ kind: "saved", pending: 0 });
  }

  private pauseAfterFailure(cause: unknown): void {
    this.paused = true;
    this.lastFailure = cause;
    const pending = this.pendingCount();
    const message = messageFrom(cause);
    if (hasErrorCode(cause, "revision_conflict")) {
      this.updateState({ kind: "conflict", pending, message });
    } else if (isRetryable(cause)) {
      this.updateState({ kind: "unsaved", pending });
    } else {
      this.updateState({ kind: "fatal", pending, message });
    }
  }

  private markUnsaved(): void {
    if (this.state.kind === "conflict" || this.state.kind === "fatal") {
      this.updateState({
        ...this.state,
        pending: this.pendingCount()
      });
      return;
    }
    this.updateState({
      kind: "unsaved",
      pending: this.pendingCount()
    });
  }

  private pendingCount(): number {
    return this.pendingCommands.length +
      (this.activeBatch?.commands.length ?? 0);
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private updateState(state: EditorPersistenceState): void {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}
