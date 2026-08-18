import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rule } from "../test/cssRules";

const notesStyles = readFileSync("src/notes.css", "utf8");

describe("the page title's placeholder", () => {
  // The title is set at heading size and heading weight, so the grey a row's
  // placeholder wears reads as a line of real text up there -- the reader has
  // to look twice to see the page is untitled. It only has to say what the
  // line is for.
  it("is fainter than the text it stands in for", () => {
    const placeholder = rule(notesStyles, ".notes-page-title::placeholder");
    expect(placeholder).toContain("color: var(--text-3);");
    // How faint is a matter of taste and gets tuned; that it is faint at all
    // is the contract.
    const faded = /opacity:\s*([\d.]+);/.exec(placeholder);
    expect(Number(faded?.[1])).toBeGreaterThan(0);
    expect(Number(faded?.[1])).toBeLessThan(0.6);
  });
});
