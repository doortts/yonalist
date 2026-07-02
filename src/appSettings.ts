export interface AppSettings {
  hostName: string;
  webBaseUrl: string;
  apiBaseUrl: string;
  oauthClientId: string;
  oauthScopes: string;
  personalAccessToken: string;
  vaultFolder: string;
  syncQueuedOnReconnect: boolean;
  cacheLinkedAttachments: boolean;
  downloadCommentsWhileSyncing: boolean;
}

export const defaultSettings: AppSettings = {
  hostName: "github.com",
  webBaseUrl: "https://github.com",
  apiBaseUrl: "https://api.github.com",
  oauthClientId: "",
  oauthScopes: "repo",
  personalAccessToken: "",
  vaultFolder: "~/Yonalist",
  syncQueuedOnReconnect: true,
  cacheLinkedAttachments: true,
  downloadCommentsWhileSyncing: true
};

const settingsStorageKey = "yonalist.settings.v1";

export function loadSettings(): AppSettings {
  try {
    const stored = window.localStorage.getItem(settingsStorageKey);
    if (!stored) {
      return defaultSettings;
    }

    return {
      ...defaultSettings,
      ...(JSON.parse(stored) as Partial<AppSettings>)
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
