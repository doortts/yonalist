import { beforeEach, describe, expect, it } from "vitest";
import {
  clearExternalSourceSnapshots,
  loadExternalSourceSnapshot,
  persistExternalSourceSnapshot
} from "./externalSourceSnapshotStore";

const storageKey = "yonalist.externalSources.snapshots.v1";
const now = new Date("2026-07-22T00:00:00.000Z");
const itemA = { id: "a", title: "Alpha" };
const itemB = { id: "b", title: "Beta" };

function decodeItem(value: unknown): typeof itemA | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const { id, title } = value as { id?: unknown; title?: unknown };
  return typeof id === "string" && typeof title === "string"
    ? { id, title }
    : null;
}

describe("external source snapshots", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("isolates snapshots by provider and verified connection", () => {
    persistExternalSourceSnapshot(
      "github-notifications",
      "server/account-a",
      [itemA],
      now
    );
    persistExternalSourceSnapshot(
      "github-notifications",
      "server/account-b",
      [itemB],
      now
    );
    persistExternalSourceSnapshot("another-provider", "server/account-a", [itemB], now);

    expect(
      loadExternalSourceSnapshot(
        "github-notifications",
        "server/account-a",
        decodeItem
      )
    ).toEqual({ items: [itemA], syncedAt: now.toISOString() });
    expect(
      loadExternalSourceSnapshot(
        "github-notifications",
        "server/account-b",
        decodeItem
      )
    ).toEqual({ items: [itemB], syncedAt: now.toISOString() });
    expect(
      loadExternalSourceSnapshot("another-provider", "server/account-a", decodeItem)
    ).toEqual({ items: [itemB], syncedAt: now.toISOString() });
  });

  it("replaces the complete snapshot instead of merging stale items", () => {
    persistExternalSourceSnapshot(
      "github-notifications",
      "server/account-a",
      [itemA, itemB],
      now
    );
    persistExternalSourceSnapshot(
      "github-notifications",
      "server/account-a",
      [itemA],
      new Date("2026-07-22T01:00:00.000Z")
    );

    expect(
      loadExternalSourceSnapshot(
        "github-notifications",
        "server/account-a",
        decodeItem
      )
    ).toEqual({ items: [itemA], syncedAt: "2026-07-22T01:00:00.000Z" });
  });

  it("rejects the complete entry when any stored item is invalid", () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        '["github-notifications","server/account-a"]': {
          version: 1,
          syncedAt: now.toISOString(),
          items: [itemA, { broken: true }]
        }
      })
    );

    expect(
      loadExternalSourceSnapshot(
        "github-notifications",
        "server/account-a",
        decodeItem
      )
    ).toBeNull();
  });

  it.each([
    "{not json",
    JSON.stringify([]),
    JSON.stringify({
      '["github-notifications","server/account-a"]': {
        version: 2,
        syncedAt: now.toISOString(),
        items: [itemA]
      }
    }),
    JSON.stringify({
      '["github-notifications","server/account-a"]': {
        version: 1,
        syncedAt: "not-a-date",
        items: [itemA]
      }
    }),
    JSON.stringify({
      '["github-notifications","server/account-a"]': {
        version: 1,
        syncedAt: now.toISOString(),
        items: {}
      }
    })
  ])("rejects corrupt storage", (stored) => {
    window.localStorage.setItem(storageKey, stored);

    expect(
      loadExternalSourceSnapshot(
        "github-notifications",
        "server/account-a",
        decodeItem
      )
    ).toBeNull();
  });

  it("clears all external source snapshots", () => {
    persistExternalSourceSnapshot(
      "github-notifications",
      "server/account-a",
      [itemA],
      now
    );

    clearExternalSourceSnapshots();

    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });
});
