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

describe("sessionTokens (Tauri recovery cache)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    invokeMock.mockReset();
  });

  it("mirrors successful keychain saves into the local recovery cache", async () => {
    invokeMock.mockResolvedValue(undefined);

    await saveSessionToken(URL, "gho_session");

    expect(invokeMock).toHaveBeenCalledWith("store_token", {
      service: "Yonalist GitHub",
      account: URL,
      token: "gho_session"
    });
    expect(storedTokens()[URL]).toBe("gho_session");
  });

  it("still saves a restartable token when keychain storage fails", async () => {
    invokeMock.mockRejectedValue(new Error("keychain locked"));

    await saveSessionToken(URL, "gho_session");

    expect(storedTokens()[URL]).toBe("gho_session");
  });

  it("restores from the local recovery cache when keychain lookup fails", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ [URL]: "gho_cached" })
    );
    invokeMock.mockRejectedValue(new Error("keychain locked"));

    await expect(loadSessionToken(URL)).resolves.toBe("gho_cached");
  });

  it("restores from the local recovery cache when keychain has no entry", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ [URL]: "gho_cached" })
    );
    invokeMock.mockResolvedValue(null);

    await expect(loadSessionToken(URL)).resolves.toBe("gho_cached");
  });

  it("clears both keychain and local recovery cache", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ [URL]: "gho_cached" })
    );
    invokeMock.mockResolvedValue(undefined);

    await clearSessionToken(URL);

    expect(invokeMock).toHaveBeenCalledWith("delete_token", {
      service: "Yonalist GitHub",
      account: URL
    });
    expect(storedTokens()[URL]).toBeUndefined();
  });
});
