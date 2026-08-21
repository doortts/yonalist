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

function carryApi(
  earlierRows: readonly NoteView[],
  openRows: readonly NoteView[] = []
): NotesApi {
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
      nodes: [...openRows]
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
  // The earlier days answer with what is still on them, so a carry-over that
  // lands really does empty them and an undo really does put them back. A fake
  // that answers the same rows forever cannot tell a stale count from a fresh
  // one, which is the whole of what these tests are about.
  let onEarlierDays = [...earlierRows];
  let carried: NoteView[] = [];
  let revision = 3;
  api.queryForest = vi.fn().mockImplementation(async () => ({
    revision,
    nodes: onEarlierDays.map((node) => ({ ...node })),
    complete: true
  }));
  api.execute = vi.fn().mockImplementation(async (
    envelope: CommandEnvelope
  ) => {
    revision += 1;
    const command = envelope.command;
    if (command.kind !== "moveNodes") {
      return {
        revision,
        changedNodes: [],
        deletedIds: [],
        history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
      };
    }
    const moving = new Set(command.moves.map((move) => move.id));
    carried = onEarlierDays.filter((node) => moving.has(node.id));
    onEarlierDays = onEarlierDays.filter((node) => !moving.has(node.id));
    return {
      revision,
      changedNodes: carried.map((node) => ({
        ...node,
        parentId: "journal-1"
      })),
      deletedIds: [],
      history: { canUndo: true, canRedo: false, undoDepth: 1, redoDepth: 0 }
    };
  });
  api.undo = vi.fn().mockImplementation(async () => {
    revision += 1;
    onEarlierDays = [...onEarlierDays, ...carried];
    const restored = carried.map((node) => ({ ...node }));
    carried = [];
    return {
      revision,
      changedNodes: restored,
      deletedIds: [],
      history: { canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 1 }
    };
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

  it("has nothing left to offer once the rows have landed", async () => {
    const api = carryApi([row("todo-open", "journal-0", { marker: "todo" })]);
    render(<App api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "Carry over 1" }));

    // The days it reads are the same days either side of the move, so a count
    // that followed only the day list would go on offering a row that is
    // already on this page -- and a second press would move it twice.
    await waitFor(() => expect(
      screen.queryByRole("button", { name: /^Carry over/u })
    ).toBeNull());
  });

  it("takes one Undo to put the carried rows back", async () => {
    const api = carryApi([row("todo-open", "journal-0", { marker: "todo" })]);
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Carry over 1" }));
    // Waited for, not assumed: the button has to have actually emptied, or the
    // one found after the undo is only the one that never left.
    await waitFor(() => expect(
      screen.queryByRole("button", { name: /^Carry over/u })
    ).toBeNull());

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });

    // One command went out, so one step comes back: the row is on the day it
    // was written on again, which is why the button can offer it a second time.
    await waitFor(() => expect(api.undo).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "Carry over 1" }))
      .toBeTruthy();
  });

  it("carries without closing a split or dropping a zoom", async () => {
    const api = carryApi(
      [row("todo-open", "journal-0", { marker: "todo" })],
      // One row on the open day, to zoom into.
      [{ ...row("here", "journal-1"), text: "already here" }]
    );
    render(<App api={api} />);
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Zoom to item" }))[0]!
    );
    const zoomed = await screen.findByDisplayValue("already here");
    await waitFor(() =>
      expect(zoomed).toHaveAttribute("aria-label", "Page title"));

    fireEvent.click(await screen.findByRole("button", { name: "Carry over 1" }));

    // Nothing about where the reader is standing changed: the same page is
    // open, inside the same zoom.
    await waitFor(() => expect(commands(api)).toHaveLength(1));
    expect(await screen.findByDisplayValue("already here"))
      .toHaveAttribute("aria-label", "Page title");
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
