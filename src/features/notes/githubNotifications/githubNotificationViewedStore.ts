const viewedStorageKey = "yonalist.notifications.viewedAt.v1";

export type GithubNotificationViewedAt = Readonly<Record<string, string>>;

export function loadGithubNotificationViewedAt(): GithubNotificationViewedAt {
  try {
    const stored = window.localStorage.getItem(viewedStorageKey);
    const parsed = stored ? (JSON.parse(stored) as unknown) : {};
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? Object.freeze({ ...(parsed as Record<string, string>) })
      : Object.freeze({});
  } catch {
    return Object.freeze({});
  }
}

export function recordGithubNotificationViewedAt(
  url: string,
  at = new Date(),
): GithubNotificationViewedAt {
  const current = loadGithubNotificationViewedAt();
  if (current[url]) return current;
  const next = Object.freeze({ ...current, [url]: at.toISOString() });
  try {
    window.localStorage.setItem(viewedStorageKey, JSON.stringify(next));
  } catch {
    // The current session can still use the returned timestamp.
  }
  return next;
}
