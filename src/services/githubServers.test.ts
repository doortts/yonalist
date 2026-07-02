import { beforeEach, describe, expect, it } from "vitest";
import {
  availableUrls,
  deriveHostUrl,
  displayLabel,
  loadServersState,
  personalTokenFor,
  removeUrl,
  resetServers,
  selectUrl,
  upsertServer
} from "./githubServers";

function clearStorage() {
  const storage = window.localStorage;
  if (typeof storage.clear === "function") {
    storage.clear();
    return;
  }
  for (const key of Object.keys(storage)) {
    storage.removeItem(key);
  }
}

describe("deriveHostUrl", () => {
  it("strips the /api/vN suffix for GHE hosts", () => {
    expect(deriveHostUrl("https://oss.navercorp.com/api/v3")).toBe(
      "https://oss.navercorp.com"
    );
  });

  it("maps api.github.com to github.com", () => {
    expect(deriveHostUrl("https://api.github.com")).toBe("https://github.com");
  });
});

describe("GitHub server configuration", () => {
  beforeEach(clearStorage);

  it("seeds default servers with aliases and selects the first one", () => {
    const state = loadServersState();

    expect(state.selectedUrl).toBe("https://oss.navercorp.com/api/v3");
    expect(availableUrls(state)).toEqual([
      "https://oss.navercorp.com/api/v3",
      "https://es.naverlabs.com/api/v3",
      "https://api.github.com"
    ]);
    expect(displayLabel(state, "https://api.github.com")).toBe(
      "Github — https://api.github.com"
    );
  });

  it("registers custom URLs with alias and personal token", () => {
    let state = loadServersState();
    state = upsertServer(state, {
      url: "https://ghe.example.com/api/v3/",
      alias: "사내 GHE",
      personalToken: "ghp_abc"
    });

    expect(availableUrls(state)).toContain("https://ghe.example.com/api/v3");
    expect(displayLabel(state, "https://ghe.example.com/api/v3")).toBe(
      "사내 GHE — https://ghe.example.com/api/v3"
    );
    expect(personalTokenFor(state, "https://ghe.example.com/api/v3")).toBe(
      "ghp_abc"
    );
  });

  it("hides removed defaults and restores them on reselect", () => {
    let state = loadServersState();
    state = removeUrl(state, "https://es.naverlabs.com/api/v3");
    expect(availableUrls(state)).not.toContain("https://es.naverlabs.com/api/v3");

    state = selectUrl(state, "https://es.naverlabs.com/api/v3");
    expect(availableUrls(state)).toContain("https://es.naverlabs.com/api/v3");
    expect(state.selectedUrl).toBe("https://es.naverlabs.com/api/v3");
  });

  it("falls back to the first available URL when the selected one is removed", () => {
    let state = loadServersState();
    state = removeUrl(state, state.selectedUrl);

    expect(state.selectedUrl).toBe("https://es.naverlabs.com/api/v3");
  });

  it("resets custom URLs and tokens back to the defaults", () => {
    let state = loadServersState();
    state = upsertServer(state, {
      url: "https://ghe.example.com/api/v3",
      personalToken: "ghp_abc"
    });

    state = resetServers();

    expect(availableUrls(state)).toHaveLength(3);
    expect(Object.keys(state.personalTokens)).toHaveLength(0);
  });

  it("migrates the legacy single personal access token to its server", () => {
    window.localStorage.setItem(
      "yonalist.settings.v1",
      JSON.stringify({
        apiBaseUrl: "https://ghe.example.com/api/v3",
        personalAccessToken: "ghp_legacy"
      })
    );

    const state = loadServersState();

    expect(state.selectedUrl).toBe("https://ghe.example.com/api/v3");
    expect(personalTokenFor(state, "https://ghe.example.com/api/v3")).toBe(
      "ghp_legacy"
    );
  });
});
