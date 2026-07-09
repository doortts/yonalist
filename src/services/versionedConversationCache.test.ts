import { describe, expect, it } from "vitest";
import {
  createVersionedConversationCache,
  type ConversationValidator
} from "./versionedConversationCache";

function validator(path: string, etag: string | null, lastModified: string | null): ConversationValidator {
  return { path, meta: { etag, lastModified } };
}

describe("createVersionedConversationCache", () => {
  it("stores and returns values per target and version", () => {
    const cache = createVersionedConversationCache<string>({ maxEntries: 2 });
    cache.set("t1", "v1", "A");

    expect(cache.get("t1", "v1")).toBe("A");
    expect(cache.get("t1", "v2")).toBeUndefined();
    expect(cache.get("t2", "v1")).toBeUndefined();
  });

  it("evicts the least recently used entry beyond maxEntries and refreshes recency on get", () => {
    const cache = createVersionedConversationCache<string>({ maxEntries: 2 });
    cache.set("t1", "v", "A");
    cache.set("t2", "v", "B");
    cache.get("t1", "v"); // touch t1 so t2 becomes the eviction victim
    cache.set("t3", "v", "C");

    expect(cache.get("t1", "v")).toBe("A");
    expect(cache.get("t2", "v")).toBeUndefined();
    expect(cache.get("t3", "v")).toBe("C");
  });

  it("returns the most recently set value for a target across versions", () => {
    const cache = createVersionedConversationCache<string>({ maxEntries: 5 });
    cache.set("t1", "v1", "old");
    expect(cache.getLatest("t1")).toBe("old");

    cache.set("t1", "v2", "new");
    expect(cache.getLatest("t1")).toBe("new");
    expect(cache.getLatest("missing")).toBeUndefined();
  });

  it("supports setting a latest pointer standalone", () => {
    const cache = createVersionedConversationCache<string>({ maxEntries: 5 });
    cache.setLatest("t1", "stale");

    expect(cache.getLatest("t1")).toBe("stale");
    // setLatest never creates a versioned entry.
    expect(cache.get("t1", "v1")).toBeUndefined();
  });

  it("keeps latest pointers for still-cached targets when versions contain pipes", () => {
    // Regression: real versions look like '<updated_at>|refresh:<n>' and CONTAIN
    // pipes. Deriving the target from a pipe split over-prunes every pointer.
    const maxEntries = 3;
    const cache = createVersionedConversationCache<string>({ maxEntries });
    const version = "2026-07-02T00:00:00Z|refresh:0";
    for (let i = 0; i <= maxEntries; i += 1) {
      cache.set(`target-${i}`, version, `value-${i}`);
    }

    // target-0 overflowed the LRU and was evicted, so its pointer is gone.
    expect(cache.getLatest("target-0")).toBeUndefined();
    // Every still-cached target (including the just-inserted one) keeps it.
    for (let i = 1; i <= maxEntries; i += 1) {
      expect(cache.getLatest(`target-${i}`)).toBe(`value-${i}`);
    }
  });

  it("keeps latest and validators while any version of a target is cached", () => {
    const cache = createVersionedConversationCache<string>({ maxEntries: 2 });
    const validators = [validator("/p", "e", null)];
    cache.set("t1", "v1", "A");
    cache.recordValidators("t1", validators);
    cache.set("t1", "v2", "B"); // two versions of t1, cache is full at size 2

    cache.set("t2", "v1", "C"); // evicts the oldest entry, t1/v1
    expect(cache.get("t1", "v1")).toBeUndefined();
    // v2 of t1 still cached -> latest + validators survive.
    expect(cache.getLatest("t1")).toBe("B");
    expect(cache.getValidators("t1")).toEqual(validators);

    cache.set("t3", "v1", "D"); // evicts t1/v2, the last surviving t1 version
    expect(cache.getLatest("t1")).toBeUndefined();
    expect(cache.getValidators("t1")).toBeUndefined();
  });

  it("deleteVersion removes one version and keeps latest until the last version is gone", () => {
    const cache = createVersionedConversationCache<string>({ maxEntries: 5 });
    cache.set("t1", "v1", "A");
    cache.set("t1", "v2", "B");
    cache.recordValidators("t1", [validator("/p", "e", null)]);

    cache.deleteVersion("t1", "v1");
    expect(cache.get("t1", "v1")).toBeUndefined();
    expect(cache.get("t1", "v2")).toBe("B");
    // A newer version survives, so latest/validators stay.
    expect(cache.getLatest("t1")).toBe("B");
    expect(cache.getValidators("t1")).not.toBeUndefined();

    cache.deleteVersion("t1", "v2");
    expect(cache.getLatest("t1")).toBeUndefined();
    expect(cache.getValidators("t1")).toBeUndefined();
  });

  it("deleteVersion also drops the matching inflight promise", () => {
    const cache = createVersionedConversationCache<string>({ maxEntries: 5 });
    cache.set("t1", "v1", "A");
    const key = cache.keyFor("t1", "v1");
    cache.inflight.set(key, Promise.resolve("A"));

    cache.deleteVersion("t1", "v1");
    expect(cache.inflight.has(key)).toBe(false);
  });

  it("deleteTarget removes every version, latest, and validators for one target only", () => {
    const cache = createVersionedConversationCache<string>({ maxEntries: 10 });
    cache.set("t1", "v1", "A");
    cache.set("t1", "v2", "B");
    cache.recordValidators("t1", [validator("/p", "e", null)]);
    cache.set("t2", "v1", "C");
    cache.recordValidators("t2", [validator("/q", "e2", null)]);

    cache.deleteTarget("t1");
    expect(cache.get("t1", "v1")).toBeUndefined();
    expect(cache.get("t1", "v2")).toBeUndefined();
    expect(cache.getLatest("t1")).toBeUndefined();
    expect(cache.getValidators("t1")).toBeUndefined();
    // t2 is untouched.
    expect(cache.get("t2", "v1")).toBe("C");
    expect(cache.getLatest("t2")).toBe("C");
    expect(cache.getValidators("t2")).not.toBeUndefined();
  });

  it("records only validators with an etag or last-modified and clears when none qualify", () => {
    const cache = createVersionedConversationCache<string>({ maxEntries: 5 });
    cache.recordValidators("t1", [
      validator("/a", "e", null),
      validator("/b", null, "Mon"),
      validator("/c", null, null)
    ]);

    expect(cache.getValidators("t1")).toEqual([
      validator("/a", "e", null),
      validator("/b", null, "Mon")
    ]);

    cache.recordValidators("t1", [validator("/c", null, null)]);
    expect(cache.getValidators("t1")).toBeUndefined();
  });

  it("reports entry count and estimated bytes from the LRU estimator", () => {
    const cache = createVersionedConversationCache<string>({
      maxEntries: 5,
      estimateBytes: (key, value) => key.length + value.length
    });
    cache.set("t1", "v1", "AA");

    const stats = cache.stats();
    expect(stats.entries).toBe(1);
    // Composite key 't1\nv1' (5 chars) + value 'AA' (2 chars).
    expect(stats.bytes).toBe("t1\nv1".length + 2);
  });

  it("clear empties versions, latest, validators, and inflight", () => {
    const cache = createVersionedConversationCache<string>({ maxEntries: 5 });
    cache.set("t1", "v1", "A");
    cache.recordValidators("t1", [validator("/a", "e", null)]);
    cache.inflight.set(cache.keyFor("t1", "v1"), Promise.resolve("A"));

    cache.clear();
    expect(cache.get("t1", "v1")).toBeUndefined();
    expect(cache.getLatest("t1")).toBeUndefined();
    expect(cache.getValidators("t1")).toBeUndefined();
    expect(cache.inflight.size).toBe(0);
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });
});
