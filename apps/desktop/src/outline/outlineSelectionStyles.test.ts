import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rule } from "../test/cssRules";

const notesStyles = readFileSync("src/notes.css", "utf8");
const appStyles = readFileSync("src/styles.css", "utf8");

// The WKWebView the app ships in parses only the prefixed property --
// CSS.supports('user-select', 'none') is false there, and a bare declaration is
// dropped whole. The pair is the contract: the prefix for the engine the app
// runs on, the bare property for the engines that no longer take the prefix.
// The bare line is matched anchored because it is a substring of the prefixed
// one, and one line must not pass for both.
function expectsSelection(declarations: string, value: "none" | "text") {
  expect(declarations).toContain(`-webkit-user-select: ${value};`);
  expect(declarations).toMatch(new RegExp(`^user-select: ${value};$`, "m"));
}

describe("native selection across the outline", () => {
  // The space below the last row belongs to the scroll container itself, and a
  // drag started there is one the row gesture never claims: it makes no
  // gesture, so nothing turns the engine's own selection off and nothing clears
  // the range it leaves behind. Turning selection off for the pane is what
  // keeps that anchor from ever being set.
  it("turns native selection off across the rows pane", () => {
    expectsSelection(rule(notesStyles, ".notes-outline-rows"), "none");
  });

  // WebKit carries an ancestor's `none` into the form controls under it, so the
  // editors and the chooser fields that mount inside the pane take their own
  // selection back by name.
  it("hands selection back to the editors and chooser fields", () => {
    expectsSelection(
      rule(notesStyles, ".notes-outline-rows :is(textarea, input)"),
      "text"
    );
  });

  // The pane's standing rule leaves only the reopened controls to close, and
  // the band drag is when they have to be: the drag starts in an editor.
  it("keeps the band drag suppression on the reopened controls", () => {
    expectsSelection(
      rule(notesStyles, '[data-row-selecting="true"] :is(textarea, input)'),
      "none"
    );
  });

  // The two rules that write the controls' selection carry the same weight, so
  // the file's order is what settles them. Written the other way round the drag
  // rule loses and every declaration above still reads right.
  it("lets the band drag have the last word on those controls", () => {
    expect(
      notesStyles.indexOf('[data-row-selecting="true"] :is(textarea, input) {')
    ).toBeGreaterThan(
      notesStyles.indexOf(".notes-outline-rows :is(textarea, input) {")
    );
  });
});

describe("native selection across the sidebar", () => {
  // The far end of a drag that starts in the outline: a range the engine grew
  // that way painted the wordmark, every page row and Settings as selected.
  // The pane is a list of controls, so there is nothing there to select.
  it("turns native selection off across the sidebar", () => {
    expectsSelection(rule(appStyles, ".yonalist-navigation-pane"), "none");
  });

  // Except the search field, the one place in the pane the reader types.
  it("keeps the search field selectable", () => {
    expectsSelection(rule(appStyles, ".yonalist-navigation-pane input"), "text");
  });

  // And the sync badge, which is the only place a refusal names the file it
  // could not read. That path is there to be taken somewhere else.
  it("keeps the sync trouble text selectable", () => {
    expectsSelection(
      rule(appStyles, ".yonalist-navigation-pane .notes-sync-status-badge"),
      "text"
    );
  });
});
