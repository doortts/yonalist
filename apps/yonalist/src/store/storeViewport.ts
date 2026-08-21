import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { ViewportPage } from "../../../../packages/contracts/generated/ViewportPage";
import type { NotesApi } from "../api";
import type { NotesState } from "../notesState";
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

  /**
   * Opens a page this window holds by itself, with no query behind it. The
   * sequence still moves: an answer already in flight describes the page the
   * user has just left, and letting it land would put that page back.
   */
  openLocalPage(pageId: string, pageNode: NoteView): void {
    this.sequence += 1;
    this.update({
      status: "ready",
      activePageId: pageId,
      nodes: [],
      pageNode,
      beforeCursor: null,
      afterCursor: null,
      error: null
    });
  }

  async openPage(pageId: string): Promise<void> {
    if (pageId === this.getState().activePageId) return;
    const sequence = ++this.sequence;
    this.update({
      status: "loading",
      activePageId: pageId,
      nodes: [],
      pageNode: null,
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

  /**
   * Reads the page the user is on again, keeping them on it. What a merge
   * changed is anywhere in the page — including rows the window is not
   * showing — so the page is re-read rather than patched row by row.
   *
   * Answers whether the rows on screen are the merged ones. The caller has a
   * revision to claim for them, and claiming it over rows that never arrived
   * would accept the next edit against text the user never saw.
   */
  async reload(): Promise<boolean> {
    const { activePageId } = this.getState();
    // No page open, so there are no rows that could be out of date.
    if (!activePageId) return true;
    const sequence = ++this.sequence;
    try {
      const viewport = await this.api.queryViewport({
        pageId: activePageId,
        anchorId: null,
        beforeCursor: null,
        afterCursor: null,
        limit: VIEWPORT_LIMIT
      });
      // Somebody else moved the sequence while this was in flight, and which
      // one decides whether these rows still matter. A page taken over was
      // read after the merge committed, so the screen holds the merged rows
      // and the caller's revision is theirs to claim. Still the same page —
      // more of it fetched below the fold, or a later re-read that will claim
      // its own number — and the rows the reader is looking at are the ones
      // from before the merge: claiming over them would pass their next edit
      // and overwrite what the other device wrote.
      if (sequence !== this.sequence) {
        return this.getState().activePageId !== activePageId;
      }
      this.apply(viewport, false);
      return true;
    } catch (cause) {
      if (sequence === this.sequence) {
        this.update({ error: messageFrom(cause) });
      }
      return false;
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
