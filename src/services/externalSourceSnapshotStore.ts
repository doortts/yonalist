const storageKey = "yonalist.externalSources.snapshots.v1";

interface PersistedExternalSourceSnapshot {
  readonly version: 1;
  readonly syncedAt: string;
  readonly items: readonly unknown[];
}

type SnapshotStore = Record<string, unknown>;

function snapshotKey(providerId: string, connectionId: string): string {
  return JSON.stringify([providerId, connectionId]);
}

function readSnapshots(): SnapshotStore {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as SnapshotStore)
      : {};
  } catch {
    return {};
  }
}

export function loadExternalSourceSnapshot<T>(
  providerId: string,
  connectionId: string,
  decodeItem: (value: unknown) => T | null
): { readonly items: readonly T[]; readonly syncedAt: string } | null {
  const entry = readSnapshots()[snapshotKey(providerId, connectionId)];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const { version, syncedAt, items } = entry as Partial<PersistedExternalSourceSnapshot>;
  if (
    version !== 1 ||
    typeof syncedAt !== "string" ||
    !Number.isFinite(Date.parse(syncedAt)) ||
    !Array.isArray(items)
  ) {
    return null;
  }

  try {
    const decodedItems: T[] = [];
    for (const item of items) {
      const decoded = decodeItem(item);
      if (decoded === null) {
        return null;
      }
      decodedItems.push(decoded);
    }
    return { items: decodedItems, syncedAt };
  } catch {
    return null;
  }
}

export function persistExternalSourceSnapshot(
  providerId: string,
  connectionId: string,
  items: readonly unknown[],
  syncedAt: Date
): void {
  try {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...readSnapshots(),
        [snapshotKey(providerId, connectionId)]: {
          version: 1,
          syncedAt: syncedAt.toISOString(),
          items
        } satisfies PersistedExternalSourceSnapshot
      })
    );
  } catch {
    // Cache misses are acceptable; the complete network result still works.
  }
}

export function clearExternalSourceSnapshots(): void {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Reset still clears the active in-memory state.
  }
}
