import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rule } from "../test/cssRules";

const css = readFileSync("src/mobile/mobile.css", "utf8");

/**
 * Apple's floor for anything a finger has to hit. The outline draws a 16x6
 * bullet and a 17px checkbox, which are the right size to look at and the
 * wrong size to press, so the phone grows their reach without growing them.
 */
const FLOOR = 44;

/** The reach of a control `size` across, widened by an inset of `inset`. */
function reach(size: number, inset: number): number {
  return size + inset * 2;
}

describe("mobile touch targets", () => {
  it("gives the bullet a reach a thumb can land on, without redrawing it", () => {
    const overlay = rule(css, ".mobile-app .notes-node-bullet::after");

    const [, vertical, horizontal] = /inset: (-?\d+)px (-?\d+)px/u.exec(overlay) ?? [];
    expect(reach(6, -Number(vertical))).toBeGreaterThanOrEqual(FLOOR);
    expect(reach(16, -Number(horizontal))).toBeGreaterThanOrEqual(FLOOR);
  });

  it("does the same for the to-do checkbox", () => {
    const overlay = rule(css, ".mobile-app .notes-todo-checkbox::after");

    const [, inset] = /inset: (-?\d+)px/u.exec(overlay) ?? [];
    expect(reach(17, -Number(inset))).toBeGreaterThanOrEqual(FLOOR);
  });

  it("anchors the overlays, or they would spread over the whole row", () => {
    expect(rule(css, ".mobile-app .notes-node-bullet")).toContain("position: relative");
    expect(rule(css, ".mobile-app .notes-todo-checkbox")).toContain("position: relative");
  });

  it("keeps the drag handle's gesture off the browser, so a drag is not a scroll", () => {
    expect(rule(css, ".mobile-app .notes-node-bullet")).toContain("touch-action: none");
  });
});

describe("mobile row layout", () => {
  it("gives the row back the width the pointer affordances were holding", () => {
    // The row menu opens on hover, which a phone has none of, so its column is
    // dead width on the narrowest screen there is.
    expect(rule(css, ".mobile-app .notes-node")).toContain("--notes-menu-width: 0px");
  });

  it("makes a row as tall as a finger, not as tall as a line", () => {
    const row = rule(css, ".mobile-app .notes-node-main");

    const [, height] = /min-height: (\d+)px/u.exec(row) ?? [];
    expect(Number(height)).toBeGreaterThanOrEqual(FLOOR);
  });
});

describe("mobile row chrome", () => {
  it("takes the hover-only row menu out rather than leaving it to spill", () => {
    expect(rule(css, ".mobile-app .notes-node-menu-slot")).toContain("display: none");
  });
});
