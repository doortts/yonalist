import {
  createGitHubTransport,
  encodePathSegment,
  type GitHubTransportOptions
} from "./githubTransport";
import { LruCache } from "./lruCache";

export interface UserProfile {
  login: string;
  name?: string;
  avatarUrl?: string;
}

interface UserProfileResponse {
  login?: string;
  name?: string | null;
  avatar_url?: string;
}

const profileCache = new LruCache<UserProfile>(250);
const inflightProfiles = new Map<string, Promise<UserProfile | null>>();

function profileCacheKey(options: GitHubTransportOptions, login: string): string {
  return `${options.apiBaseUrl}|${login}`;
}

function normalizeName(name: string | null | undefined, login: string): string | undefined {
  const trimmed = name?.trim();
  return trimmed && trimmed !== login ? trimmed : undefined;
}

export function clearUserProfileCache() {
  profileCache.clear();
  inflightProfiles.clear();
}

export async function fetchUserProfile(
  options: GitHubTransportOptions,
  login: string
): Promise<UserProfile | null> {
  if (!login || login === "unknown") {
    return null;
  }

  const key = profileCacheKey(options, login);
  const cached = profileCache.get(key);
  if (cached) {
    return cached;
  }

  const running = inflightProfiles.get(key);
  if (running) {
    return running;
  }

  const request = createGitHubTransport(options)
    .requestJson<UserProfileResponse>(`/users/${encodePathSegment(login)}`)
    .then((user) => {
      const profile: UserProfile = {
        login: user.login ?? login,
        name: normalizeName(user.name, user.login ?? login),
        avatarUrl: user.avatar_url
      };
      profileCache.set(key, profile);
      return profile;
    })
    .catch(() => null)
    .finally(() => {
      inflightProfiles.delete(key);
    });
  inflightProfiles.set(key, request);
  return request;
}

export async function fetchUserProfiles(
  options: GitHubTransportOptions,
  logins: Iterable<string | undefined>
): Promise<Record<string, UserProfile>> {
  const uniqueLogins = Array.from(
    new Set(
      Array.from(logins).filter(
        (login): login is string => Boolean(login && login !== "unknown")
      )
    )
  );
  const profiles = await Promise.all(
    uniqueLogins.map(async (login) => [login, await fetchUserProfile(options, login)] as const)
  );
  return Object.fromEntries(
    profiles.flatMap(([login, profile]) => (profile ? [[login, profile]] : []))
  );
}

export function displayNameForLogin(
  profiles: Record<string, UserProfile>,
  login: string | undefined
): string | undefined {
  return login ? profiles[login]?.name : undefined;
}
