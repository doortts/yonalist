import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";

const maxResidentImages = 8;

type ResidencyEntry = object;
type ResidencyListener = () => void;
type ByteLeaseOwner = object;

interface ByteEntry {
  readonly owners: Set<ByteLeaseOwner>;
  bytes: Uint8Array | null;
  pending: Promise<Uint8Array> | null;
  generation: number;
}

interface ByteLeaseLifecycle {
  readonly scope: object;
  readonly generation: number;
}

interface NotesImageResidencyCoordinator {
  readonly subscribe: (
    entry: ResidencyEntry,
    listener: ResidencyListener
  ) => () => void;
  readonly isActive: (entry: ResidencyEntry) => boolean;
  readonly activate: (entry: ResidencyEntry) => void;
  readonly deactivate: (entry: ResidencyEntry) => void;
  readonly prewarmBytes: (
    owner: ByteLeaseOwner,
    attachmentId: string,
    load: () => Promise<Uint8Array>
  ) => Promise<Uint8Array>;
  readonly readBytes: (
    owner: ByteLeaseOwner,
    attachmentId: string
  ) => Uint8Array | null;
  readonly releaseBytes: (owner: ByteLeaseOwner, attachmentId: string) => void;
  readonly releaseAllBytes: (owner: ByteLeaseOwner) => void;
  readonly resume: () => void;
  readonly dispose: () => void;
}

interface NotesImageResidencyProviderProps extends PropsWithChildren {
  readonly scopeKey?: string | null;
}

export interface NotesImageResidencyLease {
  readonly active: boolean;
  readonly activate: () => void;
  readonly deactivate: () => void;
}

/**
 * Attachment-byte ownership is deliberately separate from local object URLs.
 * Every hook call owns only the IDs it prewarms, so one renderer cannot free a
 * second renderer's in-flight or resident bytes.
 */
export interface NotesImageByteLease {
  readonly prewarm: (
    attachmentId: string,
    load: () => Promise<Uint8Array>
  ) => Promise<Uint8Array>;
  readonly read: (attachmentId: string) => Uint8Array | null;
  readonly release: (attachmentId: string) => void;
}

const NotesImageResidencyContext =
  createContext<NotesImageResidencyCoordinator | null>(null);

