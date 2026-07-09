import type { CacheSizeStats } from "./cacheStats";
import type { GitHubResponseMeta } from "./githubTransport";
import { LruCache } from "./lruCache";

/** A conditional-request validator (etag/last-modified) for one API path. */
export interface ConversationValidator {
  path: string;
  meta: GitHubResponseMeta;
}

export interface VersionedConversationCacheOptions<T> {
  /** Maximum number of versioned entries kept before LRU eviction begins. */
  maxEntries: number;
  /** Optional byte estimator, wired straight through to the backing LruCache. */
  estimateBytes?: (key: string, value: T) => number;
}

/**
 * A bounded cache of conversation payloads (issue/PR/discussion threads,
 * notification details) keyed by (targetKey, version). Every satellite Map that
 * used to be duplicated per service — the version-independent "latest" pointer,
 * the conditional-request validators, and the in-flight request registry —
 * lives here so none of them can outgrow the bounded LRU.
 *
 * Only `deleteVersion`/`deleteTarget` differ between the two services and are
 * kept as distinct methods; nothing else is service-specific.
 */
export interface VersionedConversationCache<T> {
  /** In-flight fetches keyed by composite key (adapters may add a suffix). */
  readonly inflight: Map<string, Promise<T>>;
  /** Composite key for a (target, version) pair, exposed for inflight keys. */
  keyFor(targetKey: string, version: string): string;
  get(targetKey: string, version: string): T | undefined;
  /** Stores a versioned entry and updates the target's latest pointer. */
  set(targetKey: string, version: string, value: T): void;
  /** Most recently stored value for a target, across any version. */
  getLatest(targetKey: string): T | undefined;
  /** Sets a latest pointer without creating a versioned entry. */
  setLatest(targetKey: string, value: T): void;
  /**
   * Drops a single version; the latest pointer and validators are removed only
   * once no version of the target survives (itemThread eviction semantics).
   */
  deleteVersion(targetKey: string, version: string): boolean;
  /**
   * Drops every version plus the latest pointer and validators for one target
   * (notificationDetail delete-whole-subject semantics). Does not touch
   * in-flight requests, matching the previous behavior.
   */
  deleteTarget(targetKey: string): void;
  getValidators(targetKey: string): ConversationValidator[] | undefined;
  /** Keeps only validators carrying an etag/last-modified; clears when none do. */
  recordValidators(targetKey: string, validators: ConversationValidator[]): void;
  stats(): CacheSizeStats;
  clear(): void;
}

// '\n' can never appear in an API base URL, a subject URL, or an ISO timestamp,
// so it is a safe composite-key separator — unlike '|', which appears inside a
// real itemThreadVersion ('<updated_at>|refresh:<n>'). Deriving the target from
// a '|' split silently truncated versions and over-pruned every latest pointer;
// this convention mirrors imageProxy's cacheKey.
const SEPARATOR = "\n";

function hasValidator(meta: GitHubResponseMeta): boolean {
  return Boolean(meta.etag || meta.lastModified);
}

export function createVersionedConversationCache<T>(
  options: VersionedConversationCacheOptions<T>
): VersionedConversationCache<T> {
  const latest = new Map<string, T>();
  const validators = new Map<string, ConversationValidator[]>();
  const inflight = new Map<string, Promise<T>>();
  // Exact eviction bookkeeping: which versions of each target are live. Split
  // on the LAST separator so the target key — which may itself contain the
  // service's own '|'-joined fields — is recovered intact.
  const versionsByTarget = new Map<string, Set<string>>();

  const lru = new LruCache<T>(options.maxEntries, {
    estimateBytes: options.estimateBytes,
    onEvict: (compositeKey) => {
      const index = compositeKey.lastIndexOf(SEPARATOR);
      const targetKey = compositeKey.slice(0, index);
      const version = compositeKey.slice(index + SEPARATOR.length);
      dropVersion(targetKey, version);
    }
  });

  function keyFor(targetKey: string, version: string): string {
    return `${targetKey}${SEPARATOR}${version}`;
  }

  // Removes one version from the target index and, once the target has no
  // surviving versions, drops its latest pointer and validators.
  function dropVersion(targetKey: string, version: string): void {
    const versions = versionsByTarget.get(targetKey);
    if (!versions) {
      return;
    }
    versions.delete(version);
    if (versions.size === 0) {
      versionsByTarget.delete(targetKey);
      latest.delete(targetKey);
      validators.delete(targetKey);
    }
  }

  return {
    inflight,
    keyFor,
    get(targetKey, version) {
      return lru.get(keyFor(targetKey, version));
    },
    set(targetKey, version, value) {
      // Record the version BEFORE the LruCache.set: if the set overflows and
      // evicts an OLDER version of this same target, onEvict must still see the
      // new version in the target's set so the latest pointer is preserved.
      let versions = versionsByTarget.get(targetKey);
      if (!versions) {
        versions = new Set();
        versionsByTarget.set(targetKey, versions);
      }
      versions.add(version);
      lru.set(keyFor(targetKey, version), value);
      latest.set(targetKey, value);
    },
    getLatest(targetKey) {
      return latest.get(targetKey);
    },
    setLatest(targetKey, value) {
      latest.set(targetKey, value);
    },
    deleteVersion(targetKey, version) {
      const key = keyFor(targetKey, version);
      inflight.delete(key);
      // LruCache.delete does not fire onEvict, so update the index by hand.
      const deleted = lru.delete(key);
      dropVersion(targetKey, version);
      return deleted;
    },
    deleteTarget(targetKey) {
      const versions = versionsByTarget.get(targetKey);
      if (versions) {
        for (const version of versions) {
          lru.delete(keyFor(targetKey, version));
        }
        versionsByTarget.delete(targetKey);
      }
      latest.delete(targetKey);
      validators.delete(targetKey);
    },
    getValidators(targetKey) {
      return validators.get(targetKey);
    },
    recordValidators(targetKey, next) {
      const usable = next.filter((validator) => hasValidator(validator.meta));
      if (usable.length > 0) {
        validators.set(targetKey, usable);
      } else {
        validators.delete(targetKey);
      }
    },
    stats() {
      return lru.stats();
    },
    clear() {
      lru.clear();
      latest.clear();
      validators.clear();
      inflight.clear();
      versionsByTarget.clear();
    }
  };
}
