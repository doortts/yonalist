import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetApplicationData } from "./appReset";

const cacheMocks = vi.hoisted(() => ({
  clearImageProxyCache: vi.fn(),
  clearNotificationCache: vi.fn()
}));

vi.mock("./sessionTokens", () => ({
  clearSessionToken: vi.fn(async () => undefined)
}));

vi.mock("./imageProxy", () => ({
  clearImageProxyCache: cacheMocks.clearImageProxyCache
}));

vi.mock("./notifications", () => ({
  clearNotificationCache: cacheMocks.clearNotificationCache
}));

describe("resetApplicationData", () => {
  beforeEach(() => {
    cacheMocks.clearImageProxyCache.mockReset();
    cacheMocks.clearNotificationCache.mockReset();
    window.localStorage.clear();
  });

  it("clears settings and caches without touching unrelated browser data", async () => {
    window.localStorage.setItem("yonalist.settings.v1", "{\"vaultFolder\":\"/tmp\"}");
    window.localStorage.setItem("yonalist.themeMode.v1", "dark");
    window.localStorage.setItem(
      "yonalist.github.sessionTokens.v1",
      JSON.stringify({ "https://api.github.com": "gho_session" })
    );
    window.localStorage.setItem(
      "yonalist.testCache.v1",
      JSON.stringify({ "https://api.github.com": [] })
    );
    window.localStorage.setItem("unrelated", "kept");

    const events: string[] = [];
    await resetApplicationData({
      serverUrls: ["https://api.github.com"],
      onStep: (event) => {
        events.push(`${event.id}:${event.status}`);
      }
    });

    expect(events).toEqual([
      "session-tokens:running",
      "session-tokens:complete",
      "runtime-caches:running",
      "runtime-caches:complete",
      "local-storage:running",
      "local-storage:complete"
    ]);
    expect(window.localStorage.getItem("yonalist.settings.v1")).toBeNull();
    expect(window.localStorage.getItem("yonalist.themeMode.v1")).toBeNull();
    expect(window.localStorage.getItem("yonalist.github.sessionTokens.v1")).toBeNull();
    expect(window.localStorage.getItem("yonalist.testCache.v1")).toBeNull();
    expect(window.localStorage.getItem("unrelated")).toBe("kept");
    expect(cacheMocks.clearNotificationCache).toHaveBeenCalledOnce();
    expect(cacheMocks.clearImageProxyCache).toHaveBeenCalledOnce();
  });

  it("removes external snapshots and all other Yonalist browser keys", async () => {
    window.localStorage.setItem(
      "yonalist.externalSources.snapshots.v1",
      JSON.stringify({ cached: "external" })
    );
    window.localStorage.setItem("yonalist.otherRuntimeCache.v1", "cached");

    await resetApplicationData();

    expect(
      window.localStorage.getItem("yonalist.externalSources.snapshots.v1")
    ).toBeNull();
    expect(window.localStorage.getItem("yonalist.otherRuntimeCache.v1")).toBeNull();
  });
});
