import type { GithubConnection } from "../hooks/useGithubAuth";
import { LruCache } from "./lruCache";
import { isTauri } from "./oauth";

/**
 * GHE attachment images require authentication the webview's plain <img>
 * requests cannot provide. Images on the GitHub host are refetched with the
 * token — natively in Tauri (which also sidesteps CORS) — and swapped in as
 * data URLs.
 */

// Bounded: data URLs are large (whole images in memory), so cap the session
// cache instead of letting a long-running window grow without limit.
const resolvedCache = new LruCache<string>(200);
const inflight = new Map<string, Promise<string | null>>();
// Stores the failure timestamp (not a permanent flag) so a transient 429 or
// network blip only suppresses one attachment for a few minutes, not the whole
// session.
const failedCache = new LruCache<number>(500);
const avatarInflight = new Map<string, Promise<string | null>>();
const avatarStorageKey = "yonalist.avatarImages.v1";
const AVATAR_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
// Retry a failed authenticated image once this elapses so transient failures recover.
const FAILED_IMAGE_RETRY_INTERVAL_MS = 5 * 60 * 1000;
const MAX_STORED_AVATARS = 200;

export interface CachedAvatarImage {
  src: string;
  dataUrl: string;
  hash: string;
  checkedAt: string;
  updatedAt: string;
}

type AvatarCache = Record<string, CachedAvatarImage>;

interface NativeCachedAvatarImage {
  src: string;
  data_url: string;
  hash: string;
  checked_at: string;
  updated_at: string;
}

export function clearImageProxyCache() {
  resolvedCache.clear();
  inflight.clear();
  failedCache.clear();
  avatarInflight.clear();
}

function cacheKey(src: string, connection: GithubConnection): string {
  return `${connection.apiBaseUrl}\n${connection.token}\n${src}`;
}

function hostKey(connection: GithubConnection): string {
  try {
    return new URL(connection.webBaseUrl).host.toLowerCase();
  } catch {
    return connection.webBaseUrl.trim().toLowerCase();
  }
}

function avatarCacheKey(login: string, connection: GithubConnection): string {
  return `${hostKey(connection)}\n${login.trim().toLowerCase()}`;
}

function avatarInflightKey(
  login: string,
  connection: GithubConnection,
  vaultRoot = "",
  src = ""
): string {
  return `${avatarCacheKey(login, connection)}\n${vaultRoot}\n${src}`;
}

function toCachedAvatarImage(
  value: NativeCachedAvatarImage
): CachedAvatarImage {
  return {
    src: value.src,
    dataUrl: value.data_url,
    hash: value.hash,
    checkedAt: value.checked_at,
    updatedAt: value.updated_at
  };
}

function readAvatarCache(): AvatarCache {
  try {
    const raw = window.localStorage.getItem(avatarStorageKey);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as AvatarCache) : {};
  } catch {
    return {};
  }
}

