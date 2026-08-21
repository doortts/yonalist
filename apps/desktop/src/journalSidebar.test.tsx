import { fireEvent, render, screen, within } from "@testing-library/react";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "./api";
import { App } from "./App";
import { localDateIso } from "./outline/outlineSlash";
import { JOURNALS_ID, ROOT_ID } from "./store/storeSupport";
import { appApi } from "./test/appApiFixture";

const TODAY = localDateIso();

const PAGES = [
  { id: "page-1", title: "Reading list", sortKey: 1_024 },
  { id: JOURNALS_ID, title: "Journals", sortKey: 1_536 },
  { id: "journal-1", title: TODAY, sortKey: 2_048 },
  { id: "page-2", title: "Ideas", sortKey: 3_072 }
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

function journalApi(): NotesApi {
  const api = appApi();
  const boot: BootSnapshot = {
    sessionId: "journal-session",
    revision: 3,
    activePageId: "page-1",
    pages: PAGES,
    viewport: {
      pageId: "page-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      pageNode: pageNode("page-1"),
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
    pageNode: request.pageId === ROOT_ID ? null : pageNode(request.pageId),
    nodes: []
  }));
  return api;
}

function sidebar() {
  return within(screen.getByRole("navigation", { name: "Navigation" }));
}

describe("the Journals section of the sidebar", () => {
  it("keeps journal days out of the Pages list", async () => {
    render(<App api={journalApi()} />);
    await screen.findByDisplayValue("Reading list");

    const pages = within(sidebar().getByRole("region", { name: "Pages" }));
    expect(pages.getByRole("button", { name: /^Reading list/u })).toBeTruthy();
    expect(pages.queryByRole("button", { name: new RegExp(`^${TODAY}`, "u") }))
      .toBeNull();
  });

  it("keeps the Journals node out of the Pages list", async () => {
    render(<App api={journalApi()} />);
    await screen.findByDisplayValue("Reading list");

    // The section above the list is how the journals are reached, so the node
    // they hang from would only be a second door to the same place.
    const pages = within(sidebar().getByRole("region", { name: "Pages" }));
    expect(pages.queryByRole("button", { name: /^Journals/u })).toBeNull();
  });

  it("numbers the pages without counting the journals", async () => {
    render(<App api={journalApi()} />);
    await screen.findByDisplayValue("Reading list");

    // Cmd+2 is the second page of the list as it is drawn, which is Ideas:
    // the journal between them in page order has no row to be counted.
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });

    expect(await screen.findByDisplayValue("Ideas")).toBeTruthy();
  });

  it("folds a section away at its header and back", async () => {
    render(<App api={journalApi()} />);
    await screen.findByDisplayValue("Reading list");

    const pages = sidebar().getByRole("region", { name: "Pages" });
    const header = within(pages).getByText("Pages");
    const fold = header.closest("details");

    expect(fold?.open).toBe(true);
    fireEvent.click(header);
    expect(fold?.open).toBe(false);
    fireEvent.click(header);
    expect(fold?.open).toBe(true);
  });

  it("counts the listed pages beside the Pages header", async () => {
    render(<App api={journalApi()} />);
    await screen.findByDisplayValue("Reading list");

    const pages = sidebar().getByRole("region", { name: "Pages" });

    // Two named pages and one journal day: the journal has no row, so it is
    // not in the count either.
    expect(within(pages).getByText("2")).toBeTruthy();
  });

  it("opens today from the Journals section", async () => {
    render(<App api={journalApi()} />);
    await screen.findByDisplayValue("Reading list");

    const journals = within(sidebar().getByRole("region", { name: "Journals" }));
    fireEvent.click(journals.getByRole("button", { name: /Today/u }));

    expect(await screen.findByDisplayValue(TODAY)).toBeTruthy();
  });
});
