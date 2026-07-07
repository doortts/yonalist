import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultSettings,
  loadSettings,
  normalizeSettings,
  persistSettings,
  settingsNeedNormalization
} from "./appSettings";

describe("app settings", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("enables visible item prefetch by default", () => {
    expect(defaultSettings.prefetchVisibleItems).toBe(true);
    expect(loadSettings().prefetchVisibleItems).toBe(true);
  });

  it("loads the persisted visible item prefetch setting", () => {
    window.localStorage.setItem(
      "yonalist.settings.v1",
      JSON.stringify({ prefetchVisibleItems: false })
    );

    expect(loadSettings().prefetchVisibleItems).toBe(false);
  });

  it("normalizes older settings that predate visible item prefetch", () => {
    const legacySettings = {
      vaultFolder: "~/Yonalist",
      syncQueuedOnReconnect: true,
      cacheLinkedAttachments: true,
      downloadCommentsWhileSyncing: true,
      desktopNotifications: true,
      markdownStyle: "yona" as const
    };

    window.localStorage.setItem(
      "yonalist.settings.v1",
      JSON.stringify(legacySettings)
    );

    expect(settingsNeedNormalization(legacySettings)).toBe(true);
    expect(loadSettings().prefetchVisibleItems).toBe(true);
    expect(normalizeSettings(legacySettings).prefetchVisibleItems).toBe(true);
  });

  it("persists settings with the current schema", () => {
    persistSettings({
      ...defaultSettings,
      markdownStyle: "yona"
    });

    expect(window.localStorage.getItem("yonalist.settings.v1")).toContain(
      "\"prefetchVisibleItems\":true"
    );
  });
});
