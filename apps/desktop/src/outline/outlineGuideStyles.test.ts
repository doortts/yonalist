import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { atRule, rule } from "../test/cssRules";

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
    // Second layer of two: the guide's own geometry is unchanged, the band
    // above it just claims the first slot in each list.
    expect(row).toContain("var(--notes-bullet-center-offset) 0;");
    expect(row).toContain("var(--notes-indent) 100%;");
  });

  // The band is the row's first background layer rather than a box of its own:
  // as a layer it needs no pseudo-element to fight the lit guide's, and it can
  // start left of the row's own indent -- which is what lets every row in one
  // band share the shallowest selected row's left edge.
  it("paints the band as the row's first layer, from the band's own indent", () => {
    const row = rule(notesStyles, ".notes-node");
    expect(row).toContain(
      "linear-gradient(var(--notes-band-paint), var(--notes-band-paint)),"
    );
    expect(row).toContain(
      "var(--notes-band-depth, var(--notes-depth)) * var(--notes-outline-indent)"
    );
    // The band starts just before the bullet rather than at the indent origin,
    // so the menu and chevron columns stay unpainted. Off the bullets' own
    // offset, so both layouts follow from the one term. Asserted across the
    // line break the formatter puts here, since the sign is the whole claim:
    // subtracting the offset instead would move the edge a bullet column left
    // of where it was, which is the defect inverted rather than fixed.
    expect(row).toContain(
      "var(--notes-outline-indent) +\nvar(--notes-bullet-center-offset) - 10px"
    );
    expect(row).toContain("var(--notes-band-indent) 0,");
    expect(row).toContain("calc(100% - var(--notes-band-indent)) 100%,");
    expect(row).toContain("--notes-band-paint: transparent;");
  });

  it("colours that layer only for a row the band holds", () => {
    expect(rule(notesStyles, '.notes-node[data-range-selected="true"]'))
      .toContain("--notes-band-paint: var(--accent-soft);");
  });

  // A carried row already paints the drag tint. The band used to be on the same
  // element, so the tint replaced it; on its own layer nothing suppresses it and
  // the two composite into a third colour across a wider area than either.
  it("gives the band up while the row is being carried", () => {
    expect(rule(
      notesStyles,
      '.notes-outline-item[data-drag-source="true"] > .notes-node'
    )).toContain("--notes-band-paint: transparent;");
  });

  // The click target is invisible without this. The lit line has to land on the
  // stripe the pointer found, so it is placed off the same two properties the
  // painted stripe uses, stepped by the index the pane writes onto the row.
  it("lights the hovered stripe off the geometry that paints it", () => {
    const lit = rule(notesStyles, '.notes-node[data-guide-hot]::before');
    expect(lit).toContain("var(--notes-bullet-center-offset) + var(--notes-guide-hot) *");
    expect(lit).toContain("var(--notes-outline-indent)");
    expect(lit).toContain("pointer-events: none;");
  });

  // Each row lights its own segment, so a rounded end would notch every row
  // boundary and the guide would read as a dashed line. The hairline width is
  // the painted stripe's, so hovering recolours rather than thickens.
  it("keeps the lit guide a square-ended hairline", () => {
    const lit = rule(notesStyles, '.notes-node[data-guide-hot]::before');
    expect(lit).toContain("width: 1px;");
    expect(lit).not.toContain("border-radius");
  });
});

describe("row menu in the guide channel", () => {
  // A row without children used to park its menu in the empty chevron column,
  // 3px right of the stripe its parent paints -- while a row with children sat
  // 1px left of that same stripe. Neither cleared it, and the two disagreed on
  // which side to fail on. One column for both rows, in both layouts.
  it("gives every row the same menu column", () => {
    expect(notesStyles).not.toContain(":has(> .notes-node-arrow-slot:empty)");
  });

  // The channel between two stripes is one indent wide and the button is 24px,
  // so centring it is the only placement that clears both. The nudge is a
  // margin because the row's menu opens inside this slot: a transform or a
  // position would make the slot a stacking context or a containing block and
  // take the popup with it.
  it("centres the wide button between the stripes either side of it", () => {
    expect(rule(notesStyles, ".notes-node-menu-slot"))
      .toContain("margin-inline-start: -5px;");
  });

  // Narrow steps by 28px with a 28px button, so there is no channel to centre
  // in and a nudge would only push the button off its own column.
  it("leaves the narrow button on its column", () => {
    const narrow = atRule(notesStyles, "@media (max-width: 720px)");
    expect(rule(narrow, ".notes-node-menu-slot"))
      .toContain("margin-inline-start: 0;");
  });
});