function writeAvatarCache(cache: AvatarCache) {
  try {
    const entries = Object.entries(cache)
      .sort(
        ([, left], [, right]) =>
          Date.parse(right.checkedAt) - Date.parse(left.checkedAt)
      )
      .slice(0, MAX_STORED_AVATARS);
    window.localStorage.setItem(
      avatarStorageKey,
      JSON.stringify(Object.fromEntries(entries))
    );
  } catch {
    // Avatars still render with the in-memory/session cache or direct URL.
  }
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isFresh(entry: CachedAvatarImage, now = new Date()): boolean {
  const checkedAt = Date.parse(entry.checkedAt);
  return Number.isFinite(checkedAt)
    ? now.valueOf() - checkedAt < AVATAR_REFRESH_INTERVAL_MS
    : false;
}

/** Only images on the signed-in GitHub host get the token attached. */
export function needsAuthenticatedFetch(
  src: string,
  connection: GithubConnection
): boolean {
  if (!connection.token.trim()) {
    return false;
  }
  try {
    const source = new URL(src);
    if (source.protocol !== "https:" && source.protocol !== "http:") {
      return false;
    }
    const host = new URL(connection.webBaseUrl).host;
    return source.host === host || source.host.endsWith(`.${host}`);
  } catch {
    return false;
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

async function fetchAsDataUrl(
  src: string,
  connection: GithubConnection
): Promise<string | null> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("fetch_image", {
      url: src,
      token: connection.token || null
    });
  }

  // Web preview fallback; may still be blocked by CORS on some hosts.
  const token = connection.token.trim();
  const authHeaders = [`Bearer ${token}`, `token ${token}`];
  for (const authHeader of authHeaders) {
    const response = await fetch(src, {
      headers: { Authorization: authHeader }
    });
    if (!response.ok) {
      continue;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      continue;
    }
    const base64 = arrayBufferToBase64(await response.arrayBuffer());
    return `data:${contentType};base64,${base64}`;
  }
  return null;
}

async function fetchAvatarAsDataUrl(
  src: string,
  connection: GithubConnection
): Promise<string | null> {
  if (needsAuthenticatedFetch(src, connection)) {
    return fetchAsDataUrl(src, connection);
  }
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("fetch_image", {
      url: src,
      token: null
    });
  }

  const response = await fetch(src);
  if (!response.ok) {
    return null;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    return null;
  }
  const base64 = arrayBufferToBase64(await response.arrayBuffer());
  return `data:${contentType};base64,${base64}`;
}

/**
 * Records a failed lookup so we stop retrying for a few minutes — but never
 * while offline, where the failure says nothing about the image itself.
 */
function recordImageFailure(key: string) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return;
  }
  failedCache.set(key, Date.now());
}

