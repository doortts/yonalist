import type { ViewportPage } from "../../../packages/contracts/generated/ViewportPage";
import type { NotesApi } from "./api";
import type { NotesState } from "./notesState";
import {
  hasErrorCode, messageFrom, VIEWPORT_LIMIT
} from "./storeSupport";

export class StoreViewport {
  private sequence = 0;

  constructor(
    private readonly api: NotesApi,
    private readonly getState: () => NotesState,
    private readonly update: (patch: Partial<NotesState>) => void,
    private readonly apply: (
      viewport: ViewportPage,
      append: boolean
    ) => void
  ) {}

  async openPage(pageId: string): Promise<void> {
    if (pageId === this.getState().activePageId) return;
    const sequence = ++this.sequence;
    this.update({
      status: "loading",
      activePageId: pageId,
      nodes: [],
      error: null
    });
    try {
      const viewport = await this.api.queryViewport({
        pageId,
        anchorId: null,
        beforeCursor: null,
        afterCursor: null,
        limit: VIEWPORT_LIMIT
      });
      if (sequence === this.sequence) this.apply(viewport, false);
    } catch (cause) {
      if (sequence === this.sequence) {
        this.update({ status: "error", error: messageFrom(cause) });
      }
    }
  }

  async loadMore(): Promise<void> {
    const { activePageId, afterCursor } = this.getState();
    if (!activePageId || !afterCursor) return;
    const sequence = ++this.sequence;
    try {
      const viewport = await this.api.queryViewport({
        pageId: activePageId,
        anchorId: null,
        beforeCursor: null,
        afterCursor,
        limit: VIEWPORT_LIMIT
      });
      if (sequence === this.sequence) this.apply(viewport, true);
    } catch (cause) {
      if (sequence !== this.sequence) return;
      const anchorId = this.getState().nodes.at(-1)?.id;
      if (hasErrorCode(cause, "revision_conflict") && anchorId) {
        try {
          const viewport = await this.api.queryViewport({
            pageId: activePageId,
            anchorId,
            beforeCursor: null,
            afterCursor: null,
            limit: VIEWPORT_LIMIT
          });
          if (sequence === this.sequence) this.apply(viewport, true);
          return;
        } catch (recoveryCause) {
          this.update({ error: messageFrom(recoveryCause) });
          return;
        }
      }
      this.update({ error: messageFrom(cause) });
    }
  }
}
