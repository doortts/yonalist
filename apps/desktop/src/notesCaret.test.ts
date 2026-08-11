import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");
const notesStyles = readFileSync("src/notes.css", "utf8");

/** The declarations of every top-level rule opened by exactly this selector line. */
function rule(css: string, selector: string): string {
  let declarations = "";
  let inside = false;
  for (const line of css.split("\n")) {
    if (inside) {
      if (line === "}") inside = false;
      else declarations += `${line.trim()}\n`;
    } else if (line === `${selector} {`) {
      inside = true;
    }
  }
  if (declarations === "") throw new Error(`missing rule: ${selector}`);
  return declarations;
}

const darkThemes = [
  ':root[data-theme="dark"]',
  ':root[data-theme="yona-dark"]',
  ':root[data-theme="base-dark"]'
];

describe("caret color token", () => {
  it("keeps the default caret on the primary text color", () => {
    expect(rule(styles, ":root")).toContain("--caret-strong: var(--text-1);");
  });

  it.each(darkThemes)("gives %s its own caret color", (selector) => {
    expect(rule(styles, selector)).toContain("--caret-strong:");
  });

  it("paints both title carets from the token", () => {
    for (const selector of [".notes-page-title-field", ".notes-node-title-field"]) {
      expect(rule(notesStyles, selector)).toContain(
        "--notes-stable-caret-color: var(--caret-strong);"
      );
    }
  });
});
