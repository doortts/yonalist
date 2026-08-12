import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { atRule, rule } from "./test/cssRules";

const notesStyles = readFileSync("src/notes.css", "utf8");
const stillStyles = atRule(
  notesStyles,
  "@media (prefers-reduced-motion: reduce)"
);
const shownLine = ".notes-image-resize-handle[data-resizing] " +
  ".notes-image-resize-line";

describe("image node styles", () => {
  it("blinks the caret bar on focus with the accent color", () => {
    expect(rule(notesStyles, ".notes-image-caret-stop"))
      .toContain("width: 2px;");
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
    expect(rule(stillStyles, ".notes-image-caret-stop:focus"))
      .toContain("animation: none;");
  });

  it("hides the resize line until hover, drag, or handle focus", () => {
    const line = rule(notesStyles, ".notes-image-resize-line");
    expect(line).toContain("opacity: 0;");
    expect(line).toContain("width: 3pt;");
    expect(line).toContain(
      "background: color-mix(in srgb, var(--text-1) 40%, transparent);"
    );
    expect(line).toContain("transition: opacity 120ms ease;");
    // The three states share one block, so its declarations live under the
    // last selector of the group.
    for (const selector of [
      ".notes-image-attachment-frame:hover .notes-image-resize-line,",
      ".notes-image-resize-handle:focus-visible .notes-image-resize-line,"
    ]) {
      expect(notesStyles).toContain(selector);
    }
    expect(rule(notesStyles, shownLine)).toContain("opacity: 1;");
  });

  it("keeps the resize line fade off under reduced motion", () => {
    expect(rule(stillStyles, ".notes-image-resize-line"))
      .toContain("transition: none;");
  });

  it("lets the lightbox image render at natural size", () => {
    const image = rule(notesStyles, ".notes-image-lightbox-image");
    expect(image).toContain("max-width: none;");
    expect(image).toContain("max-height: none;");
    expect(image).toContain("margin: auto;");
  });

  it("keeps the lightbox bar out of the pointer's way", () => {
    expect(rule(notesStyles, ".notes-image-lightbox-bar"))
      .toContain("pointer-events: none;");
  });
});
