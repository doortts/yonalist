import {
  act, fireEvent, render, screen, waitFor, within
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
  fireEvent.keyDown(window, { key, ctrlKey: true });
}

describe("leaving the settings screen", () => {
  it("puts the caret back in the row it was taken from", async () => {
    render(<App api={shellApi("page-2")} />);
    const title = await screen.findByDisplayValue("Ideas") as HTMLTextAreaElement;
    title.focus();
    title.setSelectionRange(2, 2);
    const settings = screen.getByRole("button", { name: "Settings" });
    // What a browser does between the two, and jsdom does not: the press
    // moves focus off the outline before the click is dispatched.
    fireEvent.pointerDown(settings);
    act(() => settings.focus());
    // `detail` is what tells a pointer's click from a keyboard's.
    fireEvent.click(settings, { detail: 1 });
    await screen.findByRole("navigation", { name: "Settings sections" });

    fireEvent.keyDown(window, { key: "Escape" });

    const back = await screen.findByDisplayValue("Ideas") as HTMLTextAreaElement;
    await waitFor(() => expect(back).toHaveFocus());
    expect(back.selectionStart).toBe(2);
  });

  it("forgets a caret the reader has since walked away from", async () => {
    render(<App api={shellApi("page-2")} />);
    const title = await screen.findByDisplayValue("Ideas") as HTMLTextAreaElement;
    title.focus();
    title.setSelectionRange(2, 2);
    const settings = screen.getByRole("button", { name: "Settings" });
    fireEvent.pointerDown(settings);
    act(() => settings.focus());
    fireEvent.click(settings, { detail: 1 });
    await screen.findByRole("navigation", { name: "Settings sections" });
    // Out of settings by another door, around, and back in from the keyboard.
    const sidebar = within(screen.getByRole("navigation", { name: "Navigation" }));
    fireEvent.click(sidebar.getByRole("button", { name: "All" }));
    fireEvent.click(await sidebar.findByRole("button", { name: "Ideas" }));
    await screen.findByDisplayValue("Ideas");
    fireEvent.click(settings);
    await screen.findByRole("navigation", { name: "Settings sections" });

    fireEvent.keyDown(window, { key: "Escape" });

    // The caret it would put back is two navigations old. This open had no
    // caret to remember, so it has none to give.
    const back = await screen.findByDisplayValue("Ideas");
    await waitFor(() => expect(screen.queryByRole(
      "navigation", { name: "Settings sections" })).toBeNull());
    expect(back).not.toHaveFocus();
  });

  it("keeps a page nobody has written in yet", async () => {
    render(<App api={shellApi("page-1")} />);
    await screen.findByDisplayValue("Today");
    fireEvent.click(screen.getByRole("button", { name: "New page" }));
    const fresh = await screen.findByRole("textbox", { name: "Page title" });
    await waitFor(() => expect(fresh).toHaveValue(""));
    await openSettings();

    fireEvent.keyDown(window, { key: "Escape" });

    // The page has no row in the list until something is written into it.
    // That is not the same as having nowhere to go back to.
    expect(await screen.findByRole("textbox", { name: "Page title" }))
      .toHaveValue("");
    expect(screen.getByRole("button", { name: "All" }))
      .not.toHaveAttribute("aria-current");
  });

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
  it("answers the Command key on a Mac", async () => {
    const platform = navigator.platform;
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel", configurable: true
    });
    try {
      render(<App api={shellApi("page-1")} />);
      await screen.findByDisplayValue("Today");

      fireEvent.keyDown(window, { key: "2", metaKey: true });

      expect(await screen.findByDisplayValue("Ideas"))
        .toHaveAttribute("aria-label", "Page title");
    } finally {
      Object.defineProperty(navigator, "platform", {
        value: platform, configurable: true
      });
    }
  });

  it("brings the page list back with the page it opens", async () => {
    render(<App api={shellApi("page-1")} />);
    await screen.findByDisplayValue("Today");
    const sidebar = within(screen.getByRole("navigation", { name: "Navigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    await waitFor(() => expect(
      sidebar.queryByRole("button", { name: "Ideas" })).toBeNull());

    pressShortcut("2");

    // The number names a place in a list, so the list has to be the one on
    // screen when the reader lands.
    await waitFor(() => expect(
      sidebar.getByRole("button", { name: "Ideas" }))
      .toHaveAttribute("aria-current", "page"));
  });

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
