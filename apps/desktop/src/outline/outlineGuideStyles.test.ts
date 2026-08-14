import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rule } from "../test/cssRules";

const notesStyles = readFileSync("src/notes.css", "utf8");

describe("outline indentation guides", () => {
  // The guide is the row's own background, so it reaches exactly as far as the
  // row's box. A trailing margin on the row's last child -- the supporting
  // note's -- collapses out through the row and its list item unless the row
  // contains it, and the guide breaks by exactly that margin. jsdom lays nothing
  // out, so this pins the declaration that keeps the margin in; the proof that
  // consecutive rows now touch is a browser measurement, taken by hand.
  it("keeps a child's trailing margin inside the row it paints", () => {
    expect(rule(notesStyles, ".notes-node")).toContain("display: flow-root;");
  });

  // One stripe per level the row sits under, at the ancestors' bullet centres:
  // the painted width stops at the row's own depth, which is what leaves a
  // parent's guide starting at its first child.
  it("paints one stripe per level, off the same vars as the bullets", () => {
    const row = rule(notesStyles, ".notes-node");
    expect(row).toContain("background-repeat: no-repeat;");
    expect(row).toContain(
      "background-position: var(--notes-bullet-center-offset) 0;"
    );
    expect(row).toContain("background-size: var(--notes-indent) 100%;");
  });
});
