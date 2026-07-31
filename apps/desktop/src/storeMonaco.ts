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

  constructor(
    readonly reason: "partial-viewport" | "rich-node"
  ) {
    super(reason === "partial-viewport"
      ? "The page is too large to open in the Monaco outline."
      : "The page contains nodes that the Monaco outline cannot render.");
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

  private assertPageSupported(viewport: ViewportPage): void {
    if (viewport.beforeCursor !== null || viewport.afterCursor !== null) {
      throw new MonacoPageUnsupportedError("partial-viewport");
    }
    const hasRichNode = viewport.nodes.some((node) =>
      node.kind !== "bullet" ||
      node.image !== null ||
      node.note.length > 0
    );
    if (hasRichNode) throw new MonacoPageUnsupportedError("rich-node");
  }
}
