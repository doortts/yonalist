import type { NoteView } from "../../../packages/contracts/generated/NoteView";
import type { NotesStore } from "./notesStore";
import {
  OUTLINE_MENU_COMMANDS,
  outlineMenuCommands,
  type OutlineMenuCommandId,
  type OutlineMenuContext,
  type OutlineMenuMode,
  type OutlinePlatform
} from "./outlineMenuCommands";
import { buildSelectionMovePlans } from "./selectionMoves";

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
    plans: buildSelectionMovePlans(
      nodes,
      nodes.map((entry) => entry.id),
      rootIds,
      ROOT
    ),
    row: { addNote: vi.fn(), duplicate: vi.fn(), pickImage: vi.fn() },
    selection: {
      indent: vi.fn(),
      outdent: vi.fn(),
      move: vi.fn(),
      toggleComplete: vi.fn(),
      duplicate: vi.fn(),
      delete: vi.fn()
    }
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
      "complete", "moveUp", "moveDown", "indent", "outdent", "duplicate",
      "delete"
    ]);
  });

  it("keeps today's row items and slots the four new ones before Delete", () => {
    expect(outlineMenuCommands("row").map((entry) => entry.id)).toEqual([
      "addNote", "marker", "duplicate", "uploadImage", "complete", "star",
      "moveUp", "moveDown", "indent", "outdent", "delete"
    ]);
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
    moveUp: ["⌃⇧↑", "Alt+Shift+↑"],
    moveDown: ["⌃⇧↓", "Alt+Shift+↓"],
    indent: ["Tab", "Tab"],
    outdent: ["⇧Tab", "Shift+Tab"]
  };
  const expectedKeys: Record<string, readonly [string, string]> = {
    complete: ["Meta+Enter", "Control+Enter"],
    duplicate: ["Meta+Shift+D", "Alt+Shift+D"],
    delete: ["Meta+Shift+Backspace", "Control+Shift+Backspace"],
    moveUp: ["Control+Shift+ArrowUp", "Alt+Shift+ArrowUp"],
    moveDown: ["Control+Shift+ArrowDown", "Alt+Shift+ArrowDown"],
    indent: ["Tab", "Tab"],
    outdent: ["Shift+Tab", "Shift+Tab"]
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
    for (const id of ["addNote", "marker", "uploadImage", "star"] as const) {
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
});

describe("outline menu execution", () => {
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
