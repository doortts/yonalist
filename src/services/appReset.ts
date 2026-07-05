import { defaultGithubApiBaseUrls } from "../githubAuthConfig";
import { clearImageProxyCache } from "./imageProxy";
import { clearItemThreadCache } from "./itemThread";
import { clearNotificationDetailCache } from "./notificationDetail";
import { clearNotificationCache } from "./notifications";
import { isTauri } from "./oauth";
import { clearSessionToken } from "./sessionTokens";

const vaultDocumentsKey = "yonalist.vaultDocuments.v1";
const sessionTokensKey = "yonalist.github.sessionTokens.v1";
const personalTokensKey = "yonalist.github.personalTokens.v1";
const customUrlsKey = "yonalist.github.customUrls.v1";
const selectedUrlKey = "yonalist.github.apiBaseUrl.v1";

export interface ResetApplicationDataOptions {
  vaultRoot: string;
  serverUrls?: string[];
  onStep?: (event: ResetApplicationProgressEvent) => void;
}

export type ResetApplicationStepId =
  | "session-tokens"
  | "runtime-caches"
  | "local-storage"
  | "vault-cache";

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
  const preservedVaultDocuments = window.localStorage.getItem(vaultDocumentsKey);
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
  if (preservedVaultDocuments !== null) {
    window.localStorage.setItem(vaultDocumentsKey, preservedVaultDocuments);
  }
}

async function clearNativeVaultCache(vaultRoot: string) {
  if (!isTauri()) {
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("clear_vault_cache", { vaultPath: vaultRoot });
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
  vaultRoot,
  serverUrls = [],
  onStep
}: ResetApplicationDataOptions): Promise<void> {
  const urls = knownServerUrls(serverUrls);
  await runResetStep("session-tokens", onStep, async () => {
    await Promise.all(urls.map((url) => clearSessionToken(url)));
  });

  await runResetStep("runtime-caches", onStep, () => {
    clearNotificationCache();
    clearNotificationDetailCache();
    clearItemThreadCache();
    clearImageProxyCache();
  });

  await runResetStep("local-storage", onStep, () => {
    resetLocalStorage();
  });

  await runResetStep("vault-cache", onStep, async () => {
    await clearNativeVaultCache(vaultRoot);
  });
}
