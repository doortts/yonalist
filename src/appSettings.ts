export type MarkdownStyle = "github" | "yona";

export interface AppSettings {
  vaultFolder: string;
  syncQueuedOnReconnect: boolean;
  cacheLinkedAttachments: boolean;
  downloadCommentsWhileSyncing: boolean;
  desktopNotifications: boolean;
  markdownStyle: MarkdownStyle;
}

export const defaultSettings: AppSettings = {
  vaultFolder: "~/Yonalist",
  syncQueuedOnReconnect: true,
  cacheLinkedAttachments: true,
  downloadCommentsWhileSyncing: true,
  desktopNotifications: true,
  markdownStyle: "github"
};

const settingsStorageKey = "yonalist.settings.v1";

export function loadSettings(): AppSettings {
  try {
    const stored = window.localStorage.getItem(settingsStorageKey);
    if (!stored) {
      return defaultSettings;
    }

    const parsed = JSON.parse(stored) as Partial<AppSettings>;
    // GitHub connection fields moved to the per-server store
    // (yonalist.github.*); only vault/sync preferences remain here.
    return {
      vaultFolder: parsed.vaultFolder ?? defaultSettings.vaultFolder,
      syncQueuedOnReconnect:
        parsed.syncQueuedOnReconnect ?? defaultSettings.syncQueuedOnReconnect,
      cacheLinkedAttachments:
        parsed.cacheLinkedAttachments ?? defaultSettings.cacheLinkedAttachments,
      downloadCommentsWhileSyncing:
        parsed.downloadCommentsWhileSyncing ??
        defaultSettings.downloadCommentsWhileSyncing,
      desktopNotifications:
        parsed.desktopNotifications ?? defaultSettings.desktopNotifications,
      markdownStyle:
        parsed.markdownStyle === "yona" || parsed.markdownStyle === "github"
          ? parsed.markdownStyle
          : defaultSettings.markdownStyle
    };
  } catch {
    return defaultSettings;
  }
}

export function persistSettings(settings: AppSettings) {
  try {
    window.localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
  } catch {
    // Settings remain editable even if the browser storage is unavailable.
  }
}
