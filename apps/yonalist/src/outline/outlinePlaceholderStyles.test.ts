import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rule } from "../test/cssRules";

const notesStyles = readFileSync("src/notes.css", "utf8");

// A field's glyphs come from its presentation span, which carries the field's
// own class and `data-placeholder="true"` while the value is empty. Colouring
// only the textarea's `::placeholder` leaves the placeholder the reader
// actually sees at full text colour.
describe("a placeholder the reader sees", () => {
  it("is drawn on the presentation layer, not just the textarea", () => {
    const presentation = rule(
      notesStyles,
      '.notes-text-field > [data-placeholder="true"]'
    );
    expect(presentation).toContain("color: var(--text-3);");
  });

  // The title is set at heading size and heading weight, so the grey a row's
  // placeholder wears reads as a line of real text up there -- the reader has
  // to look twice to see the page is untitled. It only has to say what the
  // line is for.
  it("is fainter still on the page title", () => {
    const title = rule(
      notesStyles,
      '.notes-page-title-field > [data-placeholder="true"]'
    );
    expect(title).toContain("color: var(--text-3);");
    // How faint is a matter of taste and gets tuned; that it is faint at all
    // is the contract.
    const faded = /opacity:\s*([\d.]+);/.exec(title);
    expect(Number(faded?.[1])).toBeGreaterThan(0);
    expect(Number(faded?.[1])).toBeLessThan(0.6);
  });
});
