import { fireEvent, render, screen, within } from "@testing-library/react";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "./api";
import { App } from "./App";
import { monthGrid, monthOf, shiftDay, shiftMonth } from "./journal";
import { localDateIso } from "./outline/outlineSlash";
import { ROOT_ID } from "./store/storeSupport";
import { appApi } from "./test/appApiFixture";

const TODAY = localDateIso();
const WRITTEN = shiftDay(TODAY, -1);

function node(id: string, text: string): NoteView {
  return {
    id,
    parentId: ROOT_ID,
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

const PAGES = [
  { id: "page-1", title: "Reading list", sortKey: 1_024 },
  { id: "journal-written", title: WRITTEN, sortKey: 2_048 }
];

function calendarApi(): NotesApi {
  const api = appApi();
  const title = (id: string) =>
    PAGES.find((page) => page.id === id)?.title ?? "";
  const boot: BootSnapshot = {
    sessionId: "calendar-session",
    revision: 3,
    activePageId: "page-1",
    pages: PAGES,
    viewport: {
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      pageNode: node("page-1", "Reading list"),
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
    pageNode: node(request.pageId, title(request.pageId)),
    nodes: []
  }));
  return api;
}

/** The month arrives in its own chunk, so every reader of it waits for one. */
async function calendar() {
  return within(await screen.findByRole(
    "group", { name: "Journal calendar" }
  ));
}

describe("the journal calendar", () => {
  it("marks today and the days that have been written in", async () => {
    render(<App api={calendarApi()} />);
    await screen.findByDisplayValue("Reading list");

    expect((await calendar()).getByRole("button", { name: TODAY }))
      .toHaveAttribute("aria-current", "date");
    expect((await calendar()).getByRole("button", { name: WRITTEN }))
      .toHaveAttribute("data-journal", "true");
    const plainDay = monthGrid(monthOf(TODAY))
      .find((day) => day !== null && day !== TODAY && day !== WRITTEN) as string;
    expect((await calendar()).getByRole("button", { name: plainDay }))
      .not.toHaveAttribute("data-journal");
  });

  it("opens the day a reader presses", async () => {
    render(<App api={calendarApi()} />);
    await screen.findByDisplayValue("Reading list");

    fireEvent.click((await calendar()).getByRole("button", { name: WRITTEN }));

    expect(await screen.findByDisplayValue(WRITTEN)).toBeTruthy();
  });

  it("walks back a month and comes forward again", async () => {
    render(<App api={calendarApi()} />);
    await screen.findByDisplayValue("Reading list");
    const previousMonth = shiftMonth(monthOf(TODAY), -1);
    const someDay = monthGrid(previousMonth).filter(Boolean).at(-1) as string;

    fireEvent.click((await calendar()).getByRole("button", { name: "Previous month" }));

    expect((await calendar()).getByRole("button", { name: someDay })).toBeTruthy();

    fireEvent.click((await calendar()).getByRole("button", { name: "Next month" }));

    expect((await calendar()).getByRole("button", { name: TODAY })).toBeTruthy();
  });
});
