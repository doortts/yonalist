import { act, renderHook } from "@testing-library/react";

import { useTheme } from "./useTheme";

describe("useTheme", () => {
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
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    delete (window as { localStorage?: unknown }).localStorage;
  });

  it("defaults to system mode with the soft-paper light theme", () => {
    const { result } = renderHook(() => useTheme());

    expect(result.current.mode).toBe("system");
    expect(result.current.resolvedTheme).toBe("soft-paper");
    expect(document.documentElement.dataset.theme).toBe("soft-paper");
  });

  it("applies and persists an explicit dark mode", () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setMode("dark"));
    expect(result.current.resolvedTheme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("yonalist.themeMode.v1")).toBe("dark");

    act(() => result.current.setDarkTheme("yona-dark"));
    expect(document.documentElement.dataset.theme).toBe("yona-dark");
  });

  it("restores the persisted selection on the next mount", () => {
    window.localStorage.setItem("yonalist.themeMode.v1", "light");
    window.localStorage.setItem("yonalist.lightTheme.v1", "yona");

    const { result } = renderHook(() => useTheme());

    expect(result.current.mode).toBe("light");
    expect(result.current.resolvedTheme).toBe("yona");
    expect(document.documentElement.dataset.theme).toBe("yona");
  });
});
