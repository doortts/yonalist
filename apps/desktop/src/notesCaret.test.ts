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

  // The caret layer sits exactly on the glyphs; a translated textarea draws
  // its caret below the text it belongs to.
  it("keeps note carets level with the note text", () => {
    for (const selector of [".notes-page-note-field", ".notes-node-note-field"]) {
      expect(rule(notesStyles, selector)).not.toContain(
        "--notes-stable-caret-offset"
      );
    }
    expect(
      rule(notesStyles, '.notes-text-field[data-stable-presentation="true"] > textarea')
    ).toContain("transform: none;");
  });
});

const STRUT_FAMILY = '"Yonalist Caret Strut"';

/** The one font-family declaration of a rule, collapsed onto a single line. */
function fontFamily(css: string, selector: string): string {
  const match = /font-family:([^;]*);/.exec(rule(css, selector));
  if (match === null) throw new Error(`no font-family in: ${selector}`);
  return match[1].replace(/\s+/g, " ").trim();
}

describe("caret strut font", () => {
  it("registers the strut font from the bundled asset", () => {
    const face = rule(notesStyles, "@font-face");
    expect(fontFamily(notesStyles, "@font-face")).toBe(STRUT_FAMILY);
    expect(face).toContain('url("./assets/yonalist-caret-strut.woff2")');
  });

  it("puts the strut first in the outline row stack", () => {
    expect(fontFamily(notesStyles, ".notes-node-title-field")).toMatch(
      new RegExp(`^${STRUT_FAMILY}, `)
    );
  });

  it("keeps the strut off the markdown heading rows", () => {
    expect(fontFamily(notesStyles, ".notes-node-title-field[data-markdown-level]")).not.toContain(
      STRUT_FAMILY
    );
  });
});
