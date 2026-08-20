import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BootSnapshot } from "../../../packages/contracts/generated/BootSnapshot";
import type { CommandEnvelope } from "../../../packages/contracts/generated/CommandEnvelope";
import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesApi } from "./api";
import { App } from "./App";
import { ROOT_ID } from "./store/storeSupport";
import { appApi } from "./test/appApiFixture";

const DAY = "2026-08-24";
const BEFORE = "2026-08-23";

function row(
  id: string,
  parentId: string,
  options: {
    readonly marker?: NoteView["marker"];
    readonly completed?: boolean;
    readonly sortKey?: number;
  } = {}
): NoteView {
  return {
    id,
    parentId,
    sortKey: options.sortKey ?? 1_024,
    kind: "bullet", image: null,
    text: id,
    note: "",
    marker: options.marker ?? "bullet",
    collapsed: false,
    completed: options.completed ?? false,
    starred: false,
    deleted: false
  };
}

const PAGES = [
  { id: "journal-0", title: BEFORE, sortKey: 512 },
  { id: "journal-1", title: DAY, sortKey: 1_024 }
];

function carryApi(earlierRows: readonly NoteView[]): NotesApi {
  const api = appApi();
  const title = (id: string) =>
    PAGES.find((page) => page.id === id)?.title ?? "";
  const boot: BootSnapshot = {
    sessionId: "carry-session",
    revision: 3,
    activePageId: "journal-1",
    pages: PAGES,
    viewport: {
      pageId: "journal-1",
      anchorId: null,
      beforeCursor: null,
      afterCursor: null,
      pageNode: { ...row("journal-1", ROOT_ID), text: DAY },
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
    pageNode: { ...row(request.pageId, ROOT_ID), text: title(request.pageId) },
    nodes: []
  }));
  api.queryForest = vi.fn().mockResolvedValue({
    revision: 3,
    nodes: [...earlierRows],
    complete: true
  });
  return api;
}

function commands(api: NotesApi): readonly CommandEnvelope["command"][] {
  return vi.mocked(api.execute).mock.calls.map(([envelope]) => envelope.command);
}

describe("carrying unfinished work into the open day", () => {
  it("moves the unfinished To-dos of the days before it, in one step", async () => {
    const api = carryApi([
      row("todo-open", "journal-0", { marker: "todo" }),
      row("todo-done", "journal-0", {
        marker: "todo", completed: true, sortKey: 2_048
      })
    ]);
    render(<App api={api} />);

    const button = await screen.findByRole("button", { name: "Carry over 1" });
    fireEvent.click(button);

    await waitFor(() => expect(commands(api)).toHaveLength(1));
    expect(commands(api)[0]).toEqual({
      kind: "moveNodes",
      moves: [{ id: "todo-open", parentId: "journal-1", beforeId: null }]
    });
  });

  it("has nothing to offer when nothing was left unfinished", async () => {
    const api = carryApi([
      row("todo-done", "journal-0", { marker: "todo", completed: true })
    ]);
    render(<App api={api} />);

    await waitFor(() => expect(api.queryForest).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /^Carry over/u })).toBeNull();
  });
});
