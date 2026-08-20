import { fireEvent, render, screen, within } from "@testing-library/react";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "./api";
import { App } from "./App";
import { shiftDay } from "./journal";
import { localDateIso } from "./outline/outlineSlash";
import { ROOT_ID } from "./store/storeSupport";
import { appApi } from "./test/appApiFixture";

const TODAY = localDateIso();

function node(
  id: string,
  parentId: string,
  text: string,
  sortKey = 1_024
): NoteView {
  return {
    id,
    parentId,
    sortKey,
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

/** `earlier` days back from today, each with one row saying which day it is. */
function feedApi(earlier: number): NotesApi {
  const api = appApi();
  const days = Array.from({ length: earlier }, (_, index) => {
    const date = shiftDay(TODAY, -(index + 1));
    return { id: `journal-${date}`, title: date, sortKey: 2_048 + index };
  });
  const pages = [
    { id: "page-1", title: "Reading list", sortKey: 1_024 },
    { id: `journal-${TODAY}`, title: TODAY, sortKey: 2_047 },
    ...days
  ];
  const boot: BootSnapshot = {
    sessionId: "feed-session",
    revision: 3,
    activePageId: "page-1",
    pages,
    viewport: {
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      pageNode: node("page-1", ROOT_ID, "Reading list"),
      nodes: []
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
    nodes: request.pageId === `journal-${TODAY}`
      ? [node("row-today", `journal-${TODAY}`, "what today holds")]
      : []
  }));
  api.queryForest = vi.fn().mockImplementation(async (request) => ({
    revision: 3,
    nodes: request.rootIds.flatMap((rootId: string) => [
      node(
        `row-${rootId}`,
        rootId,
        `row from day ${days.findIndex((day) => day.id === rootId) + 1} back`
      )
    ]),
    complete: true
  }));
  return api;
}

function openFeed(): void {
  const sidebar = within(screen.getByRole("navigation", { name: "Navigation" }));
  const journals = within(sidebar.getByRole("region", { name: "Journals" }));
  fireEvent.click(journals.getByRole("button", { name: /^Journals/u }));
}

describe("the Journals feed", () => {
  it("edits today at the top and reads the days before it below", async () => {
    render(<App api={feedApi(2)} />);
    await screen.findByDisplayValue("Reading list");

    openFeed();

    // Today is the live pane: its title is an editable field.
    expect(await screen.findByDisplayValue(TODAY)).toBeTruthy();
    const earlier = await screen.findByRole("region", { name: "Earlier days" });
    const headings = within(earlier).getAllByRole("heading");
    expect(headings.map((heading) => heading.textContent)).toEqual([
      shiftDay(TODAY, -1),
      shiftDay(TODAY, -2)
    ].map((date) => expect.stringContaining(date)));
    expect(within(earlier).getByText("row from day 1 back")).toBeTruthy();
  });

  it("draws seven days at a time and reveals the rest on request", async () => {
    render(<App api={feedApi(9)} />);
    await screen.findByDisplayValue("Reading list");

    openFeed();

    const earlier = await screen.findByRole("region", { name: "Earlier days" });
    expect(within(earlier).getAllByRole("heading")).toHaveLength(7);

    fireEvent.click(within(earlier)
      .getByRole("button", { name: "Show earlier days" }));

    expect(within(earlier).getAllByRole("heading")).toHaveLength(9);
    expect(within(earlier)
      .queryByRole("button", { name: "Show earlier days" })).toBeNull();
  });

  it("opens a day of its own when its heading is pressed", async () => {
    render(<App api={feedApi(2)} />);
    await screen.findByDisplayValue("Reading list");
    openFeed();
    const earlier = await screen.findByRole("region", { name: "Earlier days" });

    fireEvent.click(within(earlier)
      .getByRole("button", { name: new RegExp(`^${shiftDay(TODAY, -1)}`, "u") }));

    expect(await screen.findByDisplayValue(shiftDay(TODAY, -1))).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Earlier days" })).toBeNull();
  });
});
