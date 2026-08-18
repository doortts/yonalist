import { useCallback, useEffect, useState } from "react";

/**
 * What a row draws in front of its text. `dot`, `square` and `dash` are boxes
 * the stylesheet sizes, so they hold their weight whatever the font does;
 * `hyphen` and `custom` are glyphs, which is the only way a chosen character
 * can be one.
 */
export type OutlineMarkerShape =
  | "dot"
  | "square"
  | "hyphen"
  | "dash"
  | "custom";

export interface OutlineMarkerStyle {
  readonly shape: OutlineMarkerShape;
  /** The `custom` glyph; empty for every other shape. */
  readonly char: string;
  /** `null` leaves the marker on the theme's own text colour. */
  readonly color: string | null;
}

/**
 * The most levels the settings will hold. A row past the last configured level
 * keeps that level's marker, so this is a bound on the settings screen rather
 * than on how deep an outline can go.
 */
export const MAX_OUTLINE_MARKER_LEVELS = 6;

const storageKey = "yonalist.outlineMarkers.v1";
const shapes: readonly OutlineMarkerShape[] = [
  "dot",
  "square",
  "hyphen",
  "dash",
  "custom"
];

/** One level, the dot the rows drew before any of this was configurable. */
export function defaultOutlineMarkerStyles(): OutlineMarkerStyle[] {
  return [{ shape: "dot", char: "", color: null }];
}

/** One code point, so an emoji survives and a pasted word does not. */
export function normalizeMarkerChar(value: string): string {
  return [...value][0] ?? "";
}

/**
 * The level a row of this depth stamps. A row cannot know how many levels the
 * settings hold -- it would have to re-render on every change to find out -- so
 * it clamps to the highest slot there could be and the variables do the rest:
 * every slot above the last configured level repeats that level.
 */
export function markerLevelOfDepth(depth: number): number {
  return Math.min(Math.max(depth, 0), MAX_OUTLINE_MARKER_LEVELS - 1);
}

function readStyle(value: unknown): OutlineMarkerStyle | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const shape = record.shape;
  const char = record.char;
  const color = record.color;
  if (typeof shape !== "string" || !shapes.includes(shape as OutlineMarkerShape)) {
    return null;
  }
  if (typeof char !== "string") return null;
  if (color !== null && !(typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color))) {
    return null;
  }
  return {
    shape: shape as OutlineMarkerShape,
    char: normalizeMarkerChar(char),
    color
  };
}

export function loadOutlineMarkerStyles(): OutlineMarkerStyle[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(storageKey);
  } catch {
    return defaultOutlineMarkerStyles();
  }
  if (!raw) return defaultOutlineMarkerStyles();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultOutlineMarkerStyles();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.length > MAX_OUTLINE_MARKER_LEVELS
  ) {
    return defaultOutlineMarkerStyles();
  }
  const levels = parsed.map(readStyle);
  return levels.every((level): level is OutlineMarkerStyle => level !== null)
    ? levels
    : defaultOutlineMarkerStyles();
}

export function saveOutlineMarkerStyles(
  styles: readonly OutlineMarkerStyle[]
): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(styles));
  } catch {
    // The markers still apply for the session without persistence.
  }
}

function cssString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

interface ShapeBox {
  readonly w: string;
  readonly h: string;
  readonly r: string;
  /**
   * How far below the line box's middle the shape sits. A box the height of the
   * text centres on the line and needs none; a bar as thin as the dash reads as
   * a hyphen, and a hyphen's own bar sits a pixel under that middle.
   */
  readonly dy?: string;
}

/**
 * A hyphen drawn in the interface font is short and thin, because a
 * proportional font gives it only the width the character needs. A monospace
 * font draws it to fill a fixed advance, which is the long, even dash a
 * Markdown list is read with -- so the hyphen marker takes that font and every
 * other glyph keeps the row's own.
 */
export const monospaceStack =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, ' +
  '"Liberation Mono", monospace';

const boxes: Record<OutlineMarkerShape, ShapeBox> = {
  dot: { w: "7px", h: "7px", r: "50%" },
  square: { w: "6px", h: "6px", r: "1.5px" },
  dash: { w: "8px", h: "2.5px", r: "0", dy: "1px" },
  hyphen: { w: "auto", h: "auto", r: "0" },
  custom: { w: "auto", h: "auto", r: "0" }
};

export function outlineMarkerVariables(
  styles: readonly OutlineMarkerStyle[]
): Record<string, string> {
  const variables: Record<string, string> = {};
  const last = styles.at(-1) ?? defaultOutlineMarkerStyles()[0]!;
  // Every slot is written, configured or not: the ones past the last level
  // repeat it, which is what makes a deep row keep the marker its parent drew.
  const slots = Array.from(
    { length: MAX_OUTLINE_MARKER_LEVELS },
    (_, slot) => styles[slot] ?? last
  );
  slots.forEach((level, index) => {
    const box = boxes[level.shape];
    const drawsGlyph = level.shape === "hyphen" || level.shape === "custom";
    const glyph = level.shape === "hyphen"
      ? "-"
      : level.shape === "custom" ? level.char : "";
    variables[`--notes-marker-${index}-w`] = box.w;
    variables[`--notes-marker-${index}-h`] = box.h;
    variables[`--notes-marker-${index}-r`] = box.r;
    variables[`--notes-marker-${index}-dy`] = box.dy ?? "0";
    variables[`--notes-marker-${index}-bg`] = drawsGlyph
      ? "transparent"
      : "currentColor";
    variables[`--notes-marker-${index}-char`] = cssString(glyph);
    variables[`--notes-marker-${index}-color`] = level.color ?? "inherit";
    variables[`--notes-marker-${index}-font`] = level.shape === "hyphen"
      ? monospaceStack
      : "inherit";
  });
  return variables;
}

export function applyOutlineMarkerVariables(
  element: HTMLElement,
  styles: readonly OutlineMarkerStyle[]
): void {
  const variables = outlineMarkerVariables(styles);
  for (const [name, value] of Object.entries(variables)) {
    element.style.setProperty(name, value);
  }
}

export function useOutlineMarkerStyles() {
  const [styles, setStyles] = useState<OutlineMarkerStyle[]>(
    () => loadOutlineMarkerStyles()
  );

  useEffect(() => {
    applyOutlineMarkerVariables(document.documentElement, styles);
  }, [styles]);

  const setAll = useCallback((next: OutlineMarkerStyle[]) => {
    setStyles(next);
    saveOutlineMarkerStyles(next);
  }, []);

  return { markerStyles: styles, setMarkerStyles: setAll };
}
