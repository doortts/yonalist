import { describe, expect, it } from "vitest";
import {
  applyNotesSlashCommand,
  filterNotesSlashCommands,
  resolveNotesSlashCommandQuery
} from "./notesSlashCommands";

describe("notes slash commands", () => {
  it("recognizes only a leading collapsed slash query", () => {
    expect(resolveNotesSlashCommandQuery("/tod later", 4, 4)).toEqual({
      startUtf16: 0,
      endUtf16: 4,
      query: "tod"
    });
    expect(resolveNotesSlashCommandQuery("Plan /tod", 9, 9)).toBeNull();
    expect(resolveNotesSlashCommandQuery("/tod", 1, 3)).toBeNull();
    expect(resolveNotesSlashCommandQuery("/to d", 5, 5)).toBeNull();
    expect(resolveNotesSlashCommandQuery("/tod", 0, 0)).toBeNull();
  });

  it("filters command labels by a case-insensitive prefix", () => {
    expect(filterNotesSlashCommands("").map(({ id }) => id)).toEqual([
      "today"
    ]);
    expect(filterNotesSlashCommands("TOD").map(({ id }) => id)).toEqual([
      "today"
    ]);
    expect(filterNotesSlashCommands("tomorrow")).toEqual([]);
  });

  it("replaces only the slash query and preserves suffix text", () => {
    expect(
      applyNotesSlashCommand(
        "/tod later",
        { startUtf16: 0, endUtf16: 4, query: "tod" },
        "today",
        { year: 2026, month: 7, day: 22 }
      )
    ).toEqual({ value: "2026-07-22 later", caretUtf16: 10 });
  });

  it("rejects a stale or unsupported command application", () => {
    expect(() =>
      applyNotesSlashCommand(
        "/tod",
        { startUtf16: 0, endUtf16: 5, query: "tod" },
        "today",
        { year: 2026, month: 7, day: 22 }
      )
    ).toThrowError("Slash command query no longer matches the source value.");
  });
});
