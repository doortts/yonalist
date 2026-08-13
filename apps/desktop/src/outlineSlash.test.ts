import {
  applySlashCommand,
  filterSlashCommands,
  resolveSlashCommandQuery,
  resolveTodoBoxInput
} from "./outlineSlash";

describe("v2 slash commands", () => {
  it("owns only a leading collapsed lowercase slash query", () => {
    expect(resolveSlashCommandQuery("/tod later", 4, 4)).toEqual({
      start: 0,
      end: 4,
      query: "tod"
    });
    expect(resolveSlashCommandQuery("Plan /tod", 9, 9)).toBeNull();
    expect(resolveSlashCommandQuery("/to d", 5, 5)).toBeNull();
    expect(resolveSlashCommandQuery("/tod", 1, 3)).toBeNull();
  });

  it("filters the current Today and To-do command set", () => {
    expect(filterSlashCommands("").map(({ id }) => id)).toEqual(["today", "todo"]);
    expect(filterSlashCommands("TOD").map(({ id }) => id)).toEqual(["today", "todo"]);
    expect(filterSlashCommands("TODO").map(({ id }) => id)).toEqual(["todo"]);
  });

  it("inserts a local ISO date or atomically converts the marker", () => {
    const query = resolveSlashCommandQuery("/tod later", 4, 4)!;
    expect(applySlashCommand("/tod later", query, "today", "2026-07-28")).toEqual({
      value: "2026-07-28 later",
      caret: 10,
      marker: null
    });
    expect(applySlashCommand("/tod later", query, "todo", "2026-07-28")).toEqual({
      value: " later",
      caret: 0,
      marker: "todo"
    });
  });
});

/** The row as it stood before the space that finished its box went in. */
function spaceUndone(value: string): string {
  return value.replace("] ", "]");
}

describe("a task box typed at a title's start", () => {
  // The space is what GFM writes and what leaves a literal "[ ]" title
  // reachable: without it the brackets are still just characters.
  it("takes the four spellings, and only once the space is there", () => {
    for (const box of ["[ ] ", "[] "]) {
      const typed = `${box}buy milk`;
      expect(
        resolveTodoBoxInput(typed, box.length, box.length, spaceUndone(typed)),
        box
      ).toEqual({ value: "buy milk", caret: 0, completed: false });
    }
    for (const box of ["[x] ", "[X] "]) {
      const typed = `${box}shipped`;
      expect(
        resolveTodoBoxInput(typed, box.length, box.length, spaceUndone(typed)),
        box
      ).toEqual({ value: "shipped", caret: 0, completed: true });
    }
    for (const box of ["[ ]", "[]", "[x]", "[X]"]) {
      expect(
        resolveTodoBoxInput(box, box.length, box.length, box.slice(0, -1)),
        box
      ).toBeNull();
    }
  });

  it("fires only on the space that finished a box at offset 0", () => {
    // The whole line pasted into an empty row: the caret is at its end, so the
    // box is text somebody else wrote rather than one this keystroke finished.
    expect(resolveTodoBoxInput("[ ] buy milk", 12, 12, "")).toBeNull();
    expect(resolveTodoBoxInput("[ ] buy milk", 0, 0, "")).toBeNull();
    // Not at the start, so the brackets stay characters.
    expect(resolveTodoBoxInput("buy [ ] milk", 8, 8, "buy [ ]milk")).toBeNull();
    expect(resolveTodoBoxInput(" [ ] milk", 5, 5, " [ ]milk")).toBeNull();
    // A sweep is not a keystroke.
    expect(resolveTodoBoxInput("[ ] milk", 0, 4, "[ ]milk")).toBeNull();
    // Neither a box nor a bracket pair this rule knows.
    expect(resolveTodoBoxInput("[y] milk", 4, 4, "[y]milk")).toBeNull();
    expect(resolveTodoBoxInput("[  ] milk", 5, 5, "[  ]milk")).toBeNull();
  });

  // The shape of a value is not the keystroke that made it: a row that already
  // held a whole box keeps it as characters, and every later edit that happens
  // to leave the caret at the box end is somebody else's.
  it("refuses a row that already held a whole box", () => {
    // Backspace over the `X` of `[ ] Xfoo` lands the caret at the box end.
    expect(resolveTodoBoxInput("[ ] foo", 4, 4, "[ ] Xfoo")).toBeNull();
    expect(resolveTodoBoxInput("[ ] ne", 4, 4, "[ ] one")).toBeNull();
    // So does cutting a swept `one ` out of `[ ] one two`.
    expect(resolveTodoBoxInput("[ ] two", 4, 4, "[ ] one two")).toBeNull();
    // A box the row had no space in yet is still this rule's keystroke.
    expect(resolveTodoBoxInput("[ ] one", 4, 4, "[ ]one")).toEqual({
      value: "one",
      caret: 0,
      completed: false
    });
  });

  it("leaves an empty row behind when the box is all there was", () => {
    expect(resolveTodoBoxInput("[ ] ", 4, 4, "[ ]")).toEqual({
      value: "",
      caret: 0,
      completed: false
    });
  });
});
