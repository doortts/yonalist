import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubNotification } from "../domain/notifications";
import type { NotificationDetailContent } from "./notificationDetail";
import {
  loadHiddenIds,
  loadPersistedNotificationDetail,
  loadViewedAt,
  markViewed,
  persistHiddenIds,
  persistNotificationDetail
} from "./notificationStores";

const viewedStorageKey = "yonalist.notifications.viewedAt.v1";
const hiddenStorageKey = "yonalist.notifications.hidden.v1";
const detailStorageKey = "yonalist.notifications.details.v1";

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

  it("preserves the first viewed timestamp on later views", () => {
    const url = "https://github.com/acme/app/issues/1";
    markViewed(url, new Date("2026-07-01T00:00:00Z"));
    markViewed(url, new Date("2026-07-03T00:00:00Z"));

    expect(loadViewedAt()[url]).toBe("2026-07-01T00:00:00.000Z");
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

describe("persisted notification details", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function notification(url: string, updatedAt: string): GitHubNotification {
    return {
      id: "1",
      unread: true,
      reason: "mention",
      updated_at: updatedAt,
      last_read_at: null,
      subject: { title: "Subject", url, type: "Issue" },
      repository: { full_name: "acme/app", name: "app", owner: { login: "acme" } }
    };
  }

  function detail(title: string): NotificationDetailContent {
    return {
      title,
      state: "open",
      author: "mona",
      body: `body of ${title}`,
      labels: [],
      comments: []
    };
  }

  const apiBaseUrl = "https://api.github.com";

  it("returns null when nothing is stored", () => {
    expect(
      loadPersistedNotificationDetail(
        apiBaseUrl,
        notification("https://api.github.com/repos/acme/app/issues/1", "2026-07-01T00:00:00Z")
      )
    ).toBeNull();
  });

  it("round-trips a persisted detail matched by subject and version", () => {
    const note = notification(
      "https://api.github.com/repos/acme/app/issues/1",
      "2026-07-01T00:00:00Z"
    );
    persistNotificationDetail(apiBaseUrl, note, detail("Stored"));

    expect(loadPersistedNotificationDetail(apiBaseUrl, note)?.title).toBe("Stored");
  });

  it("does not return a stored detail for a newer version", () => {
    const note = notification(
      "https://api.github.com/repos/acme/app/issues/1",
      "2026-07-01T00:00:00Z"
    );
    persistNotificationDetail(apiBaseUrl, note, detail("Old"));

    const newer = notification(
      "https://api.github.com/repos/acme/app/issues/1",
      "2026-07-05T00:00:00Z"
    );
    expect(loadPersistedNotificationDetail(apiBaseUrl, newer)).toBeNull();
  });

  it("keeps details separated by host", () => {
    const note = notification(
      "https://api.github.com/repos/acme/app/issues/1",
      "2026-07-01T00:00:00Z"
    );
    persistNotificationDetail(apiBaseUrl, note, detail("Public"));

    expect(
      loadPersistedNotificationDetail("https://ghe.example.com/api/v3", note)
    ).toBeNull();
    expect(loadPersistedNotificationDetail(apiBaseUrl, note)?.title).toBe("Public");
  });

  it("evicts the oldest detail once the capacity is exceeded", () => {
    for (let i = 0; i < 32; i += 1) {
      persistNotificationDetail(
        apiBaseUrl,
        notification(
          `https://api.github.com/repos/acme/app/issues/${i}`,
          "2026-07-01T00:00:00Z"
        ),
        detail(`Item ${i}`)
      );
    }

    // Only the most recent 30 survive; the first two were evicted.
    expect(
      loadPersistedNotificationDetail(
        apiBaseUrl,
        notification("https://api.github.com/repos/acme/app/issues/0", "2026-07-01T00:00:00Z")
      )
    ).toBeNull();
    expect(
      loadPersistedNotificationDetail(
        apiBaseUrl,
        notification("https://api.github.com/repos/acme/app/issues/1", "2026-07-01T00:00:00Z")
      )
    ).toBeNull();
    expect(
      loadPersistedNotificationDetail(
        apiBaseUrl,
        notification("https://api.github.com/repos/acme/app/issues/31", "2026-07-01T00:00:00Z")
      )?.title
    ).toBe("Item 31");

    const stored = JSON.parse(
      window.localStorage.getItem(detailStorageKey) as string
    ) as Record<string, unknown[]>;
    const host = Object.keys(stored)[0];
    expect(stored[host]).toHaveLength(30);
  });

  it("refreshes an existing subject's entry in place rather than duplicating", () => {
    const note = notification(
      "https://api.github.com/repos/acme/app/issues/1",
      "2026-07-01T00:00:00Z"
    );
    persistNotificationDetail(apiBaseUrl, note, detail("First"));
    const updated = notification(
      "https://api.github.com/repos/acme/app/issues/1",
      "2026-07-02T00:00:00Z"
    );
    persistNotificationDetail(apiBaseUrl, updated, detail("Second"));

    expect(loadPersistedNotificationDetail(apiBaseUrl, updated)?.title).toBe("Second");
    // The stale version no longer matches.
    expect(loadPersistedNotificationDetail(apiBaseUrl, note)).toBeNull();

    const stored = JSON.parse(
      window.localStorage.getItem(detailStorageKey) as string
    ) as Record<string, unknown[]>;
    expect(stored[Object.keys(stored)[0]]).toHaveLength(1);
  });

  it("silently gives up when storage rejects the write", () => {
    const note = notification(
      "https://api.github.com/repos/acme/app/issues/1",
      "2026-07-01T00:00:00Z"
    );
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    expect(() => persistNotificationDetail(apiBaseUrl, note, detail("X"))).not.toThrow();
  });

  it("falls back to null on corrupt storage", () => {
    window.localStorage.setItem(detailStorageKey, "{not json");
    expect(
      loadPersistedNotificationDetail(
        apiBaseUrl,
        notification("https://api.github.com/repos/acme/app/issues/1", "2026-07-01T00:00:00Z")
      )
    ).toBeNull();
  });
});
