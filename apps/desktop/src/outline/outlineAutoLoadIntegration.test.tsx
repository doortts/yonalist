import { render, screen, waitFor } from "@testing-library/react";
import type { BootSnapshot } from "../../../../packages/contracts/generated/BootSnapshot";
import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "../api";
import { App } from "../App";
import { appApi } from "../test/appApiFixture";

function bullet(id: string, sortKey: number, text: string): NoteView {
  return {
    id,
    parentId: "page-1",
    sortKey,
    kind: "bullet",
    image: null,
    text,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

const firstPage: BootSnapshot = {
  sessionId: "autoload-session",
  revision: 1,
  activePageId: "page-1",
  pages: [{ id: "page-1", title: "Today", sortKey: 1_024 }],
  viewport: {
    pageId: "page-1",
    anchorId: null,
    beforeCursor: null,
    afterCursor: "cursor-1",
    nodes: [bullet("bullet-1", 1024, "first page row")]
  },
  history: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
};

function autoLoadApi(): NotesApi {
  return {
    ...appApi(),
    bootstrap: vi.fn().mockResolvedValue(firstPage),
    queryViewport: vi.fn().mockResolvedValue({
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      nodes: [bullet("bullet-2", 2048, "second page row")]
    }),
    queryForest: vi.fn().mockResolvedValue({
      revision: 1,
      nodes: [],
      complete: true
    }),
    execute: vi.fn()
  };
}

describe("outline pagination reaches the next page by scrolling", () => {
  const observers: {
    callback: IntersectionObserverCallback;
    target: Element | null;
  }[] = [];

  beforeEach(() => {
    observers.length = 0;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback, target: null };
        observers.push(this.entry);
      }
      private readonly entry: {
        callback: IntersectionObserverCallback;
        target: Element | null;
      };
      observe(target: Element): void {
        this.entry.target = target;
      }
      disconnect(): void {}
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function reachBottom(): void {
    for (const observer of observers) {
      if (!observer.target) continue;
      observer.callback(
        [{ isIntersecting: true, target: observer.target } as
          IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    }
  }

  it("loads the next page on scroll instead of asking for a button press", async () => {
    const notesApi = autoLoadApi();
    render(<App api={notesApi} />);

    await screen.findByDisplayValue("first page row");
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
    expect(notesApi.queryViewport).not.toHaveBeenCalled();

    reachBottom();

    await waitFor(() => {
      expect(notesApi.queryViewport).toHaveBeenCalledWith({
        pageId: "page-1",
        anchorId: null,
        beforeCursor: null,
        afterCursor: "cursor-1",
        limit: 80
      });
    }, { timeout: 1_000 });
    await screen.findByDisplayValue("second page row");

    // The exhausted cursor must not schedule another request.
    reachBottom();
    await waitFor(() => {
      expect(notesApi.queryViewport).toHaveBeenCalledTimes(1);
    }, { timeout: 1_000 });
  });

  it("requests one page per cursor while the anchor stays in view", async () => {
    const notesApi = autoLoadApi();
    notesApi.queryViewport = vi.fn().mockResolvedValue({
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: "cursor-1",
      nodes: [bullet("bullet-2", 2048, "second page row")]
    });
    render(<App api={notesApi} />);

    await screen.findByDisplayValue("first page row");
    reachBottom();
    await screen.findByDisplayValue("second page row");

    reachBottom();
    reachBottom();
    await waitFor(() => {
      expect(notesApi.queryViewport).toHaveBeenCalledTimes(1);
    }, { timeout: 1_000 });
  });
});