/** Resolves an attachment URL to a data URL, caching per session. */
export function resolveAuthenticatedImage(
  src: string,
  connection: GithubConnection
): Promise<string | null> {
  const key = cacheKey(src, connection);
  const cached = resolvedCache.get(key);
  if (cached) {
    return Promise.resolve(cached);
  }
  const failedAt = failedCache.get(key);
  if (failedAt !== undefined) {
    if (Date.now() - failedAt < FAILED_IMAGE_RETRY_INTERVAL_MS) {
      return Promise.resolve(null);
    }
    failedCache.delete(key);
  }
  const running = inflight.get(key);
  if (running) {
    return running;
  }
  const request = fetchAsDataUrl(src, connection)
    .then((dataUrl) => {
      if (dataUrl) {
        resolvedCache.set(key, dataUrl);
      } else {
        recordImageFailure(key);
      }
      return dataUrl;
    })
    .catch(() => {
      recordImageFailure(key);
      return null;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

export function loadCachedAvatarImage(
  login: string,
  connection: GithubConnection
): CachedAvatarImage | null {
  const key = avatarCacheKey(login, connection);
  return readAvatarCache()[key] ?? null;
}

export async function loadCachedAvatarImageAsync(
  login: string,
  connection: GithubConnection,
  vaultRoot = ""
): Promise<CachedAvatarImage | null> {
  if (isTauri() && vaultRoot.trim()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const cached = await invoke<NativeCachedAvatarImage | null>(
      "load_cached_avatar_image",
      {
        vaultPath: vaultRoot,
        host: hostKey(connection),
        login
      }
    );
    return cached ? toCachedAvatarImage(cached) : null;
  }
  return loadCachedAvatarImage(login, connection);
}

export function persistCachedAvatarImage(
  login: string,
  connection: GithubConnection,
  src: string,
  input: {
    dataUrl: string;
    checkedAt?: Date;
    updatedAt?: Date;
  }
) {
  const now = input.checkedAt ?? new Date();
  const cache = readAvatarCache();
  cache[avatarCacheKey(login, connection)] = {
    src,
    dataUrl: input.dataUrl,
    hash: hashString(input.dataUrl),
    checkedAt: now.toISOString(),
    updatedAt: (input.updatedAt ?? now).toISOString()
  };
  writeAvatarCache(cache);
}

async function persistCachedAvatarImageAsync(
  login: string,
  connection: GithubConnection,
  vaultRoot: string,
  src: string,
  input: {
    dataUrl: string;
    checkedAt?: Date;
    updatedAt?: Date;
  }
): Promise<CachedAvatarImage> {
  const now = input.checkedAt ?? new Date();
  const updatedAt = input.updatedAt ?? now;
  const hash = hashString(input.dataUrl);
  if (isTauri() && vaultRoot.trim()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const stored = await invoke<NativeCachedAvatarImage>(
      "store_cached_avatar_image",
      {
        vaultPath: vaultRoot,
        host: hostKey(connection),
        login,
        src,
        dataUrl: input.dataUrl,
        hash,
        checkedAt: now.toISOString(),
        updatedAt: updatedAt.toISOString()
      }
    );
    return toCachedAvatarImage(stored);
  }

  persistCachedAvatarImage(login, connection, src, {
    dataUrl: input.dataUrl,
    checkedAt: now,
    updatedAt
  });
  return {
    src,
    dataUrl: input.dataUrl,
    hash,
    checkedAt: now.toISOString(),
    updatedAt: updatedAt.toISOString()
  };
}

async function touchCachedAvatarImage(
  login: string,
  connection: GithubConnection,
  vaultRoot: string,
  src: string,
  cached: CachedAvatarImage,
  checkedAt: Date
): Promise<CachedAvatarImage> {
  const next = {
    ...cached,
    src,
    checkedAt: checkedAt.toISOString()
  };
  if (isTauri() && vaultRoot.trim()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("touch_cached_avatar_image", {
      vaultPath: vaultRoot,
      host: hostKey(connection),
      login,
      src,
      checkedAt: next.checkedAt
    });
    return next;
  }

  const cache = readAvatarCache();
  cache[avatarCacheKey(login, connection)] = next;
  writeAvatarCache(cache);
  return next;
}

export function shouldRefreshAvatarImage(
  login: string,
  src: string,
  connection: GithubConnection,
  now = new Date()
): boolean {
  const cached = loadCachedAvatarImage(login, connection);
  return !cached || cached.src !== src || !isFresh(cached, now);
}

export function resolveAvatarImage(
  login: string,
  src: string,
  connection: GithubConnection,
  vaultRoot = ""
): Promise<string | null> {
  const key = avatarInflightKey(login, connection, vaultRoot, src);
  const running = avatarInflight.get(key);
  if (running) {
    return running;
  }

  const request = loadCachedAvatarImageAsync(login, connection, vaultRoot)
    .then((cached) => {
      if (cached && cached.src === src && isFresh(cached)) {
        return cached.dataUrl;
      }
      return fetchAvatarAsDataUrl(src, connection)
        .then(async (dataUrl) => {
          const current =
            (await loadCachedAvatarImageAsync(login, connection, vaultRoot)) ??
            cached;
          const now = new Date();
          if (!dataUrl) {
            if (current) {
              const touched = await touchCachedAvatarImage(
                login,
                connection,
                vaultRoot,
                src,
                current,
                now
              );
              return touched.dataUrl;
            }
            return null;
          }

          const nextHash = hashString(dataUrl);
          if (current && current.hash === nextHash) {
            const touched = await touchCachedAvatarImage(
              login,
              connection,
              vaultRoot,
              src,
              current,
              now
            );
            return touched.dataUrl;
          }

          const stored = await persistCachedAvatarImageAsync(
            login,
            connection,
            vaultRoot,
            src,
            { dataUrl, checkedAt: now, updatedAt: now }
          );
          return stored.dataUrl;
        })
        .catch(() => cached?.dataUrl ?? null);
    })
    .catch(() => null)
    .finally(() => {
      avatarInflight.delete(key);
    });
  avatarInflight.set(key, request);
  return request;
}
