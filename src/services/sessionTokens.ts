import { isTauri } from "./oauth";

/**
 * Persistence for OAuth session tokens so a restart signs back in without
 * asking. The desktop build keeps tokens in the OS keychain (via the
 * store_token/load_token/delete_token commands); the browser build falls back
 * to localStorage, matching how personal tokens are already stored there.
 */

const KEYCHAIN_SERVICE = "Yonalist GitHub";
const WEB_STORAGE_KEY = "yonalist.github.sessionTokens.v1";

function loadWebTokens(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(WEB_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function persistWebTokens(tokens: Record<string, string>): boolean {
  try {
    window.localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(tokens));
    return true;
  } catch {
    // The session still works in memory; it just won't survive a restart.
    return false;
  }
}

function normalize(token: string | null | undefined): string | null {
  const trimmed = token?.trim();
  return trimmed ? trimmed : null;
}

export async function saveSessionToken(url: string, token: string): Promise<void> {
  const normalized = normalize(token);
  if (!normalized) {
    await clearSessionToken(url);
    return;
  }

  const persistFallback = () =>
    persistWebTokens({ ...loadWebTokens(), [url]: normalized });

  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      await invoke("store_token", {
        service: KEYCHAIN_SERVICE,
        account: url,
        token: normalized
      });
    } catch (error) {
      if (!persistFallback()) {
        throw error;
      }
      return;
    }
    persistFallback();
    return;
  }
  persistFallback();
}

export async function loadSessionToken(url: string): Promise<string | null> {
  const fallbackToken = normalize(loadWebTokens()[url]);
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const keychainToken = normalize(
        await invoke<string | null>("load_token", {
          service: KEYCHAIN_SERVICE,
          account: url
        })
      );
      if (keychainToken) {
        persistWebTokens({ ...loadWebTokens(), [url]: keychainToken });
        return keychainToken;
      }
    } catch {
      // A locked/unavailable keychain should not block startup.
    }
    return fallbackToken;
  }
  return fallbackToken;
}

export async function clearSessionToken(url: string): Promise<void> {
  const tokens = loadWebTokens();
  delete tokens[url];
  persistWebTokens(tokens);

  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("delete_token", {
        service: KEYCHAIN_SERVICE,
        account: url
      });
    } catch {
      // Nothing sensible to do; the gate will still require a fresh login.
    }
    return;
  }
}
