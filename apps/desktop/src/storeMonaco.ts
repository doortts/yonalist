import type { IpcEditorCommand } from "../../../packages/contracts/generated/IpcEditorCommand";
import type { MutationReceipt } from "../../../packages/contracts/generated/MutationReceipt";
import type { ViewportPage } from "../../../packages/contracts/generated/ViewportPage";
import type { NotesApi } from "./api";
import type { NotesState } from "./notesState";
import type { StoreCommands } from "./storeCommands";

export interface MonacoPageSnapshot {
  readonly revision: number;
  readonly viewport: ViewportPage;
}

export class MonacoPageUnsupportedError extends Error {
  readonly code = "monaco_page_unsupported";

  constructor() {
    super("The page is too large to open in the Monaco outline.");
    this.name = "MonacoPageUnsupportedError";
  }
}

export class StoreMonaco {
  constructor(
    private readonly api: NotesApi,
    private readonly commands: StoreCommands,
    private readonly read: () => NotesState
  ) {}

  executeEditorBatch(
    requestId: string,
    commands: readonly IpcEditorCommand[]
  ): Promise<MutationReceipt> {
    return this.commands.executeSessionOwned(commands, requestId);
  }

  async loadPage(pageId: string): Promise<MonacoPageSnapshot> {
    await this.commands.settled();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const revision = this.read().revision;
      const viewport = await this.api.queryViewport({
        pageId,
        anchorId: null,
        beforeCursor: null,
        afterCursor: null,
        limit: 50_000
      });
      await this.commands.settled();
      if (revision !== this.read().revision) continue;
      this.assertPageSupported(viewport);
      return { revision, viewport };
    }
    throw new Error("The Notes revision changed while loading the Monaco page.");
  }

  /**
   * Notes and image nodes render on the Monaco surface since Phase 5, so the
   * only page it still refuses is one the single viewport query cannot hold —
   * incremental loading is an explicit non-goal of that plan.
   */
  private assertPageSupported(viewport: ViewportPage): void {
    if (viewport.beforeCursor !== null || viewport.afterCursor !== null) {
      throw new MonacoPageUnsupportedError();
    }
  }
}
