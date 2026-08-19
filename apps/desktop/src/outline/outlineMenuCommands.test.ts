import type { NoteView } from "../../../../packages/contracts/generated/NoteView";
import type { NotesStore } from "../notesStore";
import {
  OUTLINE_MENU_COMMANDS,
  outlineMenuCommands,
  type OutlineMenuCommandId,
  type OutlineMenuContext,
  type OutlineMenuMode,
  type OutlinePlatform
} from "./outlineMenuCommands";
import { buildOutlineClipboardFormats } from "./outlineClipboard";
import { OUTLINE_TAG_MAX_ROWS } from "./outlineTagEdits";
import { buildSelectionMovePlans } from "../selectionMoves";

const ROOT = "page-1";

function bullet(
  id: string,
  parentId: string | null,
  sortKey: number,
  extra: Partial<NoteView> = {}
): NoteView {
  return {
    id,
    parentId,
    sortKey,
    kind: "bullet",
    image: null,
    text: id,
    note: "",
    marker: "bullet",
    collapsed: false,
    completed: false,
    starred: false,
    deleted: false,
    ...extra
  };
}

// page-1 > a, b, c ; a > x, y
const TREE: readonly NoteView[] = [
  bullet("a", ROOT, 1024),
  bullet("b", ROOT, 2048),
  bullet("c", ROOT, 3072),
  bullet("x", "a", 1024),
  bullet("y", "a", 2048)
];

function command(id: OutlineMenuCommandId) {
  const found = OUTLINE_MENU_COMMANDS.find((entry) => entry.id === id);
  if (!found) throw new Error(`no command ${id}`);
  return found;
}

function context(overrides: {
  readonly mode?: OutlineMenuMode;
  readonly platform?: OutlinePlatform;
  readonly node?: NoteView;
  readonly nodes?: readonly NoteView[];
  readonly rootIds?: readonly string[];
  readonly allCompleted?: boolean;
  readonly cutRefusal?: string | null;
  readonly forestComplete?: boolean;
  readonly outlineComplete?: boolean;
  readonly openMoveTo?: () => void;
  readonly openTags?: () => void;
} = {}): OutlineMenuContext {
  const nodes = overrides.nodes ?? TREE;
  const rootIds = overrides.rootIds ?? ["a"];
  return {
    mode: overrides.mode ?? "selection",
    platform: overrides.platform ?? "other",
    node: overrides.node ?? nodes[0],
    store: {} as NotesStore,
    hasNote: false,
    allCompleted: overrides.allCompleted ?? false,
    cutRefusal: overrides.cutRefusal ?? null,
    forestComplete: overrides.forestComplete ?? true,
    // With nothing selected the pane reads the same value into both, which is
    // what makes the default follow the forest.
    outlineComplete: overrides.outlineComplete ?? overrides.forestComplete ?? true,
    targetCount: overrides.mode === "row" ? 1 : rootIds.length,
    openMoveTo: overrides.openMoveTo ?? vi.fn(),
    openTags: overrides.openTags ?? vi.fn(),
    plans: buildSelectionMovePlans(
      nodes,
      nodes.map((entry) => entry.id),
      rootIds,
      ROOT
    ),
    row: {
      addNote: vi.fn(),
      addSibling: vi.fn(),
      duplicate: vi.fn(),
      pickImage: vi.fn()
    },
    selection: {
      indent: vi.fn(),
      outdent: vi.fn(),
      move: vi.fn(),
      toggleComplete: vi.fn(),
      duplicate: vi.fn(),
      delete: vi.fn(),
      copy: vi.fn(),
      cut: vi.fn()
    }
  };
}

/** A store stub whose snapshot is all the clipboard commands read. */
function clipboardStore(nodes: readonly NoteView[], writeText: unknown) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true
  });
  const deleteSubtree = vi.fn().mockResolvedValue(undefined);
  return {
    deleteSubtree,
    store: {
      getSnapshot: () => ({
        nodes,
        drafts: {},
        noteDrafts: {},
        sessionId: "session-1"
      }),
      deleteSubtree
    } as unknown as NotesStore
  };
}

function unavailable(id: OutlineMenuCommandId, ctx: OutlineMenuContext) {
  const result = command(id).eligibility(ctx);
  expect(result.available).toBe(false);
  return result.available ? "" : result.reason;
}

