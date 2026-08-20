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

const PAGES = [
  { id: "journal-1", title: DAY, sortKey: 1_024 },
  { id: "page-2", title: "Sprint plan", sortKey: 2_048 }
];

function referenceApi(activePageId: string): NotesApi {
  const api = appApi();
  const boot: BootSnapshot = {
    sessionId: "reference-session",
    revision: 3,
    activePageId,
    pages: PAGES,
    viewport: {
      pageId: activePageId,
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      pageNode: node(
        activePageId,
        ROOT_ID,
        PAGES.find((page) => page.id === activePageId)?.title ?? ""
      ),
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
      PAGES.find((page) => page.id === request.pageId)?.title ?? ""
    ),
    nodes: []
  }));
  api.search = vi.fn().mockResolvedValue({
    hits: [
      {
        node: node("row-2", "page-2", `release call on ${DAY}`),
        pageId: "page-2",
        snippet: ""
      },
      // The day's own title carries the date too, and the day is not a
      // reference to itself.
      {
        node: node("journal-1", ROOT_ID, DAY),
        pageId: "journal-1",
        snippet: ""
      }
    ],
    nextCursor: null
  });
  return api;
}

describe("the rows that name a day", () => {
  it("lists them under the day, without the day's own rows", async () => {
    const api = referenceApi("journal-1");
    render(<App api={api} />);

    const references = await screen.findByRole(
      "region", { name: "Linked references" }
    );

    expect(api.search).toHaveBeenCalledWith(
      expect.objectContaining({ text: `date:${DAY}` })
    );
    const rows = within(references).getAllByRole("button");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Sprint plan");
    expect(references.textContent).toContain("1");
  });

  it("opens the page a row came from", async () => {
    render(<App api={referenceApi("journal-1")} />);
    const references = await screen.findByRole(
      "region", { name: "Linked references" }
    );

    fireEvent.click(within(references).getAllByRole("button")[0]);

    expect(await screen.findByDisplayValue("Sprint plan")).toBeTruthy();
  });

  it("says nothing on a page that is not a day", async () => {
    render(<App api={referenceApi("page-2")} />);
    await screen.findByDisplayValue("Sprint plan");

    expect(screen.queryByRole("region", { name: "Linked references" }))
      .toBeNull();
  });
});
