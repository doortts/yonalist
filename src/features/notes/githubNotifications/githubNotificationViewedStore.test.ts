import { beforeEach, describe, expect, it } from "vitest";
import {
  loadGithubNotificationViewedAt,
  recordGithubNotificationViewedAt,
} from "./githubNotificationViewedStore";

describe("githubNotificationViewedStore", () => {
  beforeEach(() => window.localStorage.clear());

  it("uses the existing GN viewed-at key", () => {
    window.localStorage.setItem(
      "yonalist.notifications.viewedAt.v1",
      JSON.stringify({
        "https://github.com/acme/app/issues/7": "2026-07-27T01:00:00.000Z",
      }),
    );
    expect(loadGithubNotificationViewedAt()).toEqual({
      "https://github.com/acme/app/issues/7": "2026-07-27T01:00:00.000Z",
    });
  });

  it("records only the first view of one URL", () => {
    recordGithubNotificationViewedAt(
      "https://github.com/acme/app/issues/7",
      new Date("2026-07-27T01:00:00Z"),
    );
    const result = recordGithubNotificationViewedAt(
      "https://github.com/acme/app/issues/7",
      new Date("2026-07-27T02:00:00Z"),
    );
    expect(result["https://github.com/acme/app/issues/7"]).toBe(
      "2026-07-27T01:00:00.000Z",
    );
  });

  it("falls back to an empty map for corrupt storage", () => {
    window.localStorage.setItem(
      "yonalist.notifications.viewedAt.v1",
      "{broken",
    );
    expect(loadGithubNotificationViewedAt()).toEqual({});
  });
});