describe("the outline menu command table", () => {
  it("holds exactly one entry per id and no duplicates", () => {
    const ids = OUTLINE_MENU_COMMANDS.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("orders selection mode the way the parity spec documents", () => {
    expect(outlineMenuCommands("selection").map((entry) => entry.id)).toEqual([
      "complete", "moveTo", "moveUp", "moveDown", "indent", "outdent",
      "duplicate", "tags", "copy", "cut", "delete"
    ]);
  });

  it("keeps today's row items and slots the new ones before Delete", () => {
    expect(outlineMenuCommands("row").map((entry) => entry.id)).toEqual([
      "addNote", "addSibling", "marker", "duplicate", "uploadImage", "complete",
      "star", "moveTo", "moveUp", "moveDown", "indent", "outdent", "tags",
      "copy", "cut", "delete"
    ]);
  });

  it("prints the sibling chord beside Add sibling", () => {
    const command = outlineMenuCommands("row")
      .find((entry) => entry.id === "addSibling");

    expect(command?.binding?.hint).toEqual({
      mac: "⌘⇧↩",
      other: "Ctrl+Shift+Enter"
    });
    expect(command?.binding?.keys).toEqual({
      mac: "Meta+Shift+Enter",
      other: "Control+Shift+Enter"
    });
  });

  it("leaves Add sibling out of the selection menu", () => {
    expect(outlineMenuCommands("selection").map((entry) => entry.id))
      .not.toContain("addSibling");
  });

  it("puts Tags after Duplicate and before Copy in both modes", () => {
    for (const mode of ["row", "selection"] as const) {
      const ids = outlineMenuCommands(mode).map((entry) => entry.id);

      expect(ids.indexOf("tags"), mode).toBeGreaterThan(ids.indexOf("duplicate"));
      expect(ids.indexOf("copy"), mode).toBe(ids.indexOf("tags") + 1);
    }
  });

  it("heads the move commands with Move To in both modes", () => {
    for (const mode of ["row", "selection"] as const) {
      const ids = outlineMenuCommands(mode).map((entry) => entry.id);

      expect(ids, mode).toContain("moveTo");
      expect(ids.indexOf("moveUp"), mode).toBe(ids.indexOf("moveTo") + 1);
    }
    // Selection mode follows the legacy order exactly: Move To after Complete.
    expect(outlineMenuCommands("selection")[1].id).toBe("moveTo");
  });

  it("puts Copy and Cut after Duplicate and before Delete in both modes", () => {
    for (const mode of ["row", "selection"] as const) {
      const ids = outlineMenuCommands(mode).map((entry) => entry.id);

      expect(ids.indexOf("copy"), mode).toBeGreaterThan(ids.indexOf("duplicate"));
      expect(ids.indexOf("cut"), mode).toBe(ids.indexOf("copy") + 1);
      expect(ids.indexOf("delete"), mode).toBe(ids.indexOf("cut") + 1);
    }
  });

  it("ends on delete in both modes, it being the only destructive one", () => {
    for (const mode of ["row", "selection"] as const) {
      expect(outlineMenuCommands(mode).at(-1)?.id, mode).toBe("delete");
    }
  });

  it("draws every ordered command from the table itself", () => {
    for (const mode of ["row", "selection"] as const) {
      for (const entry of outlineMenuCommands(mode)) {
        expect(OUTLINE_MENU_COMMANDS).toContain(entry);
      }
    }
  });
});

describe("outline menu labels", () => {
  it("reads Uncomplete once the whole selection is complete", () => {
    expect(command("complete").label(context({ allCompleted: false })))
      .toBe("Complete");
    expect(command("complete").label(context({ allCompleted: true })))
      .toBe("Uncomplete");
  });

  it("reads Uncomplete for a single completed row", () => {
    const done = bullet("a", ROOT, 1024, { completed: true });

    expect(command("complete").label(
      context({ mode: "row", node: TREE[0], allCompleted: false })
    )).toBe("Complete");
    expect(command("complete").label(
      context({ mode: "row", node: done, allCompleted: true })
    )).toBe("Uncomplete");
  });

  it("flips the marker label with the node's marker", () => {
    expect(command("marker").label(context({ mode: "row" })))
      .toBe("To-do");
    expect(command("marker").label(context({
      mode: "row",
      node: bullet("a", ROOT, 1024, { marker: "todo" })
    }))).toBe("Change to bullet");
  });

  it("flips the star label with the node's starred state", () => {
    expect(command("star").label(context({ mode: "row" }))).toBe("Star");
    expect(command("star").label(context({
      mode: "row",
      node: bullet("a", ROOT, 1024, { starred: true })
    }))).toBe("Unstar");
  });

  it("says Add note in both note states and Delete for the soft delete", () => {
    expect(command("addNote").label(context({ mode: "row" }))).toBe("Add note");
    expect(command("addNote").label({
      ...context({ mode: "row" }),
      hasNote: true
    })).toBe("Add note");
    expect(command("delete").label(context())).toBe("Delete");
  });

  // Workflowy spells it with three literal dots, which signal that the item
  // opens a chooser rather than moving anything by itself.
  it("spells Move To... with Workflowy's three dots", () => {
    expect(command("tags").label(context())).toBe("Tags");
    expect(command("moveTo").label(context())).toBe("Move To...");
    expect(command("moveTo").label(context({ mode: "row" }))).toBe("Move To...");
  });

  it("uses Workflowy's own names for the four new commands", () => {
    expect(command("moveUp").label(context())).toBe("Move up");
    expect(command("moveDown").label(context())).toBe("Move down");
    expect(command("indent").label(context())).toBe("Indent");
    expect(command("outdent").label(context())).toBe("Outdent");
  });
});

describe("outline menu shortcut hints", () => {
  const expected: Record<string, readonly [string, string]> = {
    complete: ["⌘↩", "Ctrl+Enter"],
    duplicate: ["⌘⇧D", "Alt+Shift+D"],
    delete: ["⌘⇧⌫", "Ctrl+Shift+Backspace"],
    moveTo: ["⌃⌘M", "Ctrl+Alt+M"],
    moveUp: ["⌃⇧↑", "Alt+Shift+↑"],
    moveDown: ["⌃⇧↓", "Alt+Shift+↓"],
    indent: ["Tab", "Tab"],
    outdent: ["⇧Tab", "Shift+Tab"],
    copy: ["⌘C", "Ctrl+C"],
    cut: ["⌘X", "Ctrl+X"]
  };
  const expectedKeys: Record<string, readonly [string, string]> = {
    complete: ["Meta+Enter", "Control+Enter"],
    duplicate: ["Meta+Shift+D", "Alt+Shift+D"],
    delete: ["Meta+Shift+Backspace", "Control+Shift+Backspace"],
    moveTo: ["Control+Meta+M", "Control+Alt+M"],
    moveUp: ["Control+Shift+ArrowUp", "Alt+Shift+ArrowUp"],
    moveDown: ["Control+Shift+ArrowDown", "Alt+Shift+ArrowDown"],
    indent: ["Tab", "Tab"],
    outdent: ["Shift+Tab", "Shift+Tab"],
    copy: ["Meta+C", "Control+C"],
    cut: ["Meta+X", "Control+X"]
  };

  it("resolves a hint and an aria-keyshortcuts string for both platforms", () => {
    for (const [id, [mac, other]] of Object.entries(expected)) {
      const binding = command(id as OutlineMenuCommandId).binding;
      expect(binding?.hint.mac, id).toBe(mac);
      expect(binding?.hint.other, id).toBe(other);
    }
    for (const [id, [mac, other]] of Object.entries(expectedKeys)) {
      const binding = command(id as OutlineMenuCommandId).binding;
      expect(binding?.keys.mac, id).toBe(mac);
      expect(binding?.keys.other, id).toBe(other);
    }
  });

  it("leaves the commands Workflowy never bound without a hint", () => {
    for (const id of [
      "addNote", "marker", "uploadImage", "star", "tags"
    ] as const) {
      expect(command(id).binding, id).toBeUndefined();
    }
  });
});

describe("outline menu eligibility", () => {
  it("refuses to reorder non-contiguous roots", () => {
    const ctx = context({ rootIds: ["a", "c"] });

    expect(unavailable("moveUp", ctx)).toBe("Reorder requires contiguous siblings.");
    expect(unavailable("moveDown", ctx))
      .toBe("Reorder requires contiguous siblings.");
  });

  it("refuses to reorder or duplicate roots under two parents", () => {
    const ctx = context({ rootIds: ["a", "x"] });

    expect(unavailable("moveUp", ctx)).toBe("Reorder requires one shared parent.");
    expect(unavailable("duplicate", ctx))
      .toBe("Duplicate requires one shared parent.");
  });

  it("refuses to move the first root up or the last root down", () => {
    expect(unavailable("moveUp", context({ rootIds: ["a"] })))
      .toBe("The selection is already at that boundary.");
    expect(unavailable("moveDown", context({ rootIds: ["c"] })))
      .toBe("The selection is already at that boundary.");
    expect(command("moveDown").eligibility(context({ rootIds: ["a"] })).available)
      .toBe(true);
  });

  it("refuses to indent when the first root has no preceding sibling", () => {
    expect(unavailable("indent", context({ rootIds: ["a"] })))
      .toBe("The first selected item has no preceding visible sibling.");
    expect(unavailable("indent", context({ rootIds: ["a", "b"] })))
      .toBe("The first selected item has no preceding visible sibling.");
    expect(command("indent").eligibility(context({ rootIds: ["b"] })).available)
      .toBe(true);
  });

  it("refuses to outdent when every root already sits at the zoom root", () => {
    expect(unavailable("outdent", context({ rootIds: ["a", "b"] })))
      .toBe("The selection cannot move outside this outline.");
    expect(command("outdent").eligibility(context({ rootIds: ["x"] })).available)
      .toBe(true);
  });

  it("keeps the commands with no plan behind them always available", () => {
    const ctx = context({ mode: "row" });

    for (const id of ["addNote", "marker", "uploadImage", "complete", "star",
      "delete"] as const) {
      expect(command(id).eligibility(ctx).available, id).toBe(true);
    }
  });

  // The chooser lists every destination in the workspace, so it cannot open
  // until the same forest the mutating selection commands wait for has loaded.
  it("refuses Move To until the complete forest is loaded", () => {
    for (const mode of ["row", "selection"] as const) {
      expect(unavailable("moveTo", context({ mode, forestComplete: false })))
        .toBe("Load the complete outline first.");
      expect(
        command("moveTo").eligibility(context({ mode })).available, mode
      ).toBe(true);
    }
  });

  // Past the coalescer's cap one tag operation would quietly become several
  // undo steps, so the menu refuses the batch instead of splitting it.
  it("bounds Tags at the rows one history entry can hold", () => {
    const rootIds = TREE.map((node) => node.id);

    expect(command("tags").eligibility({
      ...context({ rootIds }), targetCount: OUTLINE_TAG_MAX_ROWS
    }).available).toBe(true);
    expect(unavailable("tags", {
      ...context({ rootIds }), targetCount: OUTLINE_TAG_MAX_ROWS + 1
    })).toBe(`Tag up to ${OUTLINE_TAG_MAX_ROWS} rows at a time.`);
  });

  // The one refusal left over from the selection: a forest still loading.
  it("hands Cut's refusal straight through from the selection guard", () => {
    expect(command("cut").eligibility(context({ cutRefusal: null })).available)
      .toBe(true);
    expect(unavailable("cut", context({
      cutRefusal: "The complete selection is not available yet."
    }))).toBe("The complete selection is not available yet.");
  });

  // Copy never deletes, so it loses nothing that was not already on screen; it
  // stays reachable when every mutation is refused.
  it("keeps Copy available even where Cut and every move are refused", () => {
    const ctx = context({
      rootIds: ["a", "x"],
      cutRefusal: "The complete selection is not available yet."
    });

    expect(command("copy").eligibility(ctx).available).toBe(true);
    expect(command("cut").eligibility(ctx).available).toBe(false);
    expect(command("moveUp").eligibility(ctx).available).toBe(false);
  });
});

describe("outline menu execution", () => {
  it("takes the tick off with the box, in one step", () => {
    const store = {
      setMarker: vi.fn(),
      setCompleted: vi.fn()
    } as unknown as NotesStore;
    const done = {
      ...TREE[0], marker: "todo" as const, completed: true
    };

    command("marker").execute({
      ...context({ mode: "row", node: done }),
      store
    });

    const [markerCall] = vi.mocked(store.setMarker).mock.calls;
    const [completedCall] = vi.mocked(store.setCompleted).mock.calls;
    expect(markerCall?.slice(0, 2)).toEqual([done.id, "bullet"]);
    expect(completedCall?.slice(0, 2)).toEqual([done.id, false]);
    // One undo, not two: the step between them is a finished bullet with no
    // box, struck through and with nothing left to untick it.
    expect(markerCall?.[2]).toBe(completedCall?.[2]);
    expect(markerCall?.[2]).toEqual(expect.stringMatching(/^marker:/));
  });

  it("leaves the tick alone on a row that is only gaining a box", () => {
    const store = {
      setMarker: vi.fn(),
      setCompleted: vi.fn()
    } as unknown as NotesStore;
    const done = { ...TREE[0], completed: true };

    command("marker").execute({
      ...context({ mode: "row", node: done }),
      store
    });

    expect(store.setMarker).toHaveBeenCalledOnce();
    expect(store.setCompleted).not.toHaveBeenCalled();
  });


  it("runs the selection thunks in selection mode", () => {
    const ctx = context({ rootIds: ["b"] });

    command("complete").execute(ctx);
    command("duplicate").execute(ctx);
    command("delete").execute(ctx);
    command("indent").execute(ctx);
    command("moveUp").execute(ctx);

    expect(ctx.selection.toggleComplete).toHaveBeenCalledOnce();
    expect(ctx.selection.duplicate).toHaveBeenCalledOnce();
    expect(ctx.selection.delete).toHaveBeenCalledOnce();
    expect(ctx.selection.indent).toHaveBeenCalledOnce();
    expect(ctx.selection.move).toHaveBeenCalledWith("up");
  });

  // The menu item opens the chooser and nothing more; the move itself is the
  // chooser's business, in both modes.
  it("only opens the chooser for Move To", () => {
    for (const mode of ["row", "selection"] as const) {
      const openMoveTo = vi.fn();
      const ctx = context({ mode, openMoveTo });

      command("moveTo").execute(ctx);

      expect(openMoveTo, mode).toHaveBeenCalledOnce();
    }
  });

  it("only opens the chooser for Tags", () => {
    for (const mode of ["row", "selection"] as const) {
      const openTags = vi.fn();
      const ctx = context({ mode, openTags });

      command("tags").execute(ctx);

      expect(openTags, mode).toHaveBeenCalledOnce();
    }
  });

  it("routes Copy and Cut to the selection thunks in selection mode", () => {
    const ctx = context({ rootIds: ["b"] });

    command("copy").execute(ctx);
    command("cut").execute(ctx);

    expect(ctx.selection.copy).toHaveBeenCalledOnce();
    expect(ctx.selection.cut).toHaveBeenCalledOnce();
  });

  it("runs the row callbacks and the store in row mode", () => {
    const moveNodes = vi.fn().mockResolvedValue(undefined);
    const deleteSubtree = vi.fn().mockResolvedValue(undefined);
    const ctx: OutlineMenuContext = {
      ...context({ mode: "row", rootIds: ["b"], node: TREE[1] }),
      store: { moveNodes, deleteSubtree } as unknown as NotesStore
    };

    command("addNote").execute(ctx);
    command("duplicate").execute(ctx);
    command("uploadImage").execute(ctx);
    command("delete").execute(ctx);
    command("moveUp").execute(ctx);

    expect(ctx.row.addNote).toHaveBeenCalledOnce();
    expect(ctx.row.duplicate).toHaveBeenCalledOnce();
    expect(ctx.row.pickImage).toHaveBeenCalledOnce();
    expect(deleteSubtree).toHaveBeenCalledWith("b");
    expect(moveNodes).toHaveBeenCalledWith([
      { id: "b", parentId: ROOT, beforeId: "a" }
    ]);
    expect(ctx.selection.move).not.toHaveBeenCalled();
  });

  it("does nothing in row mode when the plan is unavailable", () => {
    const moveNodes = vi.fn();
    const ctx: OutlineMenuContext = {
      ...context({ mode: "row", rootIds: ["a"], node: TREE[0] }),
      store: { moveNodes } as unknown as NotesStore
    };

    command("moveUp").execute(ctx);

    expect(moveNodes).not.toHaveBeenCalled();
  });
});

// page-1 > a > x > deep, plus a sibling b: deep enough that a row-scoped
// serialization that ignored descendants or mis-indented them would show.
const DEEP: readonly NoteView[] = [
  bullet("a", ROOT, 1024),
  bullet("b", ROOT, 2048),
  bullet("x", "a", 1024),
  bullet("deep", "x", 1024)
];

/** jsdom has no ClipboardItem, so the item write is read off this one. */
class FakeClipboardItem {
  constructor(readonly data: Record<string, Blob>) {}
}

/** The only write a Cut accepts: one item carrying every format. */
function stubItemClipboard(write: unknown, writeText: unknown = vi.fn()) {
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  Object.defineProperty(navigator, "clipboard", {
    value: { write, writeText },
    configurable: true
  });
}

describe("single-row Copy and Cut", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  function rowContext(
    writeText: unknown,
    nodes: readonly NoteView[] = DEEP,
    forestComplete = true
  ) {
    const { store, deleteSubtree } = clipboardStore(nodes, writeText);
    return {
      deleteSubtree,
      ctx: {
        ...context({
          mode: "row",
          nodes,
          node: nodes[0],
          rootIds: ["a"],
          forestComplete
        }),
        store
      } as OutlineMenuContext
    };
  }

  it("copies the clicked row's whole subtree, matching the selection path", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { ctx } = rowContext(writeText);

    command("copy").execute(ctx);

    expect(writeText).toHaveBeenCalledWith("- a\n  - x\n    - deep");
    // The one-row menu path and a one-row selection must agree byte for byte.
    expect(writeText).toHaveBeenCalledWith(
      buildOutlineClipboardFormats(
        { nodes: DEEP, drafts: {}, noteDrafts: {} },
        ["a"]
      )!.plain
    );
  });

  // jsdom has no ClipboardItem, so the row path degrades to writeText above.
  // With one present the same copy has to carry the rich payload too.
  it("carries the rich payload when the clipboard takes an item", async () => {
    const { ctx } = rowContext(vi.fn());
    const write = vi.fn().mockResolvedValue(undefined);
    stubItemClipboard(write);

    command("copy").execute(ctx);

    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    const item = write.mock.calls[0]![0]![0] as FakeClipboardItem;
    expect(await item.data["text/html"]!.text()).toBe(
      buildOutlineClipboardFormats(
        { nodes: DEEP, drafts: {}, noteDrafts: {} },
        ["a"]
      )!.html
    );
  });

  it("cuts a row by writing the subtree first and deleting only after", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const { ctx, deleteSubtree } = rowContext(vi.fn());
    stubItemClipboard(write);

    command("cut").execute(ctx);

    // Read before the await: WebKit drops a clipboard write that leaves after
    // the gesture that asked for it, so the write has to be out already.
    const item = write.mock.calls[0]![0]![0] as FakeClipboardItem;
    expect(deleteSubtree).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(deleteSubtree).toHaveBeenCalledWith("a"));
    expect(await item.data["text/plain"]!.text())
      .toBe("- a\n  - x\n    - deep");
  });

  it("keeps the row when the item write is refused", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { ctx, deleteSubtree } = rowContext(vi.fn());
    const write = vi.fn().mockRejectedValue(new Error("denied"));
    stubItemClipboard(write, writeText);

    command("cut").execute(ctx);
    await vi.waitFor(() => expect(write).toHaveBeenCalled());

    expect(deleteSubtree).not.toHaveBeenCalled();
  });

  // Plain text carries no payload, so a row deleted against it could not come
  // back. A copy may degrade to it; a cut may not.
  it("keeps the row when the clipboard takes plain text only", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { ctx, deleteSubtree } = rowContext(writeText);

    command("cut").execute(ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writeText).not.toHaveBeenCalled();
    expect(deleteSubtree).not.toHaveBeenCalled();
  });

  // One clicked row is not always a row Cut can carry: its subtree can outrun
  // the clipboard format, and the snapshot it serializes from is only the
  // window that has loaded.
  it("refuses a row Cut the clipboard or the loaded window cannot carry", () => {
    const oversized = DEEP.map((node) => node.id === "deep"
      ? { ...node, note: "x".repeat(100_001) }
      : node);

    expect(command("cut").eligibility(rowContext(vi.fn()).ctx).available)
      .toBe(true);
    expect(unavailable("cut", rowContext(vi.fn(), oversized).ctx)).toBe(
      "Cut is unavailable because these rows are too large for the clipboard."
    );
    expect(unavailable("cut", rowContext(vi.fn(), DEEP, false).ctx))
      .toBe("The complete selection is not available yet.");
  });

  // The window above is the only gate here. A right-clicked row was never part
  // of a selection, so a band still waiting on its own forest says nothing
  // about whether this row can be carried.
  it("cuts a row while an unrelated selection waits on its forest", () => {
    const { ctx } = rowContext(vi.fn());

    expect(command("cut").eligibility({
      ...ctx,
      forestComplete: false,
      cutRefusal: "The complete selection is not available yet."
    }).available).toBe(true);
  });
});
