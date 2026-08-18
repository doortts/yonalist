import {
  act, fireEvent, render, screen, waitFor
} from "@testing-library/react";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "./api";
import { App } from "./App";
import { ROOT_ID } from "./store/storeSupport";
import { appApi } from "./test/appApiFixture";

const PAGES = [
  { id: "page-1", title: "Today", sortKey: 1_024 },
  { id: "page-2", title: "Ideas", sortKey: 2_048 },
  { id: "page-3", title: "Later", sortKey: 3_072 }
];

function pageNode(id: string): NoteView {
  return {
    id,
    parentId: ROOT_ID,
    sortKey: PAGES.find((page) => page.id === id)?.sortKey ?? 1_024,
    kind: "bullet", image: null,
    text: PAGES.find((page) => page.id === id)?.title ?? "",
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

function shellApi(activePageId: string | null = "page-1"): NotesApi {
  const notesApi = appApi();
  const boot: BootSnapshot = {
    sessionId: "shortcut-session",
    revision: 3,
    activePageId,
    pages: activePageId === null ? [] : PAGES,
    viewport: activePageId === null || activePageId === ROOT_ID
      ? null
      : {
          pageId: activePageId,
          anchorId: null,
          beforeCursor: null,
          afterCursor: null,
          pageNode: pageNode(activePageId),
          nodes: []
        },
    history: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
  };
  notesApi.bootstrap = vi.fn().mockResolvedValue(boot);
  notesApi.queryViewport = vi.fn().mockImplementation(async (request) => ({
    pageId: request.pageId,
    anchorId: null,
    beforeCursor: null,
    afterCursor: null,
    pageNode: request.pageId === ROOT_ID ? null : pageNode(request.pageId),
    nodes: request.pageId === ROOT_ID
      ? PAGES.map((page) => pageNode(page.id))
      : []
  }));
  return notesApi;
}

/** Opens the settings screen and waits for its lazy chunk. */
async function openSettings(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("navigation", { name: "Settings sections" });
}

function pressShortcut(key: string): void {
  fireEvent.keyDown(window, { key, metaKey: true, ctrlKey: true });
}

describe("leaving the settings screen", () => {
  it("goes back to the page it was opened from", async () => {
    render(<App api={shellApi("page-2")} />);
    await screen.findByDisplayValue("Ideas");
    await openSettings();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(await screen.findByDisplayValue("Ideas"))
      .toHaveAttribute("aria-label", "Page title");
  });

  it("goes back to the page opened while it was up, not the one before", async () => {
    render(<App api={shellApi("page-1")} />);
    await screen.findByDisplayValue("Today");
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Later" }));

    fireEvent.keyDown(window, { key: "Escape" });

    expect(await screen.findByDisplayValue("Later"))
      .toHaveAttribute("aria-label", "Page title");
  });

  it("shows All when there is no page to go back to", async () => {
    render(<App api={shellApi(null)} />);
    await openSettings();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(screen.getByRole("button", { name: "All" }))
      .toHaveAttribute("aria-current", "page"));
  });
});

describe("the page shortcuts", () => {
  it("opens the page at the pressed place in the list", async () => {
    render(<App api={shellApi("page-1")} />);
    await screen.findByDisplayValue("Today");

    pressShortcut("3");

    expect(await screen.findByDisplayValue("Later"))
      .toHaveAttribute("aria-label", "Page title");
  });

  it("leaves a place nobody filled alone", async () => {
    const notesApi = shellApi("page-1");
    render(<App api={notesApi} />);
    await screen.findByDisplayValue("Today");

    pressShortcut("9");
    // Long enough for the open it would have started to reach the backend.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(notesApi.queryViewport).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Today"))
      .toHaveAttribute("aria-label", "Page title");
  });

  it("shows All on the backtick", async () => {
    render(<App api={shellApi("page-2")} />);
    await screen.findByDisplayValue("Ideas");

    pressShortcut("`");

    await waitFor(() => expect(screen.getByRole("button", { name: "All" }))
      .toHaveAttribute("aria-current", "page"));
  });

  it("leaves the settings screen for the page it opens", async () => {
    render(<App api={shellApi("page-1")} />);
    await screen.findByDisplayValue("Today");
    await openSettings();

    pressShortcut("2");

    expect(await screen.findByDisplayValue("Ideas"))
      .toHaveAttribute("aria-label", "Page title");
  });
});
