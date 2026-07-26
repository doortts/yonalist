import { defaultGithubApiBaseUrls } from "../githubAuthConfig";
import { clearImageProxyCache } from "./imageProxy";
import { clearNotificationCache } from "./notifications";
import { clearSessionToken } from "./sessionTokens";

const sessionTokensKey = "yonalist.github.sessionTokens.v1";
const personalTokensKey = "yonalist.github.personalTokens.v1";
const customUrlsKey = "yonalist.github.customUrls.v1";
const selectedUrlKey = "yonalist.github.apiBaseUrl.v1";

export interface ResetApplicationDataOptions {
  serverUrls?: string[];
  onStep?: (event: ResetApplicationProgressEvent) => void;
}

export type ResetApplicationStepId =
  | "session-tokens"
  | "runtime-caches"
  | "local-storage";

export interface ResetApplicationProgressEvent {
  id: ResetApplicationStepId;
  status: "running" | "complete";
}

function readJsonObject(key: string): Record<string, unknown> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readJsonStringList(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function knownServerUrls(serverUrls: string[] = []): string[] {
  const urls = new Set<string>([
    ...defaultGithubApiBaseUrls,
    ...serverUrls,
    ...Object.keys(readJsonObject(sessionTokensKey)),
    ...Object.keys(readJsonObject(personalTokensKey)),
    ...readJsonStringList(customUrlsKey)
  ]);
  try {
    const selected = window.localStorage.getItem(selectedUrlKey);
    if (selected) {
      urls.add(selected);
    }
  } catch {
    // Ignore storage failures; reset is best-effort.
  }
  return [...urls].filter(Boolean);
}

function resetLocalStorage() {
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith("yonalist.")) {
      keys.push(key);
    }
  }
  for (const key of keys) {
    window.localStorage.removeItem(key);
  }
}

async function runResetStep(
  id: ResetApplicationStepId,
  onStep: ResetApplicationDataOptions["onStep"],
  operation: () => void | Promise<void>
) {
  onStep?.({ id, status: "running" });
  await operation();
  onStep?.({ id, status: "complete" });
}

export async function resetApplicationData({
  serverUrls = [],
  onStep
}: ResetApplicationDataOptions = {}): Promise<void> {
  const urls = knownServerUrls(serverUrls);
  await runResetStep("session-tokens", onStep, async () => {
    await Promise.all(urls.map((url) => clearSessionToken(url)));
  });

  await runResetStep("runtime-caches", onStep, () => {
    clearNotificationCache();
    clearImageProxyCache();
  });

  await runResetStep("local-storage", onStep, () => {
    resetLocalStorage();
  });
}
