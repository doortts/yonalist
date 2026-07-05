import { beforeEach, describe, expect, it, vi } from "vitest";
import { openExternal } from "./browser";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("./oauth", () => ({
  isTauri: () => true
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock
}));

describe("openExternal in Tauri", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("uses the OS-browser command instead of the OAuth webview command", async () => {
    await openExternal("https://github.com/acme/app/issues/1");

    expect(invokeMock).toHaveBeenCalledWith("open_external_url", {
      url: "https://github.com/acme/app/issues/1"
    });
    expect(invokeMock).not.toHaveBeenCalledWith("open_url", expect.anything());
  });
});
