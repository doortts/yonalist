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

  it("hides the resize line until hover, drag, or handle focus", () => {
    const line = rule(notesStyles, ".notes-image-resize-line");
    expect(line).toContain("opacity: 0;");
    expect(line).toContain("width: 3pt;");
    expect(line).toContain(
      "background: color-mix(in srgb, var(--text-1) 40%, transparent);"
    );
    expect(line).toContain("transition: opacity 120ms ease;");
    for (const selector of [
      ".notes-image-attachment-frame:hover .notes-image-resize-line,",
      ".notes-image-resize-handle:focus-visible .notes-image-resize-line,",
      ".notes-image-resize-handle[data-resizing] .notes-image-resize-line {"
    ]) {
      expect(notesStyles).toContain(selector);
    }
  });

  it("keeps the resize line fade off under reduced motion", () => {
    expect(notesStyles).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.notes-image-resize-line/
    );
  });

  it("lets the lightbox image render at natural size", () => {
    const image = rule(notesStyles, ".notes-image-lightbox-image");
    expect(image).toContain("max-width: none;");
    expect(image).toContain("margin: auto;");
  });
});
