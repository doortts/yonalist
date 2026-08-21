import { isDevtoolsShortcut, toggleDevtools } from "./devtools";

function setPlatform(value: string): void {
  Object.defineProperty(globalThis.navigator, "platform", {
    value,
    configurable: true
  });
}

function press(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { code: "KeyI", ...init });
}

afterEach(() => setPlatform(""));

describe("devtools shortcut", () => {
  it("resolves the mac binding and ignores the windows one", () => {
    setPlatform("MacIntel");

    expect(isDevtoolsShortcut(press({ metaKey: true, altKey: true }))).toBe(true);
    expect(isDevtoolsShortcut(press({ ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("resolves the windows and linux binding and ignores the mac one", () => {
    setPlatform("Win32");

    expect(isDevtoolsShortcut(press({ ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isDevtoolsShortcut(press({ metaKey: true, altKey: true }))).toBe(false);
  });

  it("stays quiet for a bare key, a partial combination, or another key", () => {
    setPlatform("MacIntel");

    expect(isDevtoolsShortcut(press({}))).toBe(false);
    expect(isDevtoolsShortcut(press({ metaKey: true }))).toBe(false);
    // Cmd+Alt+Shift+I is the browser's "inspect" variant, not ours.
    expect(isDevtoolsShortcut(
      press({ metaKey: true, altKey: true, shiftKey: true })
    )).toBe(false);
    expect(isDevtoolsShortcut(
      new KeyboardEvent("keydown", { code: "KeyZ", metaKey: true, altKey: true })
    )).toBe(false);
  });
});

describe("devtools toggle without Tauri", () => {
  it("is inert in the browser preview instead of throwing", async () => {
    expect("__TAURI_INTERNALS__" in window).toBe(false);

    await expect(toggleDevtools()).resolves.toBeUndefined();
  });
});
