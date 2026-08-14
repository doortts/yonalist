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

/** Levels the settings hold. A deeper row repeats the last one. */
export const OUTLINE_MARKER_LEVELS = 3;

const storageKey = "yonalist.outlineMarkers.v1";
const shapes: readonly OutlineMarkerShape[] = [
  "dot",
  "square",
  "hyphen",
  "dash",
  "custom"
];

export function defaultOutlineMarkerStyles(): OutlineMarkerStyle[] {
  return Array.from({ length: OUTLINE_MARKER_LEVELS }, () => ({
    shape: "dot" as const,
    char: "",
    color: null
  }));
}

/** One code point, so an emoji survives and a pasted word does not. */
export function normalizeMarkerChar(value: string): string {
  return [...value][0] ?? "";
}

export function markerLevelOfDepth(depth: number): number {
  return Math.min(Math.max(depth, 0), OUTLINE_MARKER_LEVELS - 1);
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
  if (!Array.isArray(parsed) || parsed.length !== OUTLINE_MARKER_LEVELS) {
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
}

const boxes: Record<OutlineMarkerShape, ShapeBox> = {
  dot: { w: "7px", h: "7px", r: "50%" },
  square: { w: "6px", h: "6px", r: "1.5px" },
  dash: { w: "11px", h: "2.5px", r: "1.5px" },
  hyphen: { w: "auto", h: "auto", r: "0" },
  custom: { w: "auto", h: "auto", r: "0" }
};

export function outlineMarkerVariables(
  styles: readonly OutlineMarkerStyle[]
): Record<string, string> {
  const variables: Record<string, string> = {};
  styles.forEach((level, index) => {
    const box = boxes[level.shape];
    const drawsGlyph = level.shape === "hyphen" || level.shape === "custom";
    const glyph = level.shape === "hyphen"
      ? "-"
      : level.shape === "custom" ? level.char : "";
    variables[`--notes-marker-${index}-w`] = box.w;
    variables[`--notes-marker-${index}-h`] = box.h;
    variables[`--notes-marker-${index}-r`] = box.r;
    variables[`--notes-marker-${index}-bg`] = drawsGlyph
      ? "transparent"
      : "currentColor";
    variables[`--notes-marker-${index}-char`] = cssString(glyph);
    variables[`--notes-marker-${index}-color`] = level.color ?? "inherit";
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

  const setLevel = useCallback((level: number, next: OutlineMarkerStyle) => {
    setStyles((current) => {
      const updated = current.map((value, index) =>
        index === level ? next : value);
      saveOutlineMarkerStyles(updated);
      return updated;
    });
  }, []);

  return { markerStyles: styles, setMarkerStyle: setLevel };
}