function createNotesImageResidencyCoordinator(
  _scopeKey: string | null | undefined
): NotesImageResidencyCoordinator {
  const residentEntries: ResidencyEntry[] = [];
  const listeners = new Map<ResidencyEntry, Set<ResidencyListener>>();
  const byteEntries = new Map<string, ByteEntry>();
  const residentByteIds: string[] = [];
  let disposed = false;
  const notify = (entry: ResidencyEntry) => {
    for (const listener of listeners.get(entry) ?? []) listener();
  };
  const removeResidentBytes = (attachmentId: string) => {
    const index = residentByteIds.indexOf(attachmentId);
    if (index >= 0) residentByteIds.splice(index, 1);
  };
  const evictByteEntry = (attachmentId: string, entry: ByteEntry) => {
    entry.generation += 1;
    entry.bytes = null;
    entry.pending = null;
    removeResidentBytes(attachmentId);
    if (byteEntries.get(attachmentId) === entry) {
      byteEntries.delete(attachmentId);
    }
  };
  const admitByteEntry = (): boolean => {
    if (byteEntries.size < maxResidentImages) return true;
    const settledId = residentByteIds.find((attachmentId) => {
      const entry = byteEntries.get(attachmentId);
      return entry !== undefined && entry.pending === null;
    });
    const fallbackSettled =
      settledId ??
      Array.from(byteEntries).find(([, entry]) => entry.pending === null)?.[0];
    if (!fallbackSettled) return false;
    const entry = byteEntries.get(fallbackSettled);
    if (entry) evictByteEntry(fallbackSettled, entry);
    return true;
  };
  const releaseEntryIfUnused = (attachmentId: string, entry: ByteEntry) => {
    if (entry.owners.size > 0) return;
    evictByteEntry(attachmentId, entry);
  };
  const touchBytes = (attachmentId: string, entry: ByteEntry) => {
    removeResidentBytes(attachmentId);
    residentByteIds.push(attachmentId);
    while (residentByteIds.length > maxResidentImages) {
      const evictedId = residentByteIds.shift();
      if (!evictedId) continue;
      const evicted = byteEntries.get(evictedId);
      if (evicted) evicted.bytes = null;
    }
    if (byteEntries.get(attachmentId) !== entry) return;
  };

  return {
    subscribe(entry, listener) {
      const entryListeners = listeners.get(entry) ?? new Set();
      entryListeners.add(listener);
      listeners.set(entry, entryListeners);
      return () => {
        entryListeners.delete(listener);
        if (entryListeners.size === 0) listeners.delete(entry);
      };
    },
    isActive: (entry) => residentEntries.includes(entry),
    activate(entry) {
      const currentIndex = residentEntries.indexOf(entry);
      if (currentIndex >= 0) {
        if (currentIndex !== residentEntries.length - 1) {
          residentEntries.splice(currentIndex, 1);
          residentEntries.push(entry);
        }
        return;
      }

      residentEntries.push(entry);
      const evicted =
        residentEntries.length > maxResidentImages
          ? residentEntries.shift()
          : undefined;
      if (evicted) notify(evicted);
      notify(entry);
    },
    deactivate(entry) {
      const currentIndex = residentEntries.indexOf(entry);
      if (currentIndex < 0) return;
      residentEntries.splice(currentIndex, 1);
      notify(entry);
    },
    prewarmBytes(owner, attachmentId, load) {
      if (disposed || !attachmentId) {
        return Promise.reject(new Error("Image byte residency is unavailable."));
      }
      let entry = byteEntries.get(attachmentId);
      if (!entry) {
        if (!admitByteEntry()) {
          return Promise.reject(
            new Error("Image byte residency is at capacity.")
          );
        }
        entry = {
          owners: new Set(),
          bytes: null,
          pending: null,
          generation: 0
        };
        byteEntries.set(attachmentId, entry);
      }
      entry.owners.add(owner);
      if (entry.bytes) {
        touchBytes(attachmentId, entry);
        return Promise.resolve(entry.bytes);
      }
      if (entry.pending) return entry.pending;

      const generation = entry.generation + 1;
      entry.generation = generation;
      let loaded: Promise<Uint8Array>;
      try {
        loaded = Promise.resolve(load());
      } catch (error) {
        loaded = Promise.reject(error);
      }
      const pending = loaded
        .then((bytes) => {
          if (
            disposed ||
            byteEntries.get(attachmentId) !== entry ||
            entry.generation !== generation ||
            bytes.byteLength === 0
          ) {
            throw new Error("Image bytes are unavailable.");
          }
          entry.bytes = bytes;
          entry.pending = null;
          touchBytes(attachmentId, entry);
          return bytes;
        })
        .catch((error: unknown) => {
          if (
            byteEntries.get(attachmentId) === entry &&
            entry.generation === generation
          ) {
            entry.pending = null;
            entry.bytes = null;
            releaseEntryIfUnused(attachmentId, entry);
          }
          throw error;
        });
      entry.pending = pending;
      return pending;
    },
    readBytes(owner, attachmentId) {
      const entry = byteEntries.get(attachmentId);
      if (!entry || !entry.owners.has(owner) || !entry.bytes) return null;
      touchBytes(attachmentId, entry);
      return entry.bytes;
    },
    releaseBytes(owner, attachmentId) {
      const entry = byteEntries.get(attachmentId);
      if (!entry || !entry.owners.delete(owner)) return;
      releaseEntryIfUnused(attachmentId, entry);
    },
    releaseAllBytes(owner) {
      for (const [attachmentId, entry] of byteEntries) {
        if (entry.owners.delete(owner)) releaseEntryIfUnused(attachmentId, entry);
      }
    },
    resume() {
      disposed = false;
    },
    dispose() {
      disposed = true;
      residentEntries.length = 0;
      residentByteIds.length = 0;
      for (const entry of byteEntries.values()) {
        entry.generation += 1;
        entry.bytes = null;
        entry.pending = null;
        entry.owners.clear();
      }
      byteEntries.clear();
      listeners.clear();
    }
  };
}

export function NotesImageResidencyProvider({
  children,
  scopeKey
}: NotesImageResidencyProviderProps) {
  const coordinator = useMemo(
    () => createNotesImageResidencyCoordinator(scopeKey),
    [scopeKey]
  );

  return (
    <NotesImageResidencyContext.Provider value={coordinator}>
      <NotesImageResidencyLifecycle coordinator={coordinator} />
      {children}
    </NotesImageResidencyContext.Provider>
  );
}

