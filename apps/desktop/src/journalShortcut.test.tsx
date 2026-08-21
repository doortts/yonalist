import {
  fireEvent, render, screen, waitFor, within
} from "@testing-library/react";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { CommandEnvelope } from "../../../packages/contracts/generated/CommandEnvelope";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "./api";
import { App } from "./App";
import { localDateIso } from "./outline/outlineSlash";
import { JOURNALS_ID, ROOT_ID } from "./store/storeSupport";
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

/**
 * `rows` is what today's journal holds; an empty `pages` list is a day nobody
 * has written in yet.
 */
function shortcutApi(options: {
  readonly journalExists: boolean;
  readonly rows?: readonly NoteView[];
}): NotesApi {
  const api = appApi();
  const pages = [
    { id: "page-1", title: "Reading list", sortKey: 1_024 },
    ...(options.journalExists
      ? [{ id: "journal-1", title: TODAY, sortKey: 2_048 }]
      : [])
  ];
  const boot: BootSnapshot = {
    sessionId: "journal-session",
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
    pageNode: request.pageId === "journal-1"
      ? node("journal-1", ROOT_ID, TODAY)
      : node("page-1", ROOT_ID, "Reading list"),
    nodes: request.pageId === "journal-1" ? [...(options.rows ?? [])] : []
  }));
  return api;
}

function commands(api: NotesApi): readonly CommandEnvelope["command"][] {
  return vi.mocked(api.execute).mock.calls.map(([envelope]) => envelope.command);
}

function pressJournalShortcut(): void {
  fireEvent.keyDown(window, { key: "J", ctrlKey: true, shiftKey: true });
}

describe("the journal shortcut", () => {
  it("opens today and leaves the caret in a row waiting to be typed in", async () => {
    const api = shortcutApi({
      journalExists: true,
      rows: [node("row-1", "journal-1", "already here")]
    });
    render(<App api={api} />);
    await screen.findByDisplayValue("Reading list");

    pressJournalShortcut();

    await screen.findByDisplayValue(TODAY);
    const created = commands(api).find((command) =>
      command.kind === "createNode" && command.parent_id === "journal-1");
    expect(created).toBeTruthy();
    await waitFor(() => {
      const focused = document.activeElement as HTMLTextAreaElement | null;
      expect(focused?.tagName).toBe("TEXTAREA");
      expect(focused?.value).toBe("");
    });
  });

  it("keeps the empty row a day already ends with", async () => {
    const api = shortcutApi({
      journalExists: true,
      rows: [
        node("row-1", "journal-1", "already here"),
        node("row-2", "journal-1", "", 2_048)
      ]
    });
    render(<App api={api} />);
    await screen.findByDisplayValue("Reading list");

    pressJournalShortcut();

    await screen.findByDisplayValue(TODAY);
    await waitFor(() => {
      const focused = document.activeElement as HTMLTextAreaElement | null;
      expect(focused?.tagName).toBe("TEXTAREA");
      expect(focused?.value).toBe("");
    });
    expect(commands(api).filter((command) => command.kind === "createNode"))
      .toHaveLength(0);
  });

  it("opens the same unwritten day twice without recording a move", async () => {
    const api = shortcutApi({ journalExists: false });
    render(<App api={api} />);
    await screen.findByDisplayValue("Reading list");
    const sidebar = within(screen.getByRole("navigation", { name: "Navigation" }));
    const today = within(sidebar.getByRole("region", { name: "Journals" }))
      .getByRole("button", { name: /^Today/u });

    fireEvent.click(today);
    await screen.findByDisplayValue(TODAY);
    fireEvent.click(today);

    // A day nobody has written in has no row in the page list, so a guard that
    // reads the list would mint a second page for the same day and record a
    // step that moves nothing. One Undo goes back to where the reader came
    // from, not to the day they are already standing on.
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(await screen.findByDisplayValue("Reading list")).toBeTruthy();
  });

  it("writes the day and its first row when the day has no page yet", async () => {
    const api = shortcutApi({ journalExists: false });
    render(<App api={api} />);
    await screen.findByDisplayValue("Reading list");

    pressJournalShortcut();

    // Three writes on a vault whose first day this is: the node every day
    // hangs from, the day, then the row to type on.
    await waitFor(() => expect(
      commands(api).filter((command) => command.kind === "createNode")
    ).toHaveLength(3));
    const [journals, page, row] = commands(api)
      .filter((command) => command.kind === "createNode");
    expect(journals).toMatchObject({
      id: JOURNALS_ID, parent_id: ROOT_ID, text: "Journals"
    });
    expect(page).toMatchObject({ parent_id: JOURNALS_ID, text: TODAY });
    expect(row).toMatchObject({ parent_id: page.id, text: "" });
  });
});
