import { describe, expect, it } from "vitest";
import {
  notesPaneDndId,
  parseNotesPaneDndId
} from "./notesPaneDndId";

describe("notes pane drag ids", () => {
  it("keeps the same note id collision-free across panes", () => {
    const primary = notesPaneDndId("primary", "same:한글", "row");
    const secondary = notesPaneDndId("secondary", "same:한글", "row");

    expect(primary).not.toBe(secondary);
    expect(parseNotesPaneDndId(primary)).toEqual({
      paneId: "primary",
      nodeId: "same:한글",
      zone: "row"
    });
    expect(parseNotesPaneDndId(secondary)?.nodeId).toBe("same:한글");
  });

  it.each([
    "",
    "tertiary:node:row",
    "primary:node:unknown",
    "primary:%E0%A4%A:row",
    "primary::row"
  ])("rejects malformed id %s", (value) => {
    expect(parseNotesPaneDndId(value)).toBeNull();
  });

  it("supports an empty tail node id only for the tail zone", () => {
    const id = notesPaneDndId("secondary", null, "tail");
    expect(parseNotesPaneDndId(id)).toEqual({
      paneId: "secondary",
      nodeId: null,
      zone: "tail"
    });
  });
});
