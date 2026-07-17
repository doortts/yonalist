import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionToken,
  loadSessionToken,
  saveSessionToken
} from "./sessionTokens";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("./oauth", () => ({
  isTauri: () => true
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock
}));

const URL = "https://oss.navercorp.com/api/v3";
const STORAGE_KEY = "yonalist.github.sessionTokens.v1";

function storedTokens(): Record<string, string> {
  return JSON.parse(
    window.localStorage.getItem(STORAGE_KEY) ?? "{}"
  ) as Record<string, string>;
}

type Backend = "web" | "keychain";

function useBackend(backend: Backend) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "session_token_storage_backend") return backend;
    return undefined;
  });
}

function nativeTokenCommands(): string[] {
  return invokeMock.mock.calls
    .map(([command]) => String(command))
    .filter((command) =>
      ["store_token", "load_token", "delete_token"].includes(command)
    );
}

describe("sessionTokens (Tauri backend routing)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    invokeMock.mockReset();
  });

  it("uses only localStorage for a debug Tauri backend", async () => {
    useBackend("web");
    await saveSessionToken(URL, "gho_debug");
    await expect(loadSessionToken(URL)).resolves.toBe("gho_debug");
    await clearSessionToken(URL);
    expect(nativeTokenCommands()).toEqual([]);
    expect(storedTokens()[URL]).toBeUndefined();
  });

  it("stores release tokens only in Keychain", async () => {
    useBackend("keychain");
    await saveSessionToken(URL, "gho_release");
    expect(invokeMock).toHaveBeenCalledWith("store_token", {
      service: "Yonalist GitHub",
      account: URL,
      token: "gho_release"
    });
    expect(storedTokens()[URL]).toBeUndefined();
  });

  it("migrates a legacy web token after an empty Keychain load", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ [URL]: "gho_legacy" })
    );
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "session_token_storage_backend") return "keychain";
      if (command === "load_token") return null;
      return undefined;
    });
    await expect(loadSessionToken(URL)).resolves.toBe("gho_legacy");
    expect(invokeMock).toHaveBeenCalledWith("store_token", {
      service: "Yonalist GitHub",
      account: URL,
      token: "gho_legacy"
    });
    expect(storedTokens()[URL]).toBeUndefined();
  });

  it("prefers a release Keychain token and removes its legacy web copy", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ [URL]: "gho_legacy" })
    );
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "session_token_storage_backend") return "keychain";
      if (command === "load_token") return "gho_keychain";
      return undefined;
    });
    await expect(loadSessionToken(URL)).resolves.toBe("gho_keychain");
    expect(storedTokens()[URL]).toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalledWith("store_token", expect.anything());
  });

  it("retains a legacy token when migration cannot store it", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ [URL]: "gho_legacy" })
    );
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "session_token_storage_backend") return "keychain";
      if (command === "load_token") return null;
      if (command === "store_token") throw new Error("keychain locked");
      return undefined;
    });
    await expect(loadSessionToken(URL)).resolves.toBe("gho_legacy");
    expect(storedTokens()[URL]).toBe("gho_legacy");
  });

  it("clears release tokens from both stores", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ [URL]: "gho_legacy" })
    );
    useBackend("keychain");
    await clearSessionToken(URL);
    expect(invokeMock).toHaveBeenCalledWith("delete_token", {
      service: "Yonalist GitHub",
      account: URL
    });
    expect(storedTokens()[URL]).toBeUndefined();
  });
});
