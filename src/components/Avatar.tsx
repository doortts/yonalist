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
  showFallback = true
}: AvatarProps) {
  const connection = useContext(GithubConnectionContext);
  const vaultRoot = useContext(VaultRootContext);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const proxyAttempted = useRef(false);
  const requestSeq = useRef(0);
  const displayUrl =
    avatarUrl ?? inferredAvatarUrl(login, connection.webBaseUrl, size);

  useEffect(() => {
    const seq = ++requestSeq.current;
    proxyAttempted.current = false;
    setFailed(false);
    if (!displayUrl) {
      setSrc(null);
      return;
    }
    const cached = loadCachedAvatarImage(login, connection);
    if (cached) {
      setSrc(cached.dataUrl);
    } else if (!needsAuthenticatedFetch(displayUrl, connection)) {
      setSrc(displayUrl);
    } else {
      setSrc(null);
    }

    proxyAttempted.current = needsAuthenticatedFetch(displayUrl, connection);
    void loadCachedAvatarImageAsync(login, connection, vaultRoot).then(
      (asyncCached) => {
        if (requestSeq.current !== seq || !asyncCached) {
          return;
        }
        setSrc(asyncCached.dataUrl);
      }
    );
    void resolveAvatarImage(login, displayUrl, connection, vaultRoot).then((resolved) => {
      if (requestSeq.current !== seq) {
        return;
      }
      if (resolved) {
        setSrc(resolved);
      } else if (!cached && needsAuthenticatedFetch(displayUrl, connection)) {
        setFailed(true);
      }
    });
  }, [displayUrl, login, connection.webBaseUrl, connection.token, vaultRoot]);

  const style = { width: size, height: size };

  function handleError() {
    if (
      !displayUrl ||
      proxyAttempted.current ||
      !needsAuthenticatedFetch(displayUrl, connection)
    ) {
      setFailed(true);
      return;
    }

    proxyAttempted.current = true;
    const seq = ++requestSeq.current;
    setFailed(false);
    setSrc(null);
    void resolveAvatarImage(login, displayUrl, connection, vaultRoot).then((resolved) => {
      if (requestSeq.current !== seq) {
        return;
      }
      if (resolved) {
        setSrc(resolved);
      } else {
        setFailed(true);
      }
    });
  }

  if (src && !failed) {
    return (
      <img
        className="avatar avatar-image"
        style={style}
        src={src}
        alt={login}
        onError={handleError}
      />
    );
  }

  if (!showFallback) {
    return null;
  }

  return (
    <span className="avatar" style={style} aria-label={login}>
      {login.slice(0, 1).toUpperCase()}
    </span>
  );
}
