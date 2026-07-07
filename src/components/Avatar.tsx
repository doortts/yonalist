import { useContext, useEffect, useRef, useState } from "react";
import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import { GithubConnectionContext } from "../GithubConnectionContext";
import { VaultRootContext } from "../VaultRootContext";
import {
  loadCachedAvatarImage,
  loadCachedAvatarImageAsync,
  needsAuthenticatedFetch,
  resolveAvatarImage
} from "../services/imageProxy";

interface AvatarProps {
  login: string;
  avatarUrl?: string;
  size?: number;
  /** When false, render nothing (instead of the initial) if no image loads. */
  showFallback?: boolean;
  loading?: boolean;
}

function inferredAvatarUrl(
  login: string,
  webBaseUrl: string,
  size: number
): string | null {
  const normalizedLogin = login.trim();
  if (
    !normalizedLogin ||
    normalizedLogin === "unknown" ||
    !webBaseUrl.trim()
  ) {
    return null;
  }

  try {
    const url = new URL(`${encodeURIComponent(normalizedLogin)}.png`, webBaseUrl);
    url.searchParams.set("size", String(size * 2));
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Circular user avatar. Uses the real GitHub avatar image when available,
 * fetching through the auth proxy for GHE hosts, and falls back to the
 * login's initial when there's no image or it fails to load.
 *
 * Structure is Base UI's Avatar (`Avatar.Root`/`Avatar.Image`/`Avatar.Fallback`):
 * once we hand a resolved `src` (a data URL for authenticated hosts, or a
 * verified direct URL) to `Avatar.Image`, Base UI's declarative load-status
 * machine owns the loaded → image / error → fallback swap, replacing what used
 * to be a manual `failed` `useState`. The `Root` wrapper is laid out with
 * `display: contents` so it adds no box: the visible element remains a single
 * `.avatar-image` `<img>` or `.avatar` `<span>`, exactly as before.
 */
export function Avatar({
  login,
  avatarUrl,
  size = 36,
  showFallback = true,
  loading = false
}: AvatarProps) {
  const connection = useContext(GithubConnectionContext);
  const vaultRoot = useContext(VaultRootContext);
  const [resolved, setResolved] = useState<{
    key: string;
    src: string;
  } | null>(null);
  // Only used by the showFallback=false branch to choose between the loading
  // skeleton and rendering nothing once Base UI reports the image errored.
  const [errored, setErrored] = useState<{ key: string } | null>(null);
  const proxyAttempted = useRef(false);
  const requestSeq = useRef(0);
  const displayUrl =
    avatarUrl ?? inferredAvatarUrl(login, connection.webBaseUrl, size);
  const avatarKey = [
    connection.webBaseUrl,
    connection.apiBaseUrl,
    login.trim().toLowerCase(),
    displayUrl ?? ""
  ].join("\n");

  useEffect(() => {
    const seq = ++requestSeq.current;
    proxyAttempted.current = false;
    setErrored(null);
    if (!displayUrl) {
      setResolved(null);
      return;
    }
    const cached = loadCachedAvatarImage(login, connection);
    if (cached?.src === displayUrl) {
      setResolved({ key: avatarKey, src: cached.dataUrl });
    } else if (!needsAuthenticatedFetch(displayUrl, connection)) {
      setResolved({ key: avatarKey, src: displayUrl });
    } else {
      setResolved(null);
    }

    proxyAttempted.current = needsAuthenticatedFetch(displayUrl, connection);
    void loadCachedAvatarImageAsync(login, connection, vaultRoot).then(
      (asyncCached) => {
        if (
          requestSeq.current !== seq ||
          !asyncCached ||
          asyncCached.src !== displayUrl
        ) {
          return;
        }
        setResolved({ key: avatarKey, src: asyncCached.dataUrl });
      }
    );
    void resolveAvatarImage(login, displayUrl, connection, vaultRoot).then((resolvedSrc) => {
      if (requestSeq.current !== seq) {
        return;
      }
      if (resolvedSrc) {
        setResolved({ key: avatarKey, src: resolvedSrc });
      } else if (!cached && needsAuthenticatedFetch(displayUrl, connection)) {
        // Auth-only image confirmed unavailable and nothing was cached: mark it
        // errored so the showFallback=false branch stops showing the skeleton.
        // (showFallback=true still shows Base UI's Fallback initial as before.)
        setErrored({ key: avatarKey });
      }
    });
  }, [
    avatarKey,
    displayUrl,
    login,
    connection.apiBaseUrl,
    connection.webBaseUrl,
    connection.token,
    vaultRoot
  ]);

  const style = { width: size, height: size };
  const visibleSrc = resolved?.key === avatarKey ? resolved.src : null;

  // Base UI reports 'error' when the resolved src fails to load. Authenticated
  // hosts serve their image through the proxy as a data URL (which won't error
  // here); a direct/inferred URL that GHE gates behind auth can still fail, so
  // retry once through the proxy before letting the fallback stand.
  function handleLoadingStatusChange(status: "idle" | "loading" | "loaded" | "error") {
    // `errored` only drives the showFallback=false skeleton→nothing swap; the
    // showFallback=true path lets Base UI's own Fallback handle the error state.
    if (!showFallback) {
      if (status === "error" && errored?.key !== avatarKey) {
        setErrored({ key: avatarKey });
      } else if (status === "loaded" && errored) {
        setErrored(null);
      }
    }

    if (status !== "error") {
      return;
    }
    if (
      !displayUrl ||
      proxyAttempted.current ||
      !needsAuthenticatedFetch(displayUrl, connection)
    ) {
      return;
    }

    proxyAttempted.current = true;
    const seq = ++requestSeq.current;
    setResolved(null);
    void resolveAvatarImage(login, displayUrl, connection, vaultRoot).then((resolvedSrc) => {
      if (requestSeq.current !== seq) {
        return;
      }
      if (resolvedSrc) {
        setResolved({ key: avatarKey, src: resolvedSrc });
      }
    });
  }

  // Base UI's Avatar has no "loading skeleton" or "render nothing" state: its
  // Fallback is always the initial. When callers opt out of the initial
  // (showFallback=false) we still route the image through Base UI (so its
  // load-status machine drives the swap), but suppress its Fallback and pick
  // the skeleton (still resolving) or nothing (resolved but failed) ourselves.
  if (!showFallback) {
    const failed = errored?.key === avatarKey;
    // Resolved-but-failed: render nothing (never the initial).
    if (failed) {
      return null;
    }
    if (!visibleSrc) {
      // Still resolving (or explicitly loading): show the skeleton, else nothing.
      return displayUrl || loading ? (
        <span
          className="avatar-skeleton"
          style={style}
          aria-label={`Loading avatar for ${login}`}
        />
      ) : null;
    }
    return (
      <BaseAvatar.Root style={{ display: "contents" }} data-avatar-key={avatarKey}>
        <BaseAvatar.Image
          className="avatar avatar-image"
          style={style}
          src={visibleSrc}
          alt={login}
          onLoadingStatusChange={handleLoadingStatusChange}
        />
        {/* Base UI shows this only while its load-status machine is not
            'loaded'; on error we've already returned null above. */}
        <BaseAvatar.Fallback
          className="avatar-skeleton"
          style={style}
          aria-label={`Loading avatar for ${login}`}
        />
      </BaseAvatar.Root>
    );
  }

  return (
    <BaseAvatar.Root style={{ display: "contents" }} data-avatar-key={avatarKey}>
      <BaseAvatar.Image
        className="avatar avatar-image"
        style={style}
        src={visibleSrc ?? undefined}
        alt={login}
        onLoadingStatusChange={handleLoadingStatusChange}
      />
      <BaseAvatar.Fallback className="avatar" style={style} aria-label={login}>
        {login.slice(0, 1).toUpperCase()}
      </BaseAvatar.Fallback>
    </BaseAvatar.Root>
  );
}
