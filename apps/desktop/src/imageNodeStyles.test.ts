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
  it("blinks the caret bar on focus in the text caret's own shape", () => {
    // One text line tall, parked on the image's baseline, at the width and
    // colour the settings-driven text caret uses.
    const bar = rule(notesStyles, ".notes-image-caret-stop");
    expect(bar).toContain("width: 1px;");
    expect(bar).toContain("height: 25px;");
    expect(bar).toContain("align-self: flex-end;");
    const focused = rule(notesStyles, ".notes-image-caret-stop:focus");
    expect(focused).toContain("background: var(--caret-strong);");
    expect(focused).toContain("animation: notes-image-caret-blink");
    expect(rule(notesStyles, ".notes-image-caret-stop:focus-visible"))
      .toContain("outline: 0;");
  });

  it("rings the image on click and caret arrival but never on Tab", () => {
    expect(rule(notesStyles, ".notes-image-node-content:focus-visible"))
      .toContain("outline: 0;");
    for (const selector of [
      ".notes-image-node-content:focus:not(:focus-visible)",
      ".notes-image-node-content:has(.notes-image-caret-stop:focus)"
    ]) {
      const ring = rule(notesStyles, selector);
      expect(ring).toContain("outline: 2px solid var(--accent);");
      expect(ring).toContain("outline-offset: 2px;");
    }
  });

  it("keeps the caret bar still under reduced motion", () => {
    expect(rule(stillStyles, ".notes-image-caret-stop:focus"))
      .toContain("animation: none;");
  });

  it("hides the resize cap bar until hover, drag, or handle focus", () => {
    const line = rule(notesStyles, ".notes-image-resize-line");
    expect(line).toContain("opacity: 0;");
    // The dual-tone cap bar: a dark pill under a light hairline, so it reads
    // against any photo, hugging the image's outer edge.
    expect(line).toContain("right: 2px;");
    expect(line).toContain("width: 6px;");
    expect(line).toContain("height: min(52px, 60%);");
    expect(line).toContain("border: 1.5px solid rgb(255 255 255 / 90%);");
    expect(line).toContain("border-radius: 4px;");
    expect(line).toContain("background: rgb(15 15 15 / 55%);");
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