function NotesImageResidencyLifecycle({
  coordinator
}: {
  readonly coordinator: NotesImageResidencyCoordinator;
}) {
  useLayoutEffect(() => {
    coordinator.resume();
    return () => coordinator.dispose();
  }, [coordinator]);
  return null;
}

export function useNotesImageResidencyLease(): NotesImageResidencyLease {
  const coordinator = useContext(NotesImageResidencyContext);
  if (!coordinator) {
    throw new Error(
      "useNotesImageResidencyLease must be used within NotesImageResidencyProvider"
    );
  }

  const entryRef = useRef<object | null>(null);
  if (entryRef.current === null) entryRef.current = {};
  const entry = entryRef.current;
  const subscribe = useCallback(
    (listener: ResidencyListener) => coordinator.subscribe(entry, listener),
    [coordinator, entry]
  );
  const getSnapshot = useCallback(
    () => coordinator.isActive(entry),
    [coordinator, entry]
  );
  const active = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const activate = useCallback(
    () => coordinator.activate(entry),
    [coordinator, entry]
  );
  const deactivate = useCallback(
    () => coordinator.deactivate(entry),
    [coordinator, entry]
  );

  useEffect(
    () => () => {
      coordinator.deactivate(entry);
    },
    [coordinator, entry]
  );

  return {
    active,
    activate,
    deactivate
  };
}

export function useNotesImageByteLease(): NotesImageByteLease {
  const providedCoordinator = useContext(NotesImageResidencyContext);
  const fallbackCoordinatorRef = useRef<NotesImageResidencyCoordinator | null>(
    null
  );
  if (fallbackCoordinatorRef.current === null) {
    fallbackCoordinatorRef.current = createNotesImageResidencyCoordinator(null);
  }
  const coordinator = providedCoordinator ?? fallbackCoordinatorRef.current;
  const ownerRef = useRef<ByteLeaseOwner | null>(null);
  if (ownerRef.current === null) ownerRef.current = {};
  const owner = ownerRef.current;
  const scopeToken = coordinator;
  const lifecycleRef = useRef<ByteLeaseLifecycle | null>(null);
  const lifecycleGenerationRef = useRef(0);
  const [, setRevision] = useState(0);

  useLayoutEffect(() => {
    const lifecycle: ByteLeaseLifecycle = {
      scope: scopeToken,
      generation: lifecycleGenerationRef.current + 1
    };
    lifecycleGenerationRef.current = lifecycle.generation;
    lifecycleRef.current = lifecycle;
    return () => {
      if (lifecycleRef.current === lifecycle) {
        lifecycleRef.current = null;
      }
      coordinator.releaseAllBytes(owner);
    };
  }, [coordinator, owner, scopeToken]);

  const prewarm = useCallback(
    (attachmentId: string, load: () => Promise<Uint8Array>) => {
      const lifecycle = lifecycleRef.current;
      if (!lifecycle || lifecycle.scope !== scopeToken) {
        return Promise.reject(new Error("Image byte residency is unavailable."));
      }
      return coordinator.prewarmBytes(owner, attachmentId, load).then(
        (bytes) => {
          if (lifecycleRef.current === lifecycle) {
            setRevision((revision) => revision + 1);
          }
          return bytes;
        },
        (error: unknown) => {
          if (lifecycleRef.current === lifecycle) {
            setRevision((revision) => revision + 1);
          }
          throw error;
        }
      );
    },
    [coordinator, owner, scopeToken]
  );
  const read = useCallback(
    (attachmentId: string) => coordinator.readBytes(owner, attachmentId),
    [coordinator, owner]
  );
  const release = useCallback(
    (attachmentId: string) => {
      const lifecycle = lifecycleRef.current;
      if (!lifecycle || lifecycle.scope !== scopeToken) return;
      coordinator.releaseBytes(owner, attachmentId);
      if (lifecycleRef.current === lifecycle) {
        setRevision((revision) => revision + 1);
      }
    },
    [coordinator, owner, scopeToken]
  );

  return useMemo(
    () => ({ prewarm, read, release }),
    [prewarm, read, release]
  );
}
