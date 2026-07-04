import { useContext, useEffect, useState } from "react";
import { GithubConnectionContext } from "../GithubConnectionContext";
import {
  needsAuthenticatedFetch,
  resolveAuthenticatedImage
} from "../services/imageProxy";

interface AvatarProps {
  login: string;
  avatarUrl?: string;
  size?: number;
  /** When false, render nothing (instead of the initial) if no image loads. */
  showFallback?: boolean;
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
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (!avatarUrl) {
      setSrc(null);
      return;
    }
    if (!needsAuthenticatedFetch(avatarUrl, connection)) {
      setSrc(avatarUrl);
      return;
    }
    let cancelled = false;
    setSrc(null);
    void resolveAuthenticatedImage(avatarUrl, connection).then((resolved) => {
      if (!cancelled) {
        setSrc(resolved);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [avatarUrl, connection]);

  const style = { width: size, height: size };

  if (src && !failed) {
    return (
      <img
        className="avatar avatar-image"
        style={style}
        src={src}
        alt={login}
        onError={() => setFailed(true)}
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
