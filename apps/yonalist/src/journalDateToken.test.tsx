import { fireEvent, render, screen, within } from "@testing-library/react";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "./api";
import { App } from "./App";
import { ROOT_ID } from "./store/storeSupport";
import { appApi } from "./test/appApiFixture";

const DAY = "2026-08-24";

function node(id: string, parentId: string, text: string): NoteView {
  return {
    id,
    parentId,
    sortKey: 1_024,
    kind: "bullet", image: null,
    text,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

function tokenApi(dayExists = true): NotesApi {
  const api = appApi();
  const pages = [
    { id: "page-1", title: "Reading list", sortKey: 1_024 },
    ...(dayExists ? [{ id: "journal-1", title: DAY, sortKey: 2_048 }] : [])
  ];
  const boot: BootSnapshot = {
    sessionId: "token-session",
    revision: 3,
    activePageId: "page-1",
    pages,
    viewport: {
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      pageNode: node("page-1", ROOT_ID, "Reading list"),
      nodes: [node("row-1", "page-1", `retro moved to ${DAY}`)]
    },
    history: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 }
  };
  api.bootstrap = vi.fn().mockResolvedValue(boot);
  api.queryViewport = vi.fn().mockImplementation(async (request) => ({
    pageId: request.pageId,
    anchorId: null,
    beforeCursor: null,
    afterCursor: null,
    pageNode: node(
      request.pageId,
      ROOT_ID,
      pages.find((page) => page.id === request.pageId)?.title ?? ""
    ),
    nodes: []
  }));
  return api;
}

async function openDateMenu(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: `Date ${DAY}` }));
  return screen.findByRole("menu", { name: `Date ${DAY}` });
}

describe("a date in a row", () => {
  it("offers the day and the rows that name it", async () => {
    render(<App api={tokenApi()} />);
    await screen.findByDisplayValue("Reading list");

    const menu = await openDateMenu();

    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent))
      .toEqual(["Open journal", "Show linked rows"]);
  });

  it("opens the day it names", async () => {
    render(<App api={tokenApi()} />);
    await screen.findByDisplayValue("Reading list");
    const menu = await openDateMenu();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open journal" }));

    expect(await screen.findByDisplayValue(DAY)).toBeTruthy();
    expect(screen.queryByRole("menu", { name: `Date ${DAY}` })).toBeNull();
  });

  it("opens a day that has no page yet", async () => {
    render(<App api={tokenApi(false)} />);
    await screen.findByDisplayValue("Reading list");
    const menu = await openDateMenu();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open journal" }));

    expect(await screen.findByDisplayValue(DAY)).toBeTruthy();
  });

  it("puts the day's rows in the search field", async () => {
    render(<App api={tokenApi()} />);
    await screen.findByDisplayValue("Reading list");
    const menu = await openDateMenu();

    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Show linked rows" })
    );

    expect(await screen.findByRole("searchbox", { name: "Search Yonalist" }))
      .toHaveValue(`date:${DAY}`);
  });
});
