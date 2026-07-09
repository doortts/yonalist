import type { CacheSizeStats } from "./cacheStats";

/**
 * Minimal LRU map used to bound the session caches (threads, notification
 * details, proxied images) so long-running sessions cannot grow memory
 * without limit. Map iteration order doubles as the recency order.
 *
 * An optional `estimateBytes` callback lets callers track an approximate byte
 * total incrementally: the cost of each entry is measured once on `set` and
 * kept in a running sum, so `stats()` is O(1) instead of re-measuring every
 * entry per call. The estimator must not throw (estimateJsonBytes already
 * try/catches); a throwing estimator would leave the running total wrong.
 */
export class LruCache<V> {
  private map = new Map<string, V>();
  private entryBytes = new Map<string, number>();
  private totalBytes = 0;

  constructor(
    private readonly maxSize: number,
    private readonly estimateBytes?: (key: string, value: V) => number
  ) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    if (!this.map.has(key)) {
      return undefined;
    }
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    // Overwriting an existing key first releases the old entry's cost so the
    // running total reflects only the new value.
    if (this.estimateBytes && this.map.has(key)) {
      this.releaseBytes(key);
    }
    this.map.delete(key);
    this.map.set(key, value);
    if (this.estimateBytes) {
      const cost = this.estimateBytes(key, value);
      this.entryBytes.set(key, cost);
      this.totalBytes += cost;
    }
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        if (this.estimateBytes) {
          this.releaseBytes(oldest);
        }
        this.map.delete(oldest);
      }
    }
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  delete(key: string): boolean {
    if (this.estimateBytes) {
      this.releaseBytes(key);
    }
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.entryBytes.clear();
    this.totalBytes = 0;
  }

  entries(): Array<[string, V]> {
    return Array.from(this.map.entries());
  }

  stats(): CacheSizeStats {
    return { entries: this.map.size, bytes: this.totalBytes };
  }

  // Subtracts a stored entry's cost from the running total. The cost is always
  // the value captured at insertion — never re-estimated — so the total stays
  // correct even if the estimator would return a different number now.
  private releaseBytes(key: string): void {
    const cost = this.entryBytes.get(key);
    if (cost !== undefined) {
      this.totalBytes -= cost;
      this.entryBytes.delete(key);
    }
  }
}
