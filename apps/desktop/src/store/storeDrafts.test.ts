import type { MutationReceipt } from "../../../../packages/contracts/generated/MutationReceipt";
import { initialNotesState, type NotesState } from "../notesState";
import { StoreDrafts } from "./storeDrafts";
import { DRAFT_CEILING_MS, DRAFT_DEBOUNCE_MS } from "./storeSupport";

function node(text: string) {
  return {
    id: "one",
    parentId: "page-1",
    sortKey: 1_024,
    kind: "bullet" as const, image: null,
    text,
    note: "",
    marker: "bullet" as const,
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false
  };
}

function receipt(text: string, revision: number): MutationReceipt {
  return {
    revision,
    changedNodes: [node(text)],
    deletedIds: [],
    history: {
      canUndo: true,
      canRedo: false,
      undoDepth: 1,
      redoDepth: 0
    }
  };
}

function drafting() {
  let state: NotesState = {
    ...initialNotesState,
    status: "ready",
    sessionId: "session-1",
    revision: 1,
    activePageId: "page-1",
    nodes: [node("")]
  };
  const execute = vi.fn(async (
    command,
    _historyGroup: string | null = null
  ) => {
    const next = receipt(
      command.kind === "updateText" ? command.text : "",
      state.revision + 1
    );
    state = { ...state, revision: next.revision, nodes: next.changedNodes };
    return next;
  });
  const breakHistoryGroup = vi.fn();
  const drafts = new StoreDrafts({
    read: () => state,
    write: (patch) => {
      state = { ...state, ...patch };
    },
    execute,
    settled: vi.fn().mockResolvedValue(undefined),
    breakHistoryGroup
  });
  return { drafts, execute, breakHistoryGroup };
}

