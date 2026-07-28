import {
  applySlashCommand,
  filterSlashCommands,
  resolveSlashCommandQuery
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
