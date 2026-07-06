import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeAppBadgeCount, setAppBadgeCount } from "./appBadge";

const setBadgeCountMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setBadgeCount: setBadgeCountMock
  })
}));

function setTauriRuntime(enabled: boolean) {
  if (enabled) {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    return;
  }
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
}

describe("app badge", () => {
  afterEach(() => {
    setTauriRuntime(false);
    setBadgeCountMock.mockReset();
  });

  it("normalizes zero and invalid counts into a cleared badge", () => {
    expect(normalizeAppBadgeCount(0)).toBeUndefined();
    expect(normalizeAppBadgeCount(-1)).toBeUndefined();
    expect(normalizeAppBadgeCount(Number.NaN)).toBeUndefined();
  });

  it("normalizes positive counts into integer badge counts", () => {
    expect(normalizeAppBadgeCount(16)).toBe(16);
    expect(normalizeAppBadgeCount(16.9)).toBe(16);
  });

  it("sets and clears the Tauri app badge", async () => {
    setTauriRuntime(true);

    await setAppBadgeCount(12);
    await setAppBadgeCount(0);

    expect(setBadgeCountMock).toHaveBeenNthCalledWith(1, 12);
    expect(setBadgeCountMock).toHaveBeenNthCalledWith(2, undefined);
  });

  it("does nothing outside the desktop app", async () => {
    await setAppBadgeCount(12);

    expect(setBadgeCountMock).not.toHaveBeenCalled();
  });
});
