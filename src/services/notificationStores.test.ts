import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubNotification } from "../domain/notifications";
import type { NotificationDetailContent } from "./notificationDetail";
import {
  flushPersistedNotificationDetailWrites,
  loadHiddenIds,
  loadPersistedNotificationDetail,
  loadViewedAt,
  markViewed,
  persistHiddenIds,
  persistNotificationDetail,
  resetPersistedNotificationDetailMemory
} from "./notificationStores";

const viewedStorageKey = "yonalist.notifications.viewedAt.v1";
const hiddenStorageKey = "yonalist.notifications.hidden.v1";
const detailStorageKey = "yonalist.notifications.details.v1";

beforeEach(() => {
  window.localStorage.clear();
  // The persisted detail store is a module-level memo; drop it so no state
  // leaks across tests now that reads/writes go through the in-memory copy.
  resetPersistedNotificationDetailMemory();
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

    // Writes are coalesced onto the idle queue, so force the flush before
    // inspecting the raw localStorage payload.
    flushPersistedNotificationDetailWrites();
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

    flushPersistedNotificationDetailWrites();
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

    // The write is deferred to the idle flush, so exercise both: neither the
    // persist nor the forced flush should surface the quota rejection.
    expect(() => {
      persistNotificationDetail(apiBaseUrl, note, detail("X"));
      flushPersistedNotificationDetailWrites();
    }).not.toThrow();
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

describe("idle-coalesced detail persistence", () => {
  // jsdom lacks requestIdleCallback, so scheduleIdleTask deterministically
  // falls back to setTimeout(1500); fake timers let us drive that flush.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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
  const updatedAt = "2026-07-01T00:00:00Z";

  function setItemsForDetailKey(setItem: ReturnType<typeof vi.spyOn>): number {
    return (setItem.mock.calls as unknown[][]).filter(
      (call) => call[0] === detailStorageKey
    ).length;
  }

  it("coalesces multiple persists into a single storage write", () => {
    const setItem = vi.spyOn(window.localStorage, "setItem");

    for (let i = 0; i < 3; i += 1) {
      persistNotificationDetail(
        apiBaseUrl,
        notification(`https://api.github.com/repos/acme/app/issues/${i}`, updatedAt),
        detail(`Item ${i}`)
      );
    }

    expect(setItemsForDetailKey(setItem)).toBe(0);

    vi.advanceTimersByTime(1500);

    expect(setItemsForDetailKey(setItem)).toBe(1);
    const stored = JSON.parse(
      window.localStorage.getItem(detailStorageKey) as string
    ) as Record<string, { subject: string }[]>;
    const host = Object.keys(stored)[0];
    expect(stored[host]).toHaveLength(3);
    expect(stored[host].map((entry) => entry.subject).sort()).toEqual([
      "https://api.github.com/repos/acme/app/issues/0",
      "https://api.github.com/repos/acme/app/issues/1",
      "https://api.github.com/repos/acme/app/issues/2"
    ]);
  });

  it("reads see pending writes before the flush", () => {
    const note = notification(
      "https://api.github.com/repos/acme/app/issues/1",
      updatedAt
    );
    persistNotificationDetail(apiBaseUrl, note, detail("Pending"));

    // The memo serves the read immediately even though nothing is on disk yet.
    expect(window.localStorage.getItem(detailStorageKey)).toBeNull();
    expect(loadPersistedNotificationDetail(apiBaseUrl, note)?.title).toBe("Pending");
  });

  it("flushPersistedNotificationDetailWrites writes immediately and cancels the scheduled flush", () => {
    const setItem = vi.spyOn(window.localStorage, "setItem");
    const note = notification(
      "https://api.github.com/repos/acme/app/issues/1",
      updatedAt
    );
    persistNotificationDetail(apiBaseUrl, note, detail("Flushed"));

    flushPersistedNotificationDetailWrites();

    expect(window.localStorage.getItem(detailStorageKey)).not.toBeNull();
    expect(setItemsForDetailKey(setItem)).toBe(1);

    // The scheduled idle flush was cancelled, so no second write fires.
    vi.advanceTimersByTime(1500);
    expect(setItemsForDetailKey(setItem)).toBe(1);
  });

  it("parses storage once across repeated misses", () => {
    window.localStorage.setItem(
      detailStorageKey,
      JSON.stringify({ [apiBaseUrl]: [] })
    );
    resetPersistedNotificationDetailMemory();
    const getItem = vi.spyOn(window.localStorage, "getItem");

    loadPersistedNotificationDetail(
      apiBaseUrl,
      notification("https://api.github.com/repos/acme/app/issues/1", updatedAt)
    );
    loadPersistedNotificationDetail(
      apiBaseUrl,
      notification("https://api.github.com/repos/acme/app/issues/2", updatedAt)
    );

    expect(
      getItem.mock.calls.filter((call) => call[0] === detailStorageKey)
    ).toHaveLength(1);
  });

  it("resetPersistedNotificationDetailMemory drops the memo and pending writes", () => {
    const setItem = vi.spyOn(window.localStorage, "setItem");
    const note = notification(
      "https://api.github.com/repos/acme/app/issues/1",
      updatedAt
    );
    persistNotificationDetail(apiBaseUrl, note, detail("Dropped"));

    resetPersistedNotificationDetailMemory();

    vi.advanceTimersByTime(1500);
    expect(setItemsForDetailKey(setItem)).toBe(0);
    expect(loadPersistedNotificationDetail(apiBaseUrl, note)).toBeNull();
  });
});
