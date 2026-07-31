import type { IpcEditorCommand } from "../../../../packages/contracts/generated/IpcEditorCommand";
import type { MutationReceipt } from "../../../../packages/contracts/generated/MutationReceipt";
import type { MonacoPageSnapshot } from "../storeMonaco";
import {
  MonacoOutlineSession,
  type MonacoOutlineSessionInput
} from "./session";

export interface MonacoSessionRegistryPort {
  loadMonacoPage(pageId: string): Promise<MonacoPageSnapshot>;
  executeEditorBatch(
    requestId: string,
    commands: readonly IpcEditorCommand[]
  ): Promise<MutationReceipt>;
}

export interface MonacoSessionLease {
  readonly session: MonacoOutlineSession;
  release(): Promise<void>;
}

export interface MonacoSessionRegistry {
  acquire(pageId: string): Promise<MonacoSessionLease>;
  flushPage(
    pageId: string,
    reason: "navigation" | "close"
  ): Promise<void>;
  flushAll(reason: "close"): Promise<void>;
  hasFocusedEditor(target: EventTarget | null): boolean;
  dispose(): Promise<void>;
}

interface RegistryEntry {
  readonly session: Promise<MonacoOutlineSession>;
  references: number;
  resolved: MonacoOutlineSession | null;
}

export class MonacoOutlineSessionRegistry implements MonacoSessionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private disposed = false;

  constructor(
    private readonly port: MonacoSessionRegistryPort,
    private readonly allocateId?: MonacoOutlineSessionInput["allocateId"]
  ) {}

  async acquire(pageId: string): Promise<MonacoSessionLease> {
    if (this.disposed) throw new Error("The Monaco session registry is disposed.");
    let entry = this.entries.get(pageId);
    if (!entry) {
      entry = {
        references: 0,
        resolved: null,
        session: this.hydrate(pageId)
      };
      this.entries.set(pageId, entry);
    }
    entry.references += 1;
    let session: MonacoOutlineSession;
    try {
      session = await entry.session;
      entry.resolved = session;
    } catch (cause) {
      entry.references -= 1;
      if (entry.references === 0) this.entries.delete(pageId);
      throw cause;
    }
    let released = false;
    return {
      session,
      release: async () => {
        if (released) return;
        released = true;
        await this.release(pageId, entry!, session);
      }
    };
  }

  async flushPage(
    pageId: string,
    reason: "navigation" | "close"
  ): Promise<void> {
    const entry = this.entries.get(pageId);
    if (!entry) return;
    const session = await entry.session;
    await session.flush(reason);
  }

  async flushAll(reason: "close"): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map(async (entry) =>
        (await entry.session).flush(reason))
    );
  }

  hasFocusedEditor(target: EventTarget | null): boolean {
    return [...this.entries.values()].some(
      (entry) => entry.resolved?.hasFocusedEditor(target) ?? false
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map(async (entry) =>
      (await entry.session).dispose()));
  }

  private async hydrate(pageId: string): Promise<MonacoOutlineSession> {
    const page = await this.port.loadMonacoPage(pageId);
    return MonacoOutlineSession.create({
      pageId,
      nodes: page.viewport.nodes,
      persistence: {
        executeEditorBatch: (requestId, commands) =>
          this.port.executeEditorBatch(requestId, commands)
      },
      allocateId: this.allocateId
    });
  }

  private async release(
    pageId: string,
    entry: RegistryEntry,
    session: MonacoOutlineSession
  ): Promise<void> {
    entry.references = Math.max(0, entry.references - 1);
    if (
      entry.references > 0 ||
      this.entries.get(pageId) !== entry
    ) {
      return;
    }
    this.entries.delete(pageId);
    await session.dispose();
  }
}
