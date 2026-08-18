import {
  applySlashCommand,
  filterSlashCommands,
  resolveOrderedInput,
  resolveSlashCommandQuery,
  resolveTitleInput,
  orderSlashCommands,
  rememberSlashCommand,
  resolveTodoBoxInput
} from "./outlineSlash";

describe("v2 slash commands", () => {
  it("owns a collapsed lowercase slash query anywhere a word can start", () => {
    expect(resolveSlashCommandQuery("/tod later", 4, 4)).toEqual({
      start: 0,
      end: 4,
      query: "tod"
    });
    expect(resolveSlashCommandQuery("Plan /tod", 9, 9)).toEqual({
      start: 5,
      end: 9,
      query: "tod"
    });
    // Mid-word slashes are somebody else's punctuation, not a command.
    expect(resolveSlashCommandQuery("and/or", 6, 6)).toBeNull();
    expect(resolveSlashCommandQuery("https://x", 9, 9)).toBeNull();
    // A bare slash mid-line is a slash. Only the row that opens with one is
    // unambiguously reaching for a command.
    expect(resolveSlashCommandQuery("Buy milk /", 10, 10)).toBeNull();
    expect(resolveSlashCommandQuery("/", 1, 1)).toEqual({
      start: 0,
      end: 1,
      query: ""
    });
    expect(resolveSlashCommandQuery("Ship /tod refresh", 9, 9)).toEqual({
      start: 5,
      end: 9,
      query: "tod"
    });
    // Typed at the head of a row that already says something: the oldest way
    // to turn an existing bullet into a To-do, and it has to keep working.
    expect(resolveSlashCommandQuery("/todbuy milk", 4, 4)).toEqual({
      start: 0,
      end: 4,
      query: "tod"
    });
    expect(resolveSlashCommandQuery("/to d", 5, 5)).toBeNull();
    expect(resolveSlashCommandQuery("/tod", 1, 3)).toBeNull();
  });

  it("filters the current Today and To-do command set", () => {
    expect(filterSlashCommands("").map(({ id }) => id)).toEqual(["today", "todo"]);
    expect(filterSlashCommands("TOD").map(({ id }) => id)).toEqual(["today", "todo"]);
    expect(filterSlashCommands("TODO").map(({ id }) => id)).toEqual(["todo"]);
  });

  it("offers a checked row the way back rather than the way it came", () => {
    expect(filterSlashCommands("", "todo").map(({ label }) => label))
      .toEqual(["Today", "Change to bullet"]);
    // The way back answers to what it is and to what it was: the reader who
    // types the command's name should not have to know it was renamed.
    expect(filterSlashCommands("chan", "todo").map(({ id }) => id))
      .toEqual(["todo"]);
    expect(filterSlashCommands("todo", "todo").map(({ id }) => id))
      .toEqual(["todo"]);
    expect(filterSlashCommands("", "bullet").map(({ label }) => label))
      .toEqual(["Today", "To-do"]);
  });

  it("takes the box off a row that already wears one", () => {
    const query = resolveSlashCommandQuery("/tod", 4, 4)!;
    expect(applySlashCommand("/tod", query, "todo", "2026-07-28", "todo"))
      .toEqual({ value: "", caret: 0, marker: "bullet", completed: false });
    expect(applySlashCommand("/tod", query, "todo", "2026-07-28"))
      .toEqual({ value: "", caret: 0, marker: "todo" });
  });

  it("edits only the query, wherever in the row it stands", () => {
    const query = resolveSlashCommandQuery("Plan /tod later", 9, 9)!;
    expect(applySlashCommand("Plan /tod later", query, "today", "2026-07-28"))
      .toEqual({ value: "Plan 2026-07-28 later", caret: 15, marker: null });
    expect(applySlashCommand("Plan /tod later", query, "todo", "2026-07-28"))
      .toEqual({ value: "Plan  later", caret: 5, marker: "todo" });
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

describe("the numbered prefix a keystroke finishes", () => {
  it("takes the number the reader typed and keeps the rest of the row", () => {
    expect(resolveOrderedInput("3. buy milk", 3, 3, "3.buy milk")).toEqual({
      value: "buy milk",
      caret: 0,
      start: 3
    });
    expect(resolveOrderedInput("12. ", 4, 4, "12.")).toEqual({
      value: "",
      caret: 0,
      start: 12
    });
  });

  it("only fires on the keystroke that finished the prefix", () => {
    // The caret elsewhere in the row: an edit further along, not a marker.
    expect(resolveOrderedInput("1. milk", 7, 7, "1. mil")).toBeNull();
    // A row that already carried the prefix is being typed into.
    expect(resolveOrderedInput("1. milk", 3, 3, "1. ilk")).toBeNull();
    // A selection is a replacement, not a finished prefix.
    expect(resolveOrderedInput("1. milk", 3, 5, "1.milk")).toBeNull();
  });

  it("ignores a prefix the syntax does not allow", () => {
    expect(resolveOrderedInput("1 milk", 2, 2, "1milk")).toBeNull();
    expect(resolveOrderedInput(".milk ", 6, 6, ".milk")).toBeNull();
    expect(resolveOrderedInput("a1. milk", 4, 4, "a1.milk")).toBeNull();
  });
});

describe("the one question a title's own field asks of a change", () => {
  it("answers with a numbered marker before it looks for a command", () => {
    expect(resolveTitleInput("3.", {
      value: "3. ",
      selectionStart: 3,
      selectionEnd: 3
    })).toEqual({
      kind: "ordered",
      edit: { value: "", caret: 0, start: 3 }
    });
  });

  it("answers with a box, a query, or nothing at all", () => {
    expect(resolveTitleInput("[ ]buy milk", {
      value: "[ ] buy milk",
      selectionStart: 4,
      selectionEnd: 4
    })).toEqual({
      kind: "box",
      edit: { value: "buy milk", caret: 0, completed: false }
    });
    expect(resolveTitleInput("/to", {
      value: "/tod",
      selectionStart: 4,
      selectionEnd: 4
    })).toEqual({ kind: "slash", query: { start: 0, end: 4, query: "tod" } });
    // The caret is where the query ends, always. A change that reports it at
    // the start is reporting a caret at the start, and there is no query
    // standing there.
    expect(resolveTitleInput("", {
      value: "/tod",
      selectionStart: 0,
      selectionEnd: 0
    })).toBeNull();
    expect(resolveTitleInput("buy mil", {
      value: "buy milk",
      selectionStart: 8,
      selectionEnd: 8
    })).toBeNull();
  });
});

describe("the order the menu offers its commands in", () => {
  beforeEach(() => {
    const backing = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) => backing.set(key, value),
        removeItem: (key: string) => backing.delete(key),
        clear: () => backing.clear()
      }
    });
  });

  afterEach(() => {
    delete (window as { localStorage?: unknown }).localStorage;
  });

  it("leads with the one used last", () => {
    const commands = filterSlashCommands("");
    expect(orderSlashCommands(commands, []).map(({ id }) => id))
      .toEqual(["today", "todo"]);

    rememberSlashCommand("todo");

    expect(orderSlashCommands(commands).map(({ id }) => id))
      .toEqual(["todo", "today"]);
  });

  it("keeps the declared order for the ones nobody has reached for", () => {
    const commands = filterSlashCommands("");

    // A remembered command that no longer exists names nobody, so both of
    // these are un-reached and stand as they were declared.
    expect(orderSlashCommands(commands, ["gone"]).map(({ id }) => id))
      .toEqual(["today", "todo"]);
    // One reached for goes above the one that was not, wherever it was
    // declared.
    expect(orderSlashCommands(commands, ["todo"]).map(({ id }) => id))
      .toEqual(["todo", "today"]);
  });

  it("remembers the last reach first, and each command once", () => {
    rememberSlashCommand("today");
    rememberSlashCommand("todo");
    rememberSlashCommand("today");

    expect(orderSlashCommands(filterSlashCommands("")).map(({ id }) => id))
      .toEqual(["today", "todo"]);
    expect(JSON.parse(
      window.localStorage.getItem("yonalist.slashCommandOrder.v1")!
    )).toEqual(["today", "todo"]);
  });
});
