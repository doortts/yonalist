import { nudgePageZoom, pageZoomStep } from "./pageZoom";

function setPlatform(value: string): void {
  Object.defineProperty(globalThis.navigator, "platform", {
    value,
    configurable: true
  });
}

function press(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

afterEach(() => setPlatform(""));

describe("page zoom shortcut", () => {
  it("reads the mac chord in both directions and ignores the windows one", () => {
    setPlatform("MacIntel");

    expect(pageZoomStep(press({ key: "=", metaKey: true }))).toBe(5);
    // "+" is Shift+= on most layouts, and the numeric keypad reports it too.
    expect(pageZoomStep(press({ key: "+", metaKey: true, shiftKey: true }))).toBe(5);
    expect(pageZoomStep(press({ key: "-", metaKey: true }))).toBe(-5);
    expect(pageZoomStep(press({ key: "=", ctrlKey: true }))).toBe(0);
  });

  it("reads the windows and linux chord and ignores the mac one", () => {
    setPlatform("Win32");

    expect(pageZoomStep(press({ key: "=", ctrlKey: true }))).toBe(5);
    expect(pageZoomStep(press({ key: "-", ctrlKey: true }))).toBe(-5);
    expect(pageZoomStep(press({ key: "=", metaKey: true }))).toBe(0);
  });

  it("leaves the chords the window already spends elsewhere alone", () => {
    setPlatform("MacIntel");

    // Cmd+0 opens All pages here, so there is no reset chord to collide with.
    expect(pageZoomStep(press({ key: "0", metaKey: true }))).toBe(0);
    expect(pageZoomStep(press({ key: "=" }))).toBe(0);
    // Ctrl+Cmd and Alt chords belong to somebody else.
    expect(pageZoomStep(press({ key: "=", metaKey: true, ctrlKey: true }))).toBe(0);
    expect(pageZoomStep(press({ key: "-", metaKey: true, altKey: true }))).toBe(0);
    // A key still being composed is the input method's.
    expect(pageZoomStep(press({ key: "-", metaKey: true, isComposing: true }))).toBe(0);
  });
});

describe("page zoom size", () => {
  // No `localStorage` under this test environment, which is the reason the
  // module reads and writes it inside a try: the size still steps without it.
  it("steps and stops at the ends", async () => {
    expect("__TAURI_INTERNALS__" in window).toBe(false);

    expect(await nudgePageZoom(5)).toBe(105);
    expect(await nudgePageZoom(5)).toBe(110);

    // Far past the ceiling in one press, then far past the floor.
    expect(await nudgePageZoom(500)).toBe(300);
    expect(await nudgePageZoom(5)).toBe(300);
    expect(await nudgePageZoom(-500)).toBe(50);
    expect(await nudgePageZoom(-5)).toBe(50);
  });
});
