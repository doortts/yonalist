import {
  defaultGithubApiBaseAliases,
  defaultGithubApiBaseUrls
} from "../githubAuthConfig";

/**
 * GitHub API base URL configuration, mirrored from the Flutter client's
 * GithubConfig: built-in defaults plus user-added URLs, per-URL aliases and
 * personal access tokens, hidden defaults, and a reset-to-defaults action.
 */

const selectedKey = "yonalist.github.apiBaseUrl.v1";
const customListKey = "yonalist.github.customUrls.v1";
const hiddenDefaultsKey = "yonalist.github.hiddenDefaults.v1";
const aliasesKey = "yonalist.github.aliases.v1";
const aliasesSeededKey = "yonalist.github.aliasesSeeded.v1";
const personalTokensKey = "yonalist.github.personalTokens.v1";
const legacySettingsKey = "yonalist.settings.v1";

export interface GithubServersState {
  selectedUrl: string;
  customUrls: string[];
  hiddenDefaults: string[];
  aliases: Record<string, string>;
  personalTokens: Record<string, string>;
}

export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Derives the host URL from an API base URL by stripping `/api/vN`. */
export function deriveHostUrl(apiBaseUrl: string): string {
  const stripped = apiBaseUrl.replace(/\/api\/v\d+\/?$/, "");
  if (stripped && stripped !== apiBaseUrl) {
    return stripped;
  }
  try {
    const url = new URL(apiBaseUrl);
    if (url.host === "api.github.com") {
      return `${url.protocol}//github.com`;
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return apiBaseUrl;
  }
}

function readString(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeString(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Server settings still work in memory without persistence.
  }
}

function decodeStringList(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const decoded = JSON.parse(raw);
    return Array.isArray(decoded)
      ? decoded
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function decodeStringMap(raw: string | null): Record<string, string> {
  if (!raw) {
    return {};
  }
  try {
    const decoded = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(decoded)) {
      if (typeof value === "string" && key.trim() && value.trim()) {
        out[key.trim()] = value.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function visibleDefaults(state: GithubServersState): string[] {
  return defaultGithubApiBaseUrls.filter(
    (url) => !state.hiddenDefaults.includes(url)
  );
}

/** All selectable URLs = visible defaults + user-added, deduplicated. */
export function availableUrls(state: GithubServersState): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const url of [...visibleDefaults(state), ...state.customUrls]) {
    if (!seen.has(url)) {
      seen.add(url);
      result.push(url);
    }
  }
  return result;
}

export function isDefaultUrl(url: string): boolean {
  return defaultGithubApiBaseUrls.includes(url);
}

export function aliasFor(state: GithubServersState, url: string): string | null {
  const alias = state.aliases[normalizeUrl(url)];
  return alias ? alias : null;
}

/** Display label — "alias — url" when an alias exists, plain url otherwise. */
export function displayLabel(state: GithubServersState, url: string): string {
  const alias = aliasFor(state, url);
  return alias ? `${alias} — ${url}` : url;
}

export function personalTokenFor(
  state: GithubServersState,
  url: string
): string | null {
  const token = state.personalTokens[normalizeUrl(url)];
  return token ? token : null;
}

export function usesPersonalToken(state: GithubServersState, url: string): boolean {
  return personalTokenFor(state, url) !== null;
}

/** Migrates the single personalAccessToken from the pre-server settings. */
function migrateLegacyToken(state: GithubServersState): GithubServersState {
  const raw = readString(legacySettingsKey);
  if (!raw || Object.keys(state.personalTokens).length > 0) {
    return state;
  }
  try {
    const legacy = JSON.parse(raw) as {
      personalAccessToken?: string;
      apiBaseUrl?: string;
    };
    const token = legacy.personalAccessToken?.trim();
    if (!token) {
      return state;
    }
    const url = normalizeUrl(legacy.apiBaseUrl || "https://api.github.com");
    const next: GithubServersState = {
      ...state,
      selectedUrl: url,
      customUrls:
        isDefaultUrl(url) || state.customUrls.includes(url)
          ? state.customUrls
          : [...state.customUrls, url],
      personalTokens: { [url]: token }
    };
    persistServersState(next);
    return next;
  } catch {
    return state;
  }
}

export function loadServersState(): GithubServersState {
  const customUrls = decodeStringList(readString(customListKey));
  const hiddenDefaults = decodeStringList(readString(hiddenDefaultsKey));
  let aliases = decodeStringMap(readString(aliasesKey));

  const seeded = readString(aliasesSeededKey) === "true";
  if (!seeded) {
    for (const [url, alias] of Object.entries(defaultGithubApiBaseAliases)) {
      const key = normalizeUrl(url);
      if (!aliases[key]) {
        aliases = { ...aliases, [key]: alias };
      }
    }
    writeString(aliasesKey, JSON.stringify(aliases));
    writeString(aliasesSeededKey, "true");
  }

  const personalTokens = decodeStringMap(readString(personalTokensKey));

  const base: GithubServersState = {
    selectedUrl: defaultGithubApiBaseUrls[0],
    customUrls,
    hiddenDefaults,
    aliases,
    personalTokens
  };

  const stored = readString(selectedKey);
  const candidates = availableUrls(base);
  const fallback = candidates[0] ?? defaultGithubApiBaseUrls[0];
  base.selectedUrl = stored && candidates.includes(stored) ? stored : fallback;

  return migrateLegacyToken(base);
}

export function persistServersState(state: GithubServersState) {
  writeString(selectedKey, state.selectedUrl);
  writeString(customListKey, JSON.stringify(state.customUrls));
  writeString(hiddenDefaultsKey, JSON.stringify(state.hiddenDefaults));
  writeString(aliasesKey, JSON.stringify(state.aliases));
  writeString(personalTokensKey, JSON.stringify(state.personalTokens));
}

/**
 * Selects a URL; unknown URLs are auto-registered as custom entries and a
 * previously hidden default is restored, mirroring GithubConfig.save().
 */
export function selectUrl(
  state: GithubServersState,
  url: string
): GithubServersState {
  const normalized = normalizeUrl(url);
  let next: GithubServersState = { ...state, selectedUrl: normalized };
  if (next.hiddenDefaults.includes(normalized)) {
    next = {
      ...next,
      hiddenDefaults: next.hiddenDefaults.filter((entry) => entry !== normalized)
    };
  }
  if (!availableUrls(next).includes(normalized) && !isDefaultUrl(normalized)) {
    next = { ...next, customUrls: [...next.customUrls, normalized] };
  }
  return next;
}

export function upsertServer(
  state: GithubServersState,
  input: { url: string; alias?: string; personalToken?: string }
): GithubServersState {
  const normalized = normalizeUrl(input.url);
  let next: GithubServersState = { ...state };

  if (!availableUrls(next).includes(normalized) && !isDefaultUrl(normalized)) {
    next = { ...next, customUrls: [...next.customUrls, normalized] };
  }
  if (next.hiddenDefaults.includes(normalized)) {
    next = {
      ...next,
      hiddenDefaults: next.hiddenDefaults.filter((entry) => entry !== normalized)
    };
  }

  if (input.alias !== undefined) {
    const alias = input.alias.trim();
    const aliases = { ...next.aliases };
    if (alias) {
      aliases[normalized] = alias;
    } else {
      delete aliases[normalized];
    }
    next = { ...next, aliases };
  }

  if (input.personalToken !== undefined) {
    const token = input.personalToken.trim();
    const personalTokens = { ...next.personalTokens };
    if (token) {
      personalTokens[normalized] = token;
    } else {
      delete personalTokens[normalized];
    }
    next = { ...next, personalTokens };
  }

  return next;
}

/**
 * Removes a URL: custom entries are deleted (with alias/token), defaults are
 * hidden. Removing the selected URL falls back to the first available one.
 */
export function removeUrl(
  state: GithubServersState,
  url: string
): GithubServersState {
  const normalized = normalizeUrl(url);
  let next: GithubServersState = { ...state };

  if (isDefaultUrl(normalized)) {
    next = {
      ...next,
      hiddenDefaults: [...new Set([...next.hiddenDefaults, normalized])]
    };
  } else {
    next = {
      ...next,
      customUrls: next.customUrls.filter((entry) => entry !== normalized)
    };
  }

  const aliases = { ...next.aliases };
  delete aliases[normalized];
  const personalTokens = { ...next.personalTokens };
  delete personalTokens[normalized];
  next = { ...next, aliases, personalTokens };

  if (next.selectedUrl === normalized) {
    const candidates = availableUrls(next);
    next = {
      ...next,
      selectedUrl: candidates[0] ?? defaultGithubApiBaseUrls[0]
    };
  }

  return next;
}

/** Restores defaults: selection, custom list, hidden defaults, tokens, aliases. */
export function resetServers(): GithubServersState {
  const state: GithubServersState = {
    selectedUrl: defaultGithubApiBaseUrls[0],
    customUrls: [],
    hiddenDefaults: [],
    aliases: Object.fromEntries(
      Object.entries(defaultGithubApiBaseAliases).map(([url, alias]) => [
        normalizeUrl(url),
        alias
      ])
    ),
    personalTokens: {}
  };
  writeString(aliasesSeededKey, "true");
  return state;
}
