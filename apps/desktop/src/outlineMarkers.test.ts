import {
  applyOutlineMarkerVariables,
  defaultOutlineMarkerStyles,
  loadOutlineMarkerStyles,
  markerLevelOfDepth,
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

  it("starts every level on the dot the rows already draw", () => {
    expect(loadOutlineMarkerStyles()).toEqual(defaultOutlineMarkerStyles());
    expect(defaultOutlineMarkerStyles().map((level) => level.shape))
      .toEqual(["dot", "dot", "dot"]);
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

  it("keeps one code point of a custom marker, emoji included", () => {
    expect(normalizeMarkerChar("▸▸")).toBe("▸");
    expect(normalizeMarkerChar("🍎")).toBe("🍎");
    expect(normalizeMarkerChar("")).toBe("");
  });

  // The row repeats its last configured level rather than running out of
  // markers, so a deep branch keeps drawing the marker its parent drew.
  it("repeats the last level below the configured depth", () => {
    expect([0, 1, 2, 3, 9].map(markerLevelOfDepth)).toEqual([0, 1, 2, 2, 2]);
  });

  it("writes box shapes as a size and glyph shapes as content", () => {
    const variables = outlineMarkerVariables([
      style({ shape: "dash" }),
      style({ shape: "hyphen" }),
      style({ shape: "custom", char: "▸", color: "#e8734a" })
    ]);
    expect(variables["--notes-marker-0-w"]).toBe("11px");
    expect(variables["--notes-marker-0-h"]).toBe("2.5px");
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
