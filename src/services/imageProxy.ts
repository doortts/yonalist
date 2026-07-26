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
// Retry a failed authenticated image once this elapses so transient failures recover.
const FAILED_IMAGE_RETRY_INTERVAL_MS = 5 * 60 * 1000;

export function clearImageProxyCache() {
  resolvedCache.clear();
  inflight.clear();
  failedCache.clear();
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
  const key = `${connection.apiBaseUrl}\n${connection.token}\n${src}`;
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