describe("StoreDrafts", () => {
  it("keeps repeated Backspace flushes in one history group", async () => {
    let state: NotesState = {
      ...initialNotesState,
      status: "ready",
      sessionId: "session-1",
      revision: 1,
      activePageId: "page-1",
      nodes: [node("one")]
    };
    const execute = vi.fn(async (
      command,
      _historyGroup: string | null = null
    ) => {
      if (command.kind !== "updateText") throw new Error("expected updateText");
      const next = receipt(command.text, state.revision + 1);
      state = {
        ...state,
        revision: next.revision,
        nodes: next.changedNodes
      };
      return next;
    });
    const drafts = new StoreDrafts({
      read: () => state,
      write: (patch) => {
        state = { ...state, ...patch };
      },
      execute,
      settled: vi.fn().mockResolvedValue(undefined),
      breakHistoryGroup: vi.fn()
    });

    const firstGroup = drafts.beginBackspace(false);
    drafts.setTitle("one", "on");
    await drafts.flushTitle("one");
    const repeatedGroup = drafts.beginBackspace(true);
    drafts.setTitle("one", "o");
    await drafts.flushTitle("one");
    drafts.endBackspace();

    expect(repeatedGroup).toBe(firstGroup);
    expect(execute.mock.calls.map(([, group]) => group))
      .toEqual([firstGroup, firstGroup]);
  });

  it("flushes title and note drafts before waiting for command settlement", async () => {
    let state: NotesState = {
      ...initialNotesState,
      status: "ready",
      sessionId: "session-1",
      activePageId: "page-1",
      nodes: [node("one")]
    };
    const order: string[] = [];
    const execute = vi.fn(async (command) => {
      order.push(command.kind);
      return receipt(
        command.kind === "updateText" ? command.text : "one",
        state.revision + 1
      );
    });
    const drafts = new StoreDrafts({
      read: () => state,
      write: (patch) => {
        state = { ...state, ...patch };
      },
      execute,
      settled: async () => {
        order.push("settled");
      },
      breakHistoryGroup: vi.fn()
    });
    drafts.setTitle("one", "title");
    drafts.setNote("one", "note");

    await drafts.flushAll();

    expect(order).toEqual(["updateText", "updateNote", "settled"]);
  });
  it("keeps a failing debounced flush out of unhandledRejection", async () => {
    let state: NotesState = {
      ...initialNotesState,
      status: "ready",
      sessionId: "session-1",
      revision: 1,
      activePageId: "page-1",
      nodes: [node("one")]
    };
    const escaped: unknown[] = [];
    const listener = (reason: unknown) => escaped.push(reason);
    process.on("unhandledRejection", listener);
    const execute = vi.fn().mockRejectedValue(new Error("boom"));
    try {
      const drafts = new StoreDrafts({
        read: () => state,
        write: (patch) => {
          state = { ...state, ...patch };
        },
        execute,
        settled: vi.fn().mockResolvedValue(undefined),
        breakHistoryGroup: vi.fn()
      });
      vi.useFakeTimers();
      drafts.setTitle("one", "typed");
      drafts.setNote("one", "noted");
      await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);
      vi.useRealTimers();
      // Node reports an unhandled rejection one turn after the promise
      // settles, so the assertion has to stand behind that turn.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(escaped).toEqual([]);
      // Both timers reached their command. Without this the empty `escaped`
      // above would read the same on a debounce that never fired at all.
      expect(execute).toHaveBeenCalledTimes(2);
      // The containment belongs to the timer alone: a caller that awaits the
      // same flush -- a blur, a batch -- still hears the failure.
      await expect(drafts.flushTitle("one")).rejects.toThrow("boom");
    } finally {
      vi.useRealTimers();
      process.off("unhandledRejection", listener);
    }
  });
  it("skips the command when a page note draft matches the page node", async () => {
    const pageNode = {
      ...node("Today"),
      id: "page-1",
      parentId: "root",
      note: "Page context"
    };
    let state: NotesState = {
      ...initialNotesState,
      status: "ready",
      sessionId: "session-1",
      activePageId: "page-1",
      pageNode,
      nodes: [node("one")]
    };
    const execute = vi.fn();
    const drafts = new StoreDrafts({
      read: () => state,
      write: (patch) => {
        state = { ...state, ...patch };
      },
      execute,
      settled: vi.fn().mockResolvedValue(undefined),
      breakHistoryGroup: vi.fn()
    });
    drafts.setNote("page-1", "Page context");

    await drafts.flushNote("page-1");

    expect(execute).not.toHaveBeenCalled();
    expect(state.noteDrafts["page-1"]).toBeUndefined();
  });
  it("commits a title mid-run when the typing never pauses", async () => {
    vi.useFakeTimers();
    try {
      const { drafts, execute, breakHistoryGroup } = drafting();

      // Ten seconds of keystrokes 100ms apart, so the trailing debounce never
      // gets its 300ms gap and only the ceiling can commit.
      for (let stroke = 1; stroke <= 100; stroke += 1) {
        drafts.setTitle("one", "x".repeat(stroke));
        await vi.advanceTimersByTimeAsync(100);
      }

      // Once per ceiling window -- at 3.0s, 6.1s and 9.2s, each window
      // restarting at the keystroke after its commit -- not once per
      // keystroke.
      expect(execute).toHaveBeenCalledTimes(3);
      // The run is still one undo step: the fence moved once, at the first
      // keystroke, and every ceiling commit carries the run's own group.
      expect(breakHistoryGroup).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls.map(([, group]) => group))
        .toEqual(["text:one", "text:one", "text:one"]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("commits a note mid-run when the typing never pauses", async () => {
    vi.useFakeTimers();
    try {
      const { drafts, execute } = drafting();

      for (let stroke = 1; stroke <= 100; stroke += 1) {
        drafts.setNote("one", "x".repeat(stroke));
        await vi.advanceTimersByTimeAsync(100);
      }

      expect(execute).toHaveBeenCalledTimes(3);
      expect(execute.mock.calls.map(([command]) => command.kind))
        .toEqual(["updateNote", "updateNote", "updateNote"]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("commits a burst shorter than the ceiling exactly once", async () => {
    vi.useFakeTimers();
    try {
      const { drafts, execute } = drafting();

      drafts.setTitle("one", "a");
      await vi.advanceTimersByTimeAsync(50);
      drafts.setTitle("one", "ab");
      await vi.advanceTimersByTimeAsync(DRAFT_DEBOUNCE_MS);

      expect(execute).toHaveBeenCalledTimes(1);

      // The ceiling is a deadline for a run in progress, not a repeating
      // timer: silence past it commits nothing more.
      await vi.advanceTimersByTimeAsync(DRAFT_CEILING_MS * 2);

      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
