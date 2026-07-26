import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultSettings,
  loadSettings,
  normalizeGithubNotificationsReadRetentionDays,
  normalizeSettings,
  persistSettings,
  settingsNeedNormalization
} from "./appSettings";

describe("app settings", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists settings with the current schema", () => {
    persistSettings({
      ...defaultSettings,
      markdownStyle: "yona"
    });

    expect(loadSettings()).toEqual({
      ...defaultSettings,
      markdownStyle: "yona"
    });
  });

  it("drops legacy Inbox fields when settings are normalized", () => {
    const result = normalizeSettings({
      ...defaultSettings,
      syncQueuedOnReconnect: true,
      cacheLinkedAttachments: true,
      downloadCommentsWhileSyncing: true,
      prefetchVisibleItems: true
    } as Partial<import("./appSettings").AppSettings> &
      Record<string, unknown>);

    expect(result).not.toHaveProperty("syncQueuedOnReconnect");
    expect(result).not.toHaveProperty("cacheLinkedAttachments");
    expect(result).not.toHaveProperty("downloadCommentsWhileSyncing");
    expect(result).not.toHaveProperty("prefetchVisibleItems");
  });

  it("defaults and normalizes Notes asset trash settings", () => {
    expect(defaultSettings).toMatchObject({
      assetTrashRetentionDays: 7,
      assetTrashLargeFileDays: 2,
      assetLargeFileThresholdMb: 5
    });
    expect(normalizeSettings({
      assetTrashRetentionDays: 999,
      assetTrashLargeFileDays: -1,
      // C5: a non-integer is rounded and clamped rather than reset to default.
      assetLargeFileThresholdMb: 3.5
    })).toMatchObject({
      assetTrashRetentionDays: 365,
      assetTrashLargeFileDays: 0,
      assetLargeFileThresholdMb: 4
    });
    // A non-finite value still falls back to the default.
    expect(
      normalizeSettings({ assetLargeFileThresholdMb: Number.NaN })
        .assetLargeFileThresholdMb
    ).toBe(5);
    expect(settingsNeedNormalization({ ...defaultSettings })).toBe(false);
    expect(settingsNeedNormalization({
      ...defaultSettings,
      assetTrashRetentionDays: 3.5
    })).toBe(true);
  });

  it.each([
    [undefined, 30],
    [0, 1],
    [366, 365],
    [30.6, 31],
    [Number.NaN, 30]
  ])("normalizes GitHub read retention %s to %s", (value, expected) => {
    expect(normalizeGithubNotificationsReadRetentionDays(value)).toBe(expected);
    expect(
      normalizeSettings({ githubNotificationsReadRetentionDays: value as number })
        .githubNotificationsReadRetentionDays
    ).toBe(expected);
  });

  it("includes GitHub read retention in settings schema normalization", () => {
    expect(defaultSettings.githubNotificationsReadRetentionDays).toBe(30);
    expect(settingsNeedNormalization({ ...defaultSettings })).toBe(false);
    expect(
      settingsNeedNormalization({
        ...defaultSettings,
        githubNotificationsReadRetentionDays: 30.5
      })
    ).toBe(true);
  });

  it("defaults and normalizes the GitHub Notifications plugin toggle", () => {
    const legacySettings = { ...defaultSettings };
    Reflect.deleteProperty(
      legacySettings,
      "githubNotificationsPluginEnabled"
    );

    expect(defaultSettings.githubNotificationsPluginEnabled).toBe(true);
    expect(normalizeSettings(legacySettings).githubNotificationsPluginEnabled)
      .toBe(true);
    window.localStorage.setItem(
      "yonalist.settings.v1",
      JSON.stringify(legacySettings)
    );
    expect(loadSettings().githubNotificationsPluginEnabled).toBe(true);
    expect(
      normalizeSettings({ githubNotificationsPluginEnabled: false })
        .githubNotificationsPluginEnabled
    ).toBe(false);
    expect(settingsNeedNormalization(legacySettings)).toBe(true);
    expect(settingsNeedNormalization({ ...defaultSettings })).toBe(false);
  });

  it("persists and reloads a disabled GitHub Notifications plugin", () => {
    persistSettings({
      ...defaultSettings,
      githubNotificationsPluginEnabled: false
    });

    expect(loadSettings().githubNotificationsPluginEnabled).toBe(false);
    expect(window.localStorage.getItem("yonalist.settings.v1")).toContain(
      '"githubNotificationsPluginEnabled":false'
    );
  });
});
