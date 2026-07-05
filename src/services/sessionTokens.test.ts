import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSessionToken,
  loadSessionToken,
  saveSessionToken
} from "./sessionTokens";

const URL_A = "https://oss.navercorp.com/api/v3";
const URL_B = "https://api.github.com";

// These tests exercise the browser fallback (localStorage); the Tauri build
// routes the same calls to the OS keychain via store_token/load_token.
describe("sessionTokens (web fallback)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns null when no token was saved", async () => {
    expect(await loadSessionToken(URL_A)).toBeNull();
  });

  it("round-trips a token per server URL", async () => {
    await saveSessionToken(URL_A, "gho_session_a");
    await saveSessionToken(URL_B, "gho_session_b");

    expect(await loadSessionToken(URL_A)).toBe("gho_session_a");
    expect(await loadSessionToken(URL_B)).toBe("gho_session_b");
  });

  it("clears a token without touching other servers", async () => {
    await saveSessionToken(URL_A, "gho_session_a");
    await saveSessionToken(URL_B, "gho_session_b");

    await clearSessionToken(URL_A);

    expect(await loadSessionToken(URL_A)).toBeNull();
    expect(await loadSessionToken(URL_B)).toBe("gho_session_b");
  });

  it("treats blank stored values as absent", async () => {
    await saveSessionToken(URL_A, "   ");
    expect(await loadSessionToken(URL_A)).toBeNull();
  });

  it("survives corrupt storage", async () => {
    window.localStorage.setItem("yonalist.github.sessionTokens.v1", "not-json");
    expect(await loadSessionToken(URL_A)).toBeNull();
    await saveSessionToken(URL_A, "gho_new");
    expect(await loadSessionToken(URL_A)).toBe("gho_new");
  });
});
