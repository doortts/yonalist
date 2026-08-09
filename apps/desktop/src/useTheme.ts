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

const themeModeStorageKey = "yonalist.themeMode.v1";
const lightThemeStorageKey = "yonalist.lightTheme.v1";
const darkThemeStorageKey = "yonalist.darkTheme.v1";

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

  return {
    mode,
    setMode,
    lightTheme,
    setLightTheme,
    darkTheme,
    setDarkTheme,
    resolvedTheme
  };
}
