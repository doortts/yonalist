import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubConnection } from "../hooks/useGithubAuth";
import {
  clearImageProxyCache,
  loadCachedAvatarImageAsync,
  resolveAvatarImage
} from "./imageProxy";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("./oauth", () => ({
  isTauri: () => true
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock
}));

const connection: GithubConnection = {
  apiBaseUrl: "https://oss.navercorp.com/api/v3",
  webBaseUrl: "https://oss.navercorp.com",
  token: "ghp_token"
};
const vaultRoot = "/Users/doortts/Yonalist";

describe("imageProxy avatar cache in Tauri", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    clearImageProxyCache();
    vi.useRealTimers();
  });

  it("loads avatar metadata and data from the native SQLite cache", async () => {
    invokeMock.mockResolvedValueOnce({
      src: "https://oss.navercorp.com/avatars/u/1.png",
      data_url: "data:image/png;base64,cached",
      hash: "abc123",
      checked_at: "2026-07-05T00:00:00.000Z",
      updated_at: "2026-07-05T00:00:00.000Z"
    });

    const cached = await loadCachedAvatarImageAsync("mona", connection, vaultRoot);

    expect(cached?.dataUrl).toBe("data:image/png;base64,cached");
    expect(invokeMock).toHaveBeenCalledWith("load_cached_avatar_image", {
      vaultPath: vaultRoot,
      host: "oss.navercorp.com",
      login: "mona"
    });
  });

  it("uses a fresh SQLite avatar cache without fetching the image again", async () => {
    vi.setSystemTime(new Date("2026-07-05T00:30:00.000Z"));
    invokeMock.mockResolvedValueOnce({
      src: "https://oss.navercorp.com/avatars/u/1.png",
      data_url: "data:image/png;base64,cached",
      hash: "abc123",
      checked_at: "2026-07-05T00:00:00.000Z",
      updated_at: "2026-07-05T00:00:00.000Z"
    });

    const resolved = await resolveAvatarImage(
      "mona",
      "https://oss.navercorp.com/avatars/u/1.png",
      connection,
      vaultRoot
    );

    expect(resolved).toBe("data:image/png;base64,cached");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalledWith("fetch_image", expect.anything());
  });
});
