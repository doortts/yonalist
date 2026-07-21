export type MarkdownStyle = "github" | "yona";

export interface AppSettings {
  vaultFolder: string;
  syncQueuedOnReconnect: boolean;
  cacheLinkedAttachments: boolean;
  downloadCommentsWhileSyncing: boolean;
  prefetchVisibleItems: boolean;
  desktopNotifications: boolean;
  markdownStyle: MarkdownStyle;
  assetTrashRetentionDays: number;
  assetTrashLargeFileDays: number;
  assetLargeFileThresholdMb: number;
}

export const defaultSettings: AppSettings = {
  vaultFolder: "~/Yonalist",
  syncQueuedOnReconnect: true,
  cacheLinkedAttachments: true,
  downloadCommentsWhileSyncing: true,
  prefetchVisibleItems: true,
  desktopNotifications: true,
  markdownStyle: "github",
  assetTrashRetentionDays: 7,
  assetTrashLargeFileDays: 2,
  assetLargeFileThresholdMb: 5
};

const settingsStorageKey = "yonalist.settings.v1";

function normalizeAssetSetting(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(365, Math.max(0, value))
    : fallback;
}

export function normalizeSettings(settings: Partial<AppSettings> = {}): AppSettings {
  return {
    vaultFolder: settings.vaultFolder ?? defaultSettings.vaultFolder,
    syncQueuedOnReconnect:
      settings.syncQueuedOnReconnect ?? defaultSettings.syncQueuedOnReconnect,
    cacheLinkedAttachments:
      settings.cacheLinkedAttachments ?? defaultSettings.cacheLinkedAttachments,
    downloadCommentsWhileSyncing:
      settings.downloadCommentsWhileSyncing ??
      defaultSettings.downloadCommentsWhileSyncing,
    prefetchVisibleItems:
      settings.prefetchVisibleItems ?? defaultSettings.prefetchVisibleItems,
    desktopNotifications:
      settings.desktopNotifications ?? defaultSettings.desktopNotifications,
    markdownStyle:
      settings.markdownStyle === "yona" || settings.markdownStyle === "github"
        ? settings.markdownStyle
        : defaultSettings.markdownStyle,
    assetTrashRetentionDays: normalizeAssetSetting(
      settings.assetTrashRetentionDays,
      defaultSettings.assetTrashRetentionDays
    ),
    assetTrashLargeFileDays: normalizeAssetSetting(
      settings.assetTrashLargeFileDays,
      defaultSettings.assetTrashLargeFileDays
    ),
    assetLargeFileThresholdMb: normalizeAssetSetting(
      settings.assetLargeFileThresholdMb,
      defaultSettings.assetLargeFileThresholdMb
    )
  };
}

export function settingsNeedNormalization(settings: Partial<AppSettings>): boolean {
  return (
    settings.vaultFolder === undefined ||
    settings.syncQueuedOnReconnect === undefined ||
    settings.cacheLinkedAttachments === undefined ||
    settings.downloadCommentsWhileSyncing === undefined ||
    settings.prefetchVisibleItems === undefined ||
    settings.desktopNotifications === undefined ||
    settings.markdownStyle !== normalizeSettings(settings).markdownStyle ||
    settings.assetTrashRetentionDays !==
      normalizeSettings(settings).assetTrashRetentionDays ||
    settings.assetTrashLargeFileDays !==
      normalizeSettings(settings).assetTrashLargeFileDays ||
    settings.assetLargeFileThresholdMb !==
      normalizeSettings(settings).assetLargeFileThresholdMb
  );
}

export function loadSettings(): AppSettings {
  try {
    const stored = window.localStorage.getItem(settingsStorageKey);
    if (!stored) {
      return defaultSettings;
    }

    const parsed = JSON.parse(stored) as Partial<AppSettings>;
    // GitHub connection fields moved to the per-server store
    // (yonalist.github.*); only vault/sync preferences remain here.
    return normalizeSettings(parsed);
  } catch {
    return defaultSettings;
  }
}

export function persistSettings(settings: AppSettings) {
  try {
    window.localStorage.setItem(
      settingsStorageKey,
      JSON.stringify(normalizeSettings(settings))
    );
  } catch {
    // Settings remain editable even if the browser storage is unavailable.
  }
}
