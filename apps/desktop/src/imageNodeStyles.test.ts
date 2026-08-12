import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rule } from "./test/cssRules";

const notesStyles = readFileSync("src/notes.css", "utf8");

describe("image node styles", () => {
  it("blinks the caret bar on focus with the accent color", () => {
    const focused = rule(notesStyles, ".notes-image-caret-stop:focus");
    expect(focused).toContain("background: var(--accent);");
    expect(focused).toContain("animation: notes-image-caret-blink");
    expect(rule(notesStyles, ".notes-image-caret-stop:focus-visible"))
      .toContain("outline: 0;");
  });

  it("shows the node-selected outline on focus-visible", () => {
    const selected = rule(notesStyles, ".notes-image-node-content:focus-visible");
    expect(selected).toContain("outline: 2px solid var(--accent);");
    expect(selected).toContain("outline-offset: 2px;");
  });

  it("keeps the caret bar still under reduced motion", () => {
    expect(notesStyles).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.notes-image-caret-stop/
    );
  });
});
