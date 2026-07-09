import { describe, expect, it } from "vitest";
import { LruCache } from "./lruCache";

describe("LruCache", () => {
  it("stores and returns values", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);

    expect(cache.get("a")).toBe(1);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("evicts the least recently used entry beyond capacity", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("refreshes recency on get", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);

    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
  });

  it("clears all entries", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  describe("byte accounting", () => {
    it("reports zero bytes without an estimator", () => {
      const cache = new LruCache<string>(2);
      cache.set("a", "value");

      expect(cache.stats()).toEqual({ entries: 1, bytes: 0 });
    });

    it("accumulates estimator bytes on set", () => {
      const cache = new LruCache<string>(4, (key, value) => key.length + value.length);
      cache.set("a", "xx"); // 1 + 2
      cache.set("bb", "yyy"); // 2 + 3

      expect(cache.stats()).toEqual({ entries: 2, bytes: 8 });
    });

    it("replaces bytes when overwriting a key", () => {
      const cache = new LruCache<string>(4, (key, value) => key.length + value.length);
      cache.set("a", "x"); // 1 + 1
      cache.set("a", "longer"); // 1 + 6

      expect(cache.stats()).toEqual({ entries: 1, bytes: 7 });
    });

    it("subtracts bytes on delete", () => {
      const cache = new LruCache<string>(4, (key, value) => key.length + value.length);
      cache.set("a", "xx"); // 1 + 2 = 3
      cache.set("bb", "yyy"); // 2 + 3 = 5
      cache.delete("a");

      expect(cache.stats()).toEqual({ entries: 1, bytes: 5 });
    });

    it("subtracts the evicted entry's bytes when maxSize overflows", () => {
      const cache = new LruCache<string>(2, (key, value) => key.length + value.length);
      cache.set("a", "aaa"); // 1 + 3 = 4 (oldest)
      cache.set("b", "bb"); // 1 + 2 = 3
      cache.set("c", "cccc"); // 1 + 4 = 5, evicts "a"

      expect(cache.stats()).toEqual({ entries: 2, bytes: 8 });
    });

    it("clear resets bytes to zero", () => {
      const cache = new LruCache<string>(2, (key, value) => key.length + value.length);
      cache.set("a", "aaa");
      cache.clear();

      expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
    });
  });
});
