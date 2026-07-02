import { describe, expect, it } from "vitest";
import { isTauri, loginWithOAuth } from "./oauth";

describe("OAuth login guard", () => {
  it("is not detected as Tauri inside the test browser environment", () => {
    expect(isTauri()).toBe(false);
  });

  it("rejects OAuth login outside the desktop app with guidance", async () => {
    await expect(
      loginWithOAuth({
        apiBaseUrl: "https://api.github.com",
        clientId: "client",
        clientSecret: "secret",
        scopes: ["repo"]
      })
    ).rejects.toThrow(/desktop app/);
  });
});
