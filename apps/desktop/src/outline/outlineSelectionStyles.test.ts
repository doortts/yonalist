import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rule } from "../test/cssRules";

const notesStyles = readFileSync("src/notes.css", "utf8");

describe("native selection across the outline", () => {
  // The space below the last row belongs to the scroll container itself, and a
  // drag started there is one the row gesture never claims: it makes no
  // gesture, so nothing turns the engine's own selection off and nothing clears
  // the range it leaves behind. Turning selection off for the pane is what
  // keeps that anchor from ever being set.
  it("turns native selection off across the rows pane", () => {
    expect(rule(notesStyles, ".notes-outline-rows")).toContain(
      "user-select: none;"
    );
  });

  // WebKit carries an ancestor's `none` into the form controls under it, so the
  // editors and the chooser fields that mount inside the pane take their own
  // selection back by name.
  it("hands selection back to the editors and chooser fields", () => {
    expect(
      rule(notesStyles, ".notes-outline-rows :is(textarea, input)")
    ).toContain("user-select: text;");
  });

  // The pane's standing rule leaves only the reopened controls to close, and
  // the band drag is when they have to be: the drag starts in an editor.
  it("keeps the band drag suppression on the reopened controls", () => {
    expect(
      rule(notesStyles, '[data-row-selecting="true"] :is(textarea, input)')
    ).toContain("user-select: none;");
  });
});
