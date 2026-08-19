import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { expectsSelection, rule } from "./test/cssRules";

const appStyles = readFileSync("src/styles.css", "utf8");

describe("native selection across the app chrome", () => {
  // While a pane is being resized the pointer is already down and moving across
  // the whole document: every drag here is the resize gesture, and none of it is
  // a reader asking for a range.
  it("turns native selection off while a pane is being resized", () => {
    expectsSelection(rule(appStyles, "body.is-resizing-pane"), "none");
  });

  // The titlebar is the window's own drag region, so a drag that starts on it
  // moves the window. Nothing there is text a reader would want to take.
  it("turns native selection off across the titlebar", () => {
    expectsSelection(rule(appStyles, ".app-titlebar"), "none");
  });

  // The strip above the content is the same drag region carried across the rest
  // of the window's top edge, and it answers to the same rule.
  it("turns native selection off across the content drag strip", () => {
    expectsSelection(rule(appStyles, ".app-content-drag-strip"), "none");
  });
});
