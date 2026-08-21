import { fireEvent, render, screen } from "@testing-library/react";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "./api";
import { App } from "./App";
import { ROOT_ID } from "./store/storeSupport";
import { appApi } from "./test/appApiFixture";

const DAY = "2026-08-24";
const BEFORE = "2026-08-23";

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

const PAGES = [
  { id: "journal-1", title: DAY, sortKey: 1_024 },
  { id: "journal-0", title: BEFORE, sortKey: 512 },
  { id: "page-2", title: "Sprint plan", sortKey: 2_048 }
];

function dayApi(activePageId: string): NotesApi {
  const api = appApi();
  const title = (id: string) =>
    PAGES.find((page) => page.id === id)?.title ?? "";
  const boot: BootSnapshot = {
    sessionId: "day-session",
    revision: 3,
    activePageId,
    pages: PAGES,
    viewport: {
      pageId: activePageId,
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      pageNode: node(activePageId, ROOT_ID, title(activePageId)),
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
    pageNode: node(request.pageId, ROOT_ID, title(request.pageId)),
    nodes: []
  }));
  return api;
}

describe("the day bar", () => {
  it("names the weekday of the day it is on", async () => {
    render(<App api={dayApi("journal-1")} />);

    // 2026-08-24 is a Monday, whatever the machine's language calls it.
    const bar = await screen.findByRole("group", { name: `Day ${DAY}` });
    expect(bar.textContent).toContain(
      new Intl.DateTimeFormat(undefined, {
        weekday: "long", timeZone: "UTC"
      }).format(new Date(Date.UTC(2026, 7, 24)))
    );
  });

  it("walks to the day before", async () => {
    render(<App api={dayApi("journal-1")} />);
    await screen.findByRole("group", { name: `Day ${DAY}` });

    fireEvent.click(
      screen.getByRole("button", { name: `Previous day, ${BEFORE}` })
    );

    expect(await screen.findByDisplayValue(BEFORE)).toBeTruthy();
  });

  it("walks to a day that has no page yet", async () => {
    render(<App api={dayApi("journal-1")} />);
    await screen.findByRole("group", { name: `Day ${DAY}` });

    fireEvent.click(
      screen.getByRole("button", { name: "Next day, 2026-08-25" })
    );

    expect(await screen.findByDisplayValue("2026-08-25")).toBeTruthy();
  });

  it("stays away from a page that is not a day", async () => {
    render(<App api={dayApi("page-2")} />);
    await screen.findByDisplayValue("Sprint plan");

    expect(screen.queryByRole("group", { name: /^Day /u })).toBeNull();
  });
});
