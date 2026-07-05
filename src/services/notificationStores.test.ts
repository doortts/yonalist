import { beforeEach, describe, expect, it } from "vitest";
import {
  loadHiddenIds,
  loadViewedAt,
  markViewed,
  persistHiddenIds
} from "./notificationStores";

const viewedStorageKey = "yonalist.notifications.viewedAt.v1";
const hiddenStorageKey = "yonalist.notifications.hidden.v1";

beforeEach(() => {
  window.localStorage.clear();
});

describe("viewed timestamps", () => {
  it("defaults to an empty map when nothing is stored", () => {
    expect(loadViewedAt()).toEqual({});
  });

  it("falls back to an empty map on corrupt storage", () => {
    window.localStorage.setItem(viewedStorageKey, "{not json");
    expect(loadViewedAt()).toEqual({});
  });

  it("persists the viewing time and loads it back", () => {
    const url = "https://github.com/acme/app/issues/1";
    const at = new Date("2026-07-02T10:00:00Z");

    const map = markViewed(url, at);

    expect(map[url]).toBe("2026-07-02T10:00:00.000Z");
    expect(loadViewedAt()).toEqual({ [url]: "2026-07-02T10:00:00.000Z" });
  });

  it("keeps timestamps for other URLs when marking a new one", () => {
    markViewed("https://a", new Date("2026-07-01T00:00:00Z"));
    markViewed("https://b", new Date("2026-07-02T00:00:00Z"));

    expect(loadViewedAt()).toEqual({
      "https://a": "2026-07-01T00:00:00.000Z",
      "https://b": "2026-07-02T00:00:00.000Z"
    });
  });

  it("never moves a viewed timestamp backwards", () => {
    const url = "https://github.com/acme/app/issues/1";
    markViewed(url, new Date("2026-07-02T10:00:00Z"));

    const map = markViewed(url, new Date("2026-07-01T00:00:00Z"));

    expect(map[url]).toBe("2026-07-02T10:00:00.000Z");
    expect(loadViewedAt()[url]).toBe("2026-07-02T10:00:00.000Z");
  });

  it("advances the timestamp on a later view", () => {
    const url = "https://github.com/acme/app/issues/1";
    markViewed(url, new Date("2026-07-01T00:00:00Z"));
    markViewed(url, new Date("2026-07-03T00:00:00Z"));

    expect(loadViewedAt()[url]).toBe("2026-07-03T00:00:00.000Z");
  });
});

describe("hidden notification ids", () => {
  it("defaults to an empty set when nothing is stored", () => {
    expect(loadHiddenIds()).toEqual(new Set());
  });

  it("falls back to an empty set on corrupt storage", () => {
    window.localStorage.setItem(hiddenStorageKey, "not json at all");
    expect(loadHiddenIds()).toEqual(new Set());
  });

  it("round-trips the hidden id set", () => {
    persistHiddenIds(new Set(["1", "2", "3"]));
    expect(loadHiddenIds()).toEqual(new Set(["1", "2", "3"]));
  });

  it("overwrites the previous set on persist", () => {
    persistHiddenIds(new Set(["1", "2"]));
    persistHiddenIds(new Set(["2"]));
    expect(loadHiddenIds()).toEqual(new Set(["2"]));
  });
});
