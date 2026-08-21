import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { atRule, rule } from "../test/cssRules";

const notesStyles = readFileSync("src/notes.css", "utf8");
const stillStyles = atRule(
  notesStyles,
  "@media (prefers-reduced-motion: reduce)"
);
const shownLine = ".notes-image-resize-handle[data-resizing] " +
  ".notes-image-resize-line";
const frame = ".notes-image-attachment-frame";

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

  it("never stretches the frame row, which would kill the aspect ratio", () => {
    expect(rule(notesStyles, ".notes-image-frame-row"))
      .toContain("align-items: flex-start;");
  });

  // The ring hugs the frame, never the row: the node content is the full row
  // width, so a ring on it wrapped the bullet and everything beside it.
  it("rings the image only while it holds the focus itself", () => {
    expect(rule(notesStyles, ".notes-image-node-content:focus-visible"))
      .toContain("outline: 0;");
    // A caret standing beside the image is not the image being focused, so the
    // stations draw no ring of their own.
    expect(notesStyles).not.toContain(".notes-image-caret-stop:focus) ");
    for (const selector of [
      ".notes-image-node-content:focus " + frame,
      `.notes-node[data-range-selected="true"] ${frame}`
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

  it("paints a lone selected image instead of banding its row", () => {
    expect(rule(
      notesStyles,
      '.notes-node[data-solo-image-selection="true"]'
    )).toContain("--notes-band-paint: transparent;");
    expect(rule(
      notesStyles,
      '.notes-node[data-range-selected="true"] ' +
      ".notes-image-attachment-frame::after"
    )).toContain(
      "background: color-mix(in srgb, var(--accent) 28%, transparent);"
    );
    // The frame stopped clipping so its menu could hang past a short image, so
    // the tint takes the frame's own rounding rather than the frame's clip.
    expect(rule(
      notesStyles,
      '.notes-node[data-range-selected="true"] ' +
      ".notes-image-attachment-frame::after"
    )).toContain("border-radius: inherit;");
    // Equal specificity with the band rule, so only file order decides which
    // one answers -- and nothing else in the suite would notice a reorder.
    expect(notesStyles.indexOf('.notes-node[data-range-selected="true"] {'))
      .toBeLessThan(
        notesStyles.indexOf('.notes-node[data-solo-image-selection="true"] {')
      );
  });

  // The stage carries the box a turned image occupies, so it takes the centring
  // while the image is free to be scaled and rotated inside it.
  it("centres the lightbox stage and turns the image inside it", () => {
    const stage = rule(notesStyles, ".notes-image-lightbox-stage");
    expect(stage).toContain("margin: auto;");
    expect(stage).toContain("flex: none;");
    const image = rule(notesStyles, ".notes-image-lightbox-image");
    expect(image).toContain("position: absolute;");
    expect(image).toContain("max-width: none;");
    expect(image).toContain("max-height: none;");
    // The turn is about the image's own centre, which is these two offsets
    // against the translate: without them it collapses into the stage corner.
    expect(image).toContain("top: 50%;");
    expect(image).toContain("left: 50%;");
  });

  // The fit reserves one gutter per side, so the padding it reserves against
  // has to be that gutter -- on the narrow layout too, bar clearance aside.
  it("keeps the lightbox padding at the gutter the fit reserves", () => {
    expect(rule(notesStyles, ".notes-image-lightbox-scroll"))
      .toContain("padding: 24px;");
    expect(atRule(notesStyles, "@media (max-width: 640px)"))
      .toContain("padding: 44px 24px 24px;");
  });

  it("strips the chrome off the lightbox controls", () => {
    const control = rule(notesStyles, ".notes-image-lightbox-control");
    expect(control).toContain("border: 0;");
    expect(control).toContain("background: none;");
    expect(control).toContain("padding: 0;");
    // The bar itself lets clicks through, so the controls take their own.
    expect(rule(notesStyles, ".notes-image-lightbox-controls"))
      .toContain("pointer-events: auto;");
    // Nothing to drag while the whole image is on screen.
    expect(rule(notesStyles, ".notes-image-lightbox-scroll[data-fits]"))
      .toContain("overflow: hidden;");
  });

  it("keeps the lightbox bar out of the pointer's way", () => {
    expect(rule(notesStyles, ".notes-image-lightbox-bar"))
      .toContain("pointer-events: none;");
  });
});
