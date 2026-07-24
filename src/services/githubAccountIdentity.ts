import { normalizeUrl } from "./githubServers";

const accountBindingsKey = "yonalist.github.accountBindings.v1";
const bindingOperations = new Map<string, number>();

export interface GithubAccountIdentity {
  readonly id: string;
  readonly login: string;
}

interface StoredGithubAccountBinding {
  tokenDigest: string;
  account: GithubAccountIdentity;
}

export function decodeGithubAccountIdentity(
  value: unknown
): GithubAccountIdentity | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const { id, login } = value as { id?: unknown; login?: unknown };
  const normalizedId =
    typeof id === "number" && Number.isFinite(id)
      ? String(id)
      : typeof id === "string"
        ? id.trim()
        : "";
  const normalizedLogin = typeof login === "string" ? login.trim() : "";
  return normalizedId && normalizedLogin
    ? { id: normalizedId, login: normalizedLogin }
    : null;
}

export function githubSourceConnectionId(
  apiBaseUrl: string,
  accountId: string
): string {
  return JSON.stringify([normalizeUrl(apiBaseUrl), accountId]);
}

export async function githubCredentialDigest(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function readBindings(): Record<string, StoredGithubAccountBinding> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(accountBindingsKey) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, StoredGithubAccountBinding>)
      : {};
  } catch {
    return {};
  }
}

function writeBindings(bindings: Record<string, StoredGithubAccountBinding>) {
  try {
    window.localStorage.setItem(accountBindingsKey, JSON.stringify(bindings));
  } catch {
    // The verified account still remains available in memory for this session.
  }
}

function nextBindingOperation(apiBaseUrl: string): number {
  const operation = (bindingOperations.get(apiBaseUrl) ?? 0) + 1;
  bindingOperations.set(apiBaseUrl, operation);
  return operation;
}

export async function persistGithubAccountBinding(
  apiBaseUrl: string,
  token: string,
  account: GithubAccountIdentity
): Promise<void> {
  const key = normalizeUrl(apiBaseUrl);
  const operation = nextBindingOperation(key);
  const tokenDigest = await githubCredentialDigest(token);
  if (bindingOperations.get(key) !== operation) {
    return;
  }
  const bindings = readBindings();
  bindings[key] = { tokenDigest, account };
  writeBindings(bindings);
}

export async function loadGithubAccountBinding(
  apiBaseUrl: string,
  token: string
): Promise<GithubAccountIdentity | null> {
  const key = normalizeUrl(apiBaseUrl);
  const operation = bindingOperations.get(key) ?? 0;
  const binding = readBindings()[key];
  const account = decodeGithubAccountIdentity(binding?.account);
  if (!binding || typeof binding.tokenDigest !== "string" || !account) {
    return null;
  }
  const tokenDigest = await githubCredentialDigest(token);
  return (bindingOperations.get(key) ?? 0) === operation &&
    binding.tokenDigest === tokenDigest
    ? account
    : null;
}

export function clearGithubAccountBinding(apiBaseUrl: string): void {
  const key = normalizeUrl(apiBaseUrl);
  nextBindingOperation(key);
  const bindings = readBindings();
  delete bindings[key];
  writeBindings(bindings);
}
