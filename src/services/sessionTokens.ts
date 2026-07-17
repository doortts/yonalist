import { isTauri } from "./oauth";

/**
 * Persistence for OAuth session tokens so a restart signs back in without
 * asking. Release desktop builds keep tokens in the OS keychain; debug desktop
 * and browser builds use localStorage.
 */

const KEYCHAIN_SERVICE = "Yonalist GitHub";
const WEB_STORAGE_KEY = "yonalist.github.sessionTokens.v1";

type SessionTokenBackend = "web" | "keychain";

async function sessionTokenBackend(): Promise<SessionTokenBackend> {
  if (!isTauri()) return "web";
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SessionTokenBackend>("session_token_storage_backend");
}

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

function removeWebToken(url: string): void {
  const tokens = loadWebTokens();
  delete tokens[url];
  persistWebTokens(tokens);
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

  if ((await sessionTokenBackend()) === "web") {
    persistWebTokens({ ...loadWebTokens(), [url]: normalized });
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("store_token", {
    service: KEYCHAIN_SERVICE,
    account: url,
    token: normalized
  });
  removeWebToken(url);
}

export async function loadSessionToken(url: string): Promise<string | null> {
  const webToken = normalize(loadWebTokens()[url]);
  if ((await sessionTokenBackend()) === "web") return webToken;

  const { invoke } = await import("@tauri-apps/api/core");
  try {
    const keychainToken = normalize(
      await invoke<string | null>("load_token", {
        service: KEYCHAIN_SERVICE,
        account: url
      })
    );
    if (keychainToken) {
      removeWebToken(url);
      return keychainToken;
    }
    if (!webToken) return null;
    try {
      await invoke("store_token", {
        service: KEYCHAIN_SERVICE,
        account: url,
        token: webToken
      });
      removeWebToken(url);
    } catch {
      // Keep the legacy copy and retry migration on a later launch.
    }
    return webToken;
  } catch {
    return webToken;
  }
}

export async function clearSessionToken(url: string): Promise<void> {
  removeWebToken(url);
  if ((await sessionTokenBackend()) === "web") return;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("delete_token", {
      service: KEYCHAIN_SERVICE,
      account: url
    });
  } catch {
    // Logout still clears the active and web-stored session.
  }
}
