import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetApplicationData } from "./appReset";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("./sessionTokens", () => ({
  clearSessionToken: vi.fn(async () => undefined)
}));

vi.mock("./imageProxy", () => ({
  clearImageProxyCache: vi.fn()
}));

vi.mock("./itemThread", () => ({
  clearItemThreadCache: vi.fn()
}));

vi.mock("./notificationDetail", () => ({
  clearNotificationDetailCache: vi.fn()
}));

vi.mock("./notifications", () => ({
  clearNotificationCache: vi.fn()
}));

vi.mock("./oauth", () => ({
  isTauri: () => true
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock
}));

describe("resetApplicationData", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    window.localStorage.clear();
  });

  it("clears settings and caches while preserving vault documents", async () => {
    window.localStorage.setItem("yonalist.settings.v1", "{\"vaultFolder\":\"/tmp\"}");
    window.localStorage.setItem("yonalist.themeMode.v1", "dark");
    window.localStorage.setItem(
      "yonalist.github.sessionTokens.v1",
      JSON.stringify({ "https://api.github.com": "gho_session" })
    );
    window.localStorage.setItem(
      "yonalist.repositorySummaries.v1",
      JSON.stringify({ "https://api.github.com": [] })
    );
    window.localStorage.setItem(
      "yonalist.vaultDocumentHashes.v1",
      JSON.stringify({ "~/Yonalist": {} })
    );
    window.localStorage.setItem(
      "yonalist.vaultDocuments.v1",
      JSON.stringify({ "~/Yonalist": { "github.com/acme/app/issues/1/issue.md": "body" } })
    );
    window.localStorage.setItem("unrelated", "kept");

    const events: string[] = [];
    await resetApplicationData({
      vaultRoot: "~/Yonalist",
      serverUrls: ["https://api.github.com"],
      onStep: (event) => {
        events.push(`${event.id}:${event.status}`);
      }
    });

    expect(events).toEqual([
      "session-tokens:running",
      "session-tokens:complete",
      "runtime-caches:running",
      "runtime-caches:complete",
      "local-storage:running",
      "local-storage:complete",
      "vault-cache:running",
      "vault-cache:complete"
    ]);
    expect(window.localStorage.getItem("yonalist.settings.v1")).toBeNull();
    expect(window.localStorage.getItem("yonalist.themeMode.v1")).toBeNull();
    expect(window.localStorage.getItem("yonalist.github.sessionTokens.v1")).toBeNull();
    expect(window.localStorage.getItem("yonalist.repositorySummaries.v1")).toBeNull();
    expect(window.localStorage.getItem("yonalist.vaultDocumentHashes.v1")).toBeNull();
    expect(window.localStorage.getItem("yonalist.vaultDocuments.v1")).toContain(
      "github.com/acme/app/issues/1/issue.md"
    );
    expect(window.localStorage.getItem("unrelated")).toBe("kept");
  });

  it("preserves Notes by clearing only the native vault cache command", async () => {
    await resetApplicationData({ vaultRoot: "/vault" });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("clear_vault_cache", {
      vaultPath: "/vault"
    });
    expect(invokeMock.mock.calls.map(([command]) => command)).not.toContain(
      "notes_empty_trash"
    );
    expect(invokeMock.mock.calls.map(([command]) => command)).not.toContain(
      "notes_delete_database"
    );
  });

  it("removes external snapshots while preserving vault documents", async () => {
    const vaultDocuments = JSON.stringify({
      "~/Yonalist": { "notes/kept.md": "kept" }
    });
    window.localStorage.setItem(
      "yonalist.externalSources.snapshots.v1",
      JSON.stringify({ cached: "external" })
    );
    window.localStorage.setItem("yonalist.vaultDocuments.v1", vaultDocuments);

    await resetApplicationData({ vaultRoot: "~/Yonalist" });

    expect(
      window.localStorage.getItem("yonalist.externalSources.snapshots.v1")
    ).toBeNull();
    expect(window.localStorage.getItem("yonalist.vaultDocuments.v1")).toBe(
      vaultDocuments
    );
  });
});
