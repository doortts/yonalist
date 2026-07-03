import type { GithubConnection } from "../hooks/useGithubAuth";
import { isTauri } from "./oauth";

/**
 * GHE attachment images require authentication the webview's plain <img>
 * requests cannot provide. Images on the GitHub host are refetched with the
 * token — natively in Tauri (which also sidesteps CORS) — and swapped in as
 * data URLs.
 */

const resolvedCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

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
  const response = await fetch(src, {
    headers: { Authorization: `Bearer ${connection.token}` }
  });
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

/** Resolves an attachment URL to a data URL, caching per session. */
export function resolveAuthenticatedImage(
  src: string,
  connection: GithubConnection
): Promise<string | null> {
  const cached = resolvedCache.get(src);
  if (cached) {
    return Promise.resolve(cached);
  }
  const running = inflight.get(src);
  if (running) {
    return running;
  }
  const request = fetchAsDataUrl(src, connection)
    .then((dataUrl) => {
      if (dataUrl) {
        resolvedCache.set(src, dataUrl);
      }
      return dataUrl;
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(src);
    });
  inflight.set(src, request);
  return request;
}
