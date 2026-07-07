/**
 * Minimal LRU map used to bound the session caches (threads, notification
 * details, proxied images) so long-running sessions cannot grow memory
 * without limit. Map iteration order doubles as the recency order.
 */
export class LruCache<V> {
  private map = new Map<string, V>();

  constructor(private readonly maxSize: number) {}

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
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  entries(): Array<[string, V]> {
    return Array.from(this.map.entries());
  }
}
