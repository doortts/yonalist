import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const themeStorageKey = "yonalist.themeMode.v1";

function loadThemeMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(themeStorageKey);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // Fall through to the default.
  }
  return "system";
}

function systemPrefersDark(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(() => loadThemeMode());
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark());

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function handleChange(event: MediaQueryListEvent) {
      setSystemDark(event.matches);
    }
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  const resolvedTheme: ResolvedTheme =
    mode === "system" ? (systemDark ? "dark" : "light") : mode;

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(themeStorageKey, next);
    } catch {
      // The theme still applies for the session without persistence.
    }
  }, []);

  return { mode, setMode, resolvedTheme };
}
