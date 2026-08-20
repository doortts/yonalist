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

/**
 * The settings screen arrives as its own chunk, and whichever test opens it first
 * pays for compiling it. Under load that bill runs past the patience of the
 * `findBy` waiting for the screen, and the first settings test in the file fails
 * before it has pressed a key. Warming the chunk once here spreads that cost
 * outside every test's own clock.
 */
beforeAll(async () => {
  await import("./SettingsView");
});

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

  it("goes to the page the sidebar names", async () => {
    render(<App api={shellApi("page-1")} />);
    await screen.findByDisplayValue("Today");
    await openSettings();
    const sidebar = within(screen.getByRole("navigation", { name: "Navigation" }));

    fireEvent.click(sidebar.getByRole("button", { name: "Ideas" }));

    expect(await screen.findByDisplayValue("Ideas"))
      .toHaveAttribute("aria-label", "Page title");
  });

  it("goes back to the page already open when the sidebar names it", async () => {
    render(<App api={shellApi("page-1")} />);
    await screen.findByDisplayValue("Today");
    await openSettings();
    const sidebar = within(screen.getByRole("navigation", { name: "Navigation" }));

    fireEvent.click(sidebar.getByRole("button", { name: "Today" }));

    expect(await screen.findByDisplayValue("Today"))
      .toHaveAttribute("aria-label", "Page title");
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

describe("the new page and settings shortcuts", () => {
  it("opens a fresh page on the new page key", async () => {
    render(<App api={shellApi("page-1")} />);
    await screen.findByDisplayValue("Today");

    pressShortcut("n");

    const fresh = await screen.findByRole("textbox", { name: "Page title" });
    await waitFor(() => expect(fresh).toHaveValue(""));
  });

  it("shows the settings screen on the comma key", async () => {
    render(<App api={shellApi("page-1")} />);
    await screen.findByDisplayValue("Today");

    pressShortcut(",");

    expect(await screen.findByRole("navigation", { name: "Settings sections" }))
      .toBeInTheDocument();
  });

  it("comes back to the page it was opened from", async () => {
    render(<App api={shellApi("page-2")} />);
    await screen.findByDisplayValue("Ideas");

    pressShortcut(",");
    await screen.findByRole("navigation", { name: "Settings sections" });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(await screen.findByDisplayValue("Ideas"))
      .toHaveAttribute("aria-label", "Page title");
  });

  it("leaves the settings screen up when the comma comes again", async () => {
    render(<App api={shellApi("page-1")} />);
    await screen.findByDisplayValue("Today");
    await openSettings();

    pressShortcut(",");

    expect(screen.getByRole("navigation", { name: "Settings sections" }))
      .toBeInTheDocument();
  });

  it("answers the Command key on a Mac", async () => {
    const platform = navigator.platform;
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel", configurable: true
    });
    try {
      render(<App api={shellApi("page-1")} />);
      await screen.findByDisplayValue("Today");

      fireEvent.keyDown(window, { key: ",", metaKey: true });

      expect(await screen.findByRole("navigation", { name: "Settings sections" }))
        .toBeInTheDocument();
    } finally {
      Object.defineProperty(navigator, "platform", {
        value: platform, configurable: true
      });
    }
  });
});

describe("the page shortcuts", () => {
  it("wears its key under the row it opens", async () => {
    render(<App api={shellApi("page-1")} />);
    await screen.findByDisplayValue("Today");
    const sidebar = within(screen.getByRole("navigation", { name: "Navigation" }));

    // The hints are painted by CSS off a held modifier, so what a test can ask
    // is whether the row carries its own key at all.
    expect(within(sidebar.getByRole("button", { name: "All" }))
      .getByText("Ctrl+0")).toBeInTheDocument();
    expect(within(sidebar.getByRole("button", { name: "Ideas" }))
      .getByText("Ctrl+2")).toBeInTheDocument();
    expect(sidebar.queryByText("Ctrl+10")).toBeNull();
  });

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

  it("shows All on the zero", async () => {
    render(<App api={shellApi("page-2")} />);
    await screen.findByDisplayValue("Ideas");

    pressShortcut("0");

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
