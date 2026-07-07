import { useContext, useEffect, useRef, useState } from "react";
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
  const [failed, setFailed] = useState<{ key: string; value: boolean } | null>(
    null
  );
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
    setFailed(null);
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
    void resolveAvatarImage(login, displayUrl, connection, vaultRoot).then((resolved) => {
      if (requestSeq.current !== seq) {
        return;
      }
      if (resolved) {
        setResolved({ key: avatarKey, src: resolved });
      } else if (!cached && needsAuthenticatedFetch(displayUrl, connection)) {
        setFailed({ key: avatarKey, value: true });
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
  const visibleFailed = failed?.key === avatarKey ? failed.value : false;

  function handleError() {
    if (
      !displayUrl ||
      proxyAttempted.current ||
      !needsAuthenticatedFetch(displayUrl, connection)
    ) {
      setFailed({ key: avatarKey, value: true });
      return;
    }

    proxyAttempted.current = true;
    const seq = ++requestSeq.current;
    setFailed(null);
    setResolved(null);
    void resolveAvatarImage(login, displayUrl, connection, vaultRoot).then((resolved) => {
      if (requestSeq.current !== seq) {
        return;
      }
      if (resolved) {
        setResolved({ key: avatarKey, src: resolved });
      } else {
        setFailed({ key: avatarKey, value: true });
      }
    });
  }

  if (visibleSrc && !visibleFailed) {
    return (
      <img
        className="avatar avatar-image"
        style={style}
        src={visibleSrc}
        alt={login}
        onError={handleError}
      />
    );
  }

  if (!showFallback) {
    if ((displayUrl || loading) && !visibleFailed) {
      return (
        <span
          className="avatar-skeleton"
          style={style}
          aria-label={`Loading avatar for ${login}`}
        />
      );
    }
    return null;
  }

  return (
    <span className="avatar" style={style} aria-label={login}>
      {login.slice(0, 1).toUpperCase()}
    </span>
  );
}
