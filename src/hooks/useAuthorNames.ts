import { useContext, useEffect, useMemo, useState } from "react";
import { GithubConnectionContext } from "../GithubConnectionContext";
import type { ItemDocument } from "../domain/types";
import { fetchUserProfiles } from "../services/userProfiles";

/** The subset of a fetched user profile the item list consumes per author. */
export interface AuthorProfile {
  /** Display name, present only when it differs from the login. */
  name?: string;
  /** Profile avatar URL, when the profile carries one. */
  avatarUrl?: string;
}

const EMPTY_PROFILES: ReadonlyMap<string, AuthorProfile> = new Map();

export interface UseAuthorNamesOptions {
  /**
   * When false the hook never fetches and keeps returning the fallback (empty)
   * map. Callers pass `!demoMode && online` so demo/offline sessions resolve to
   * the raw login without a wasted network round-trip.
   */
  enabled?: boolean;
}

/**
 * Resolves the display name and avatar URL for the author logins of the given
 * items.
 *
 * The GitHub connection comes from {@link GithubConnectionContext}. Unique
 * author logins are batch-fetched through `fetchUserProfiles` (its own LRU +
 * in-flight dedup absorbs repeat lookups), and the result is a `login →
 * {@link AuthorProfile}` map that only contains logins whose profile actually
 * carries a distinct name or an avatar URL. Callers fall back to the login (and
 * render no avatar) for everything else, so the map is safe to consume before
 * (or without) any fetch.
 *
 * Fetching is skipped when disabled, when there is no signed-in token, or when
 * there are no author logins to resolve. State updates are guarded against a
 * late resolve after unmount.
 */
export function useAuthorNames(
  items: ItemDocument[],
  options: UseAuthorNamesOptions = {}
): ReadonlyMap<string, AuthorProfile> {
  const enabled = options.enabled ?? true;
  const connection = useContext(GithubConnectionContext);
  const [profiles, setProfiles] =
    useState<ReadonlyMap<string, AuthorProfile>>(EMPTY_PROFILES);

  const hasToken = connection.token.trim().length > 0;
  const logins = useMemo(() => {
    const unique = new Set<string>();
    for (const item of items) {
      const author = item.frontMatter.author;
      if (author && author !== "unknown") {
        unique.add(author);
      }
    }
    return Array.from(unique).sort();
  }, [items]);
  const loginsKey = logins.join("\n");

  useEffect(() => {
    if (!enabled || !hasToken || logins.length === 0) {
      return;
    }
    let cancelled = false;
    void fetchUserProfiles(connection, logins).then((fetched) => {
      if (cancelled) {
        return;
      }
      setProfiles((previous) => {
        let changed = false;
        const next = new Map(previous);
        for (const login of logins) {
          const name = fetched[login]?.name;
          const avatarUrl = fetched[login]?.avatarUrl;
          // Skip logins with neither a distinct name nor an avatar: callers
          // fall back to the raw login and render no avatar for those.
          if (!name && !avatarUrl) {
            continue;
          }
          const existing = next.get(login);
          if (existing?.name !== name || existing?.avatarUrl !== avatarUrl) {
            next.set(login, { name, avatarUrl });
            changed = true;
          }
        }
        return changed ? next : previous;
      });
    });
    return () => {
      cancelled = true;
    };
    // `connection` is read inside the effect; the primitive deps below capture
    // every field `fetchUserProfiles` relies on (base URL for the cache key,
    // token for auth) plus the set of logins being resolved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, hasToken, connection.apiBaseUrl, connection.token, loginsKey]);

  return profiles;
}
