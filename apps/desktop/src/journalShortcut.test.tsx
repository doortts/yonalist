import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { CommandEnvelope } from "../../../packages/contracts/generated/CommandEnvelope";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "./api";
import { App } from "./App";
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

  it("writes the day and its first row when the day has no page yet", async () => {
    const api = shortcutApi({ journalExists: false });
    render(<App api={api} />);
    await screen.findByDisplayValue("Reading list");

    pressJournalShortcut();

    await waitFor(() => expect(
      commands(api).filter((command) => command.kind === "createNode")
    ).toHaveLength(2));
    const [page, row] = commands(api)
      .filter((command) => command.kind === "createNode");
    expect(page).toMatchObject({ parent_id: ROOT_ID, text: TODAY });
    expect(row).toMatchObject({ parent_id: page.id, text: "" });
  });
});
