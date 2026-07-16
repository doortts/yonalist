import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./useTheme";

function installLocalStorageMock() {
  let store: Record<string, string> = {};
  const localStorageMock = {
    get length() {
      return Object.keys(store).length;
    },
    clear: vi.fn(() => {
      store = {};
    }),
    getItem: vi.fn((key: string) => store[key] ?? null),
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = String(value);
    })
  } as Storage;

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: localStorageMock
  });
}

function installMatchMediaMock(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: vi.fn(
        (_event: "change", listener: (event: MediaQueryListEvent) => void) => {
          listeners.add(listener);
        }
      ),
      removeEventListener: vi.fn(
        (_event: "change", listener: (event: MediaQueryListEvent) => void) => {
          listeners.delete(listener);
        }
      ),
      addListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      }),
      removeListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      }),
      dispatchEvent: vi.fn()
    }))
  });

  return {
    setDark(next: boolean) {
      matches = next;
      for (const listener of listeners) {
        listener({ matches: next } as MediaQueryListEvent);
      }
    }
  };
}

function ThemeProbe() {
  const theme = useTheme();
  return (
    <output
      aria-label="Theme"
      data-mode={theme.mode}
      data-light-theme={theme.lightTheme}
      data-dark-theme={theme.darkTheme}
      data-resolved-theme={theme.resolvedTheme}
    />
  );
}

describe("useTheme", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    vi.restoreAllMocks();
  });

  it("uses Soft Paper as the fresh light theme", () => {
    installLocalStorageMock();
    installMatchMediaMock(false);

    render(<ThemeProbe />);

    expect(screen.getByLabelText("Theme")).toHaveAttribute(
      "data-light-theme",
      "soft-paper"
    );
    expect(document.documentElement.dataset.theme).toBe("soft-paper");
  });

  it("uses the selected light and dark themes when system mode changes", () => {
    installLocalStorageMock();
    const media = installMatchMediaMock(false);
    window.localStorage.setItem("yonalist.themeMode.v1", "system");
    window.localStorage.setItem("yonalist.lightTheme.v1", "yona");
    window.localStorage.setItem("yonalist.darkTheme.v1", "dark");

    render(<ThemeProbe />);

    expect(document.documentElement.dataset.theme).toBe("yona");

    act(() => {
      media.setDark(true);
    });

    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("restores the Yonal Light theme from storage", () => {
    installLocalStorageMock();
    installMatchMediaMock(false);
    window.localStorage.setItem("yonalist.themeMode.v1", "light");
    window.localStorage.setItem("yonalist.lightTheme.v1", "yonal-light");

    render(<ThemeProbe />);

    expect(document.documentElement.dataset.theme).toBe("yonal-light");
  });

  it("restores the Base Light theme from storage", () => {
    installLocalStorageMock();
    installMatchMediaMock(false);
    window.localStorage.setItem("yonalist.themeMode.v1", "light");
    window.localStorage.setItem("yonalist.lightTheme.v1", "base-light");

    render(<ThemeProbe />);

    expect(document.documentElement.dataset.theme).toBe("base-light");
  });

  it("restores the Base Dark theme from storage", () => {
    installLocalStorageMock();
    installMatchMediaMock(false);
    window.localStorage.setItem("yonalist.themeMode.v1", "dark");
    window.localStorage.setItem("yonalist.darkTheme.v1", "base-dark");

    render(<ThemeProbe />);

    expect(document.documentElement.dataset.theme).toBe("base-dark");
  });

  it("applies the Base themes for each mode under system preference", () => {
    installLocalStorageMock();
    const media = installMatchMediaMock(false);
    window.localStorage.setItem("yonalist.themeMode.v1", "system");
    window.localStorage.setItem("yonalist.lightTheme.v1", "base-light");
    window.localStorage.setItem("yonalist.darkTheme.v1", "base-dark");

    render(<ThemeProbe />);

    expect(document.documentElement.dataset.theme).toBe("base-light");

    act(() => {
      media.setDark(true);
    });

    expect(document.documentElement.dataset.theme).toBe("base-dark");
  });
});
