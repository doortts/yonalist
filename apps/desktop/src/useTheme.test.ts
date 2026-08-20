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
    document.documentElement.removeAttribute("style");
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

  it("leaves the caret to the theme when nothing is stored", () => {
    const { result } = renderHook(() => useTheme());

    expect(result.current.caretColor).toBe("auto");
    expect(
      document.documentElement.style.getPropertyValue("--caret-strong")
    ).toBe("");
  });

  it("falls back to auto when the stored caret color is not a hex", () => {
    window.localStorage.setItem("yonalist.caretColor.v1", "rebeccapurple");

    const { result } = renderHook(() => useTheme());

    expect(result.current.caretColor).toBe("auto");
  });

  it("applies and persists a picked caret color", () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setCaretColor("#ff375f"));

    expect(result.current.caretColor).toBe("#ff375f");
    expect(
      document.documentElement.style.getPropertyValue("--caret-strong")
    ).toBe("#ff375f");
    expect(window.localStorage.getItem("yonalist.caretColor.v1")).toBe("#ff375f");
  });

  it("hands the caret back to the theme when set to auto", () => {
    window.localStorage.setItem("yonalist.caretColor.v1", "#30d158");

    const { result } = renderHook(() => useTheme());
    expect(result.current.caretColor).toBe("#30d158");

    act(() => result.current.setCaretColor("auto"));

    expect(
      document.documentElement.style.getPropertyValue("--caret-strong")
    ).toBe("");
    expect(window.localStorage.getItem("yonalist.caretColor.v1")).toBe("auto");
  });

  // The setting has to survive a restart, and the stylesheet keys off the
  // attribute rather than a class, so both halves are worth pinning.
  it("keeps the outline text font on the document and in storage", () => {
    const { result } = renderHook(() => useTheme());

    expect(result.current.textFont).toBe("sans");
    expect(document.documentElement.dataset.textFont).toBe("sans");

    act(() => result.current.setTextFont("mono"));

    expect(document.documentElement.dataset.textFont).toBe("mono");
    expect(window.localStorage.getItem("yonalist.textFont.v1")).toBe("mono");
  });

  // The handwriting font is the third value the same key carries, so the
  // restart path -- read the key, stamp the attribute -- is what this pins.
  it("restores the stored handwriting font", () => {
    window.localStorage.setItem("yonalist.textFont.v1", "hand");

    const { result } = renderHook(() => useTheme());

    expect(result.current.textFont).toBe("hand");
    expect(document.documentElement.dataset.textFont).toBe("hand");
  });
});
