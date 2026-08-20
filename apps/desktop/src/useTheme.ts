import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type LightTheme =
  | "soft-paper"
  | "default"
  | "yona"
  | "yonal-light"
  | "base-light";
export type DarkTheme = "dark" | "yona-dark" | "base-dark";
export type ResolvedTheme = LightTheme | DarkTheme;
/** "auto" leaves the caret to the theme stylesheet; anything else is a #rrggbb. */
export type CaretColor = "auto" | string;
/** What the outline's own text is set in; the rest of the app never changes. */
export type TextFont = "sans" | "mono" | "hand";
/**
 * Which hand writes the outline once the outline text is handwriting.
 * "excalidraw" is the Excalifont and Xiaolai pair excalidraw.com writes in;
 * the rest each draw both scripts themselves.
 */
export const handwritingFaces = [
  "excalidraw",
  "nanum",
  "gaegu",
  "gamja-flower",
  "poor-story",
  "single-day"
] as const;
export type HandwritingFace = (typeof handwritingFaces)[number];

const themeModeStorageKey = "yonalist.themeMode.v1";
const lightThemeStorageKey = "yonalist.lightTheme.v1";
const darkThemeStorageKey = "yonalist.darkTheme.v1";
const caretColorStorageKey = "yonalist.caretColor.v1";
const textFontStorageKey = "yonalist.textFont.v1";
const handwritingFaceStorageKey = "yonalist.handwritingFace.v1";

function readStoredValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredValue(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The theme still applies for the session without persistence.
  }
}

function loadThemeMode(): ThemeMode {
  const stored = readStoredValue(themeModeStorageKey);
  if (stored === "dark" || stored === "system") {
    return stored;
  }
  if (stored === "light" || stored === "default" || stored === "yona") {
    return "light";
  }
  return "system";
}

function loadLightTheme(): LightTheme {
  const stored = readStoredValue(lightThemeStorageKey);
  if (
    stored === "soft-paper" ||
    stored === "default" ||
    stored === "yona" ||
    stored === "yonal-light" ||
    stored === "base-light"
  ) {
    return stored;
  }
  return readStoredValue(themeModeStorageKey) === "yona" ? "yona" : "soft-paper";
}

function loadDarkTheme(): DarkTheme {
  const stored = readStoredValue(darkThemeStorageKey);
  if (stored === "dark" || stored === "yona-dark" || stored === "base-dark") {
    return stored;
  }
  return "dark";
}

function loadCaretColor(): CaretColor {
  const stored = readStoredValue(caretColorStorageKey);
  return stored && /^#[0-9a-f]{6}$/i.test(stored) ? stored : "auto";
}

function loadTextFont(): TextFont {
  const stored = readStoredValue(textFontStorageKey);
  return stored === "mono" || stored === "hand" ? stored : "sans";
}

function loadHandwritingFace(): HandwritingFace {
  const stored = readStoredValue(handwritingFaceStorageKey);
  return handwritingFaces.includes(stored as HandwritingFace)
    ? (stored as HandwritingFace)
    : "excalidraw";
}

function systemPrefersDark(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(() => loadThemeMode());
  const [lightTheme, setLightThemeState] = useState<LightTheme>(() => loadLightTheme());
  const [darkTheme, setDarkThemeState] = useState<DarkTheme>(() => loadDarkTheme());
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark());
  const [caretColor, setCaretColorState] = useState<CaretColor>(() => loadCaretColor());
  const [textFont, setTextFontState] = useState<TextFont>(() => loadTextFont());
  const [handwritingFace, setHandwritingFaceState] = useState<HandwritingFace>(
    () => loadHandwritingFace()
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function handleChange(event: MediaQueryListEvent) {
      setSystemDark(event.matches);
    }
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleChange);
      return () => media.removeEventListener("change", handleChange);
    }
    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  }, []);

  const resolvedTheme: ResolvedTheme =
    mode === "system"
      ? systemDark
        ? darkTheme
        : lightTheme
      : mode === "dark"
        ? darkTheme
        : lightTheme;

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    if (caretColor === "auto") {
      document.documentElement.style.removeProperty("--caret-strong");
      return;
    }
    document.documentElement.style.setProperty("--caret-strong", caretColor);
  }, [caretColor]);

  useEffect(() => {
    document.documentElement.dataset.textFont = textFont;
  }, [textFont]);

  useEffect(() => {
    document.documentElement.dataset.handwritingFace = handwritingFace;
  }, [handwritingFace]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    writeStoredValue(themeModeStorageKey, next);
  }, []);

  const setLightTheme = useCallback((next: LightTheme) => {
    setLightThemeState(next);
    writeStoredValue(lightThemeStorageKey, next);
  }, []);

  const setDarkTheme = useCallback((next: DarkTheme) => {
    setDarkThemeState(next);
    writeStoredValue(darkThemeStorageKey, next);
  }, []);

  const setCaretColor = useCallback((next: CaretColor) => {
    setCaretColorState(next);
    writeStoredValue(caretColorStorageKey, next);
  }, []);

  const setTextFont = useCallback((next: TextFont) => {
    setTextFontState(next);
    writeStoredValue(textFontStorageKey, next);
  }, []);

  const setHandwritingFace = useCallback((next: HandwritingFace) => {
    setHandwritingFaceState(next);
    writeStoredValue(handwritingFaceStorageKey, next);
  }, []);

  return {
    mode,
    setMode,
    lightTheme,
    setLightTheme,
    darkTheme,
    setDarkTheme,
    caretColor,
    setCaretColor,
    textFont,
    setTextFont,
    handwritingFace,
    setHandwritingFace,
    resolvedTheme
  };
}
