import {
  applyOutlineMarkerVariables,
  defaultOutlineMarkerStyles,
  loadOutlineMarkerStyles,
  markerLevelOfDepth,
  MAX_OUTLINE_MARKER_LEVELS,
  normalizeMarkerChar,
  outlineMarkerVariables,
  saveOutlineMarkerStyles,
  type OutlineMarkerStyle
} from "./outlineMarkers";

function style(patch: Partial<OutlineMarkerStyle>): OutlineMarkerStyle {
  return { shape: "dot", char: "", color: null, ...patch };
}

describe("outline marker styles", () => {
  beforeEach(() => {
    const backing = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) => backing.set(key, value),
        removeItem: (key: string) => backing.delete(key),
        clear: () => backing.clear()
      }
    });
  });

  afterEach(() => {
    delete (window as { localStorage?: unknown }).localStorage;
  });

  // One level to begin with: the reader adds a second only once they want the
  // depth below to look different, and everything deeper follows the last one.
  it("starts on a single dot level", () => {
    expect(loadOutlineMarkerStyles()).toEqual(defaultOutlineMarkerStyles());
    expect(defaultOutlineMarkerStyles()).toEqual([
      { shape: "dot", char: "", color: null }
    ]);
  });

  it("reads back what it stored", () => {
    const stored = [
      style({ shape: "square", color: "#e8734a" }),
      style({ shape: "dash" }),
      style({ shape: "custom", char: "▸" })
    ];
    saveOutlineMarkerStyles(stored);
    expect(loadOutlineMarkerStyles()).toEqual(stored);
  });

  it("falls back to the default when the stored value is unusable", () => {
    window.localStorage.setItem("yonalist.outlineMarkers.v1", "{oops");
    expect(loadOutlineMarkerStyles()).toEqual(defaultOutlineMarkerStyles());
    window.localStorage.setItem(
      "yonalist.outlineMarkers.v1",
      JSON.stringify([{ shape: "triangle", char: "", color: "red" }])
    );
    expect(loadOutlineMarkerStyles()).toEqual(defaultOutlineMarkerStyles());
  });

  // The stored count is what the reader built, so it has to come back at any
  // length the settings could have produced -- and at no other.
  it("reads back any level count the settings can build, and no other", () => {
    for (const count of [1, 2, MAX_OUTLINE_MARKER_LEVELS]) {
      const stored = Array.from({ length: count }, () => style({}));
      saveOutlineMarkerStyles(stored);
      expect(loadOutlineMarkerStyles()).toHaveLength(count);
    }
    for (const count of [0, MAX_OUTLINE_MARKER_LEVELS + 1]) {
      window.localStorage.setItem(
        "yonalist.outlineMarkers.v1",
        JSON.stringify(Array.from({ length: count }, () => style({})))
      );
      expect(loadOutlineMarkerStyles()).toEqual(defaultOutlineMarkerStyles());
    }
  });

  it("keeps one code point of a custom marker, emoji included", () => {
    expect(normalizeMarkerChar("▸▸")).toBe("▸");
    expect(normalizeMarkerChar("🍎")).toBe("🍎");
    expect(normalizeMarkerChar("")).toBe("");
  });

  // The row stamps its level without knowing how many the settings hold: it
  // clamps to the highest level there could be, and the variables for the
  // levels nobody configured repeat the last one that is.
  it("clamps a row's level to the highest the settings could hold", () => {
    expect([0, 1, 5, 6, 40].map(markerLevelOfDepth)).toEqual([0, 1, 5, 5, 5]);
  });

  it("repeats the last configured level over every slot above it", () => {
    const variables = outlineMarkerVariables([
      style({ shape: "dot" }),
      style({ shape: "dash", color: "#e8734a" })
    ]);

    for (let slot = 1; slot < MAX_OUTLINE_MARKER_LEVELS; slot += 1) {
      expect(variables[`--notes-marker-${slot}-w`]).toBe("8px");
      expect(variables[`--notes-marker-${slot}-color`]).toBe("#e8734a");
    }
    expect(variables["--notes-marker-0-w"]).toBe("7px");
    expect(variables[`--notes-marker-${MAX_OUTLINE_MARKER_LEVELS}-w`])
      .toBeUndefined();
  });

  it("writes box shapes as a size and glyph shapes as content", () => {
    const variables = outlineMarkerVariables([
      style({ shape: "dash" }),
      style({ shape: "hyphen" }),
      style({ shape: "custom", char: "▸", color: "#e8734a" })
    ]);
    expect(variables["--notes-marker-0-w"]).toBe("8px");
    expect(variables["--notes-marker-0-h"]).toBe("2.5px");
    // The dash reads as a hyphen, so it sits where a hyphen's bar does: a pixel
    // under the line box's middle, which every other shape centres on.
    expect(variables["--notes-marker-0-dy"]).toBe("1px");
    expect(variables["--notes-marker-1-dy"]).toBe("0");
    expect(variables["--notes-marker-0-bg"]).toBe("currentColor");
    expect(variables["--notes-marker-0-char"]).toBe('""');
    expect(variables["--notes-marker-1-bg"]).toBe("transparent");
    expect(variables["--notes-marker-1-char"]).toBe('"-"');
    expect(variables["--notes-marker-2-char"]).toBe('"▸"');
    expect(variables["--notes-marker-2-color"]).toBe("#e8734a");
    expect(variables["--notes-marker-0-color"]).toBe("inherit");
  });

  // A proportional font draws the hyphen only as wide as the character needs,
  // which reads as a speck beside a Markdown list's even dash.
  it("gives the hyphen a monospace font and leaves every other shape alone", () => {
    const variables = outlineMarkerVariables([
      style({ shape: "hyphen" }),
      style({ shape: "custom", char: "▸" }),
      style({ shape: "dot" })
    ]);

    expect(variables["--notes-marker-0-font"]).toContain("ui-monospace");
    expect(variables["--notes-marker-1-font"]).toBe("inherit");
    expect(variables["--notes-marker-2-font"]).toBe("inherit");
  });

  it("escapes a custom marker that would break out of the CSS string", () => {
    const variables = outlineMarkerVariables([
      style({ shape: "custom", char: '"' }),
      style({ shape: "custom", char: "\\" }),
      style({})
    ]);
    expect(variables["--notes-marker-0-char"]).toBe('"\\""');
    expect(variables["--notes-marker-1-char"]).toBe('"\\\\"');
  });

  it("applies the variables to an element", () => {
    const element = document.createElement("div");
    applyOutlineMarkerVariables(element, [
      style({ shape: "square" }),
      style({}),
      style({})
    ]);
    expect(element.style.getPropertyValue("--notes-marker-0-w")).toBe("6px");
  });
});
