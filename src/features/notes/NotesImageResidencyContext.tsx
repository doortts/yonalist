import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore
} from "react";

const maxResidentImages = 8;

type ResidencyEntry = object;
type ResidencyListener = () => void;

interface NotesImageResidencyCoordinator {
  readonly subscribe: (
    entry: ResidencyEntry,
    listener: ResidencyListener
  ) => () => void;
  readonly isActive: (entry: ResidencyEntry) => boolean;
  readonly activate: (entry: ResidencyEntry) => void;
  readonly deactivate: (entry: ResidencyEntry) => void;
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

const NotesImageResidencyContext =
  createContext<NotesImageResidencyCoordinator | null>(null);

function createNotesImageResidencyCoordinator(
  _scopeKey: string | null | undefined
): NotesImageResidencyCoordinator {
  const residentEntries: ResidencyEntry[] = [];
  const listeners = new Map<ResidencyEntry, Set<ResidencyListener>>();
  const notify = (entry: ResidencyEntry) => {
    for (const listener of listeners.get(entry) ?? []) listener();
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
    dispose() {
      residentEntries.length = 0;
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
  useEffect(() => () => coordinator.dispose(), [coordinator]);

  return (
    <NotesImageResidencyContext.Provider value={coordinator}>
      {children}
    </NotesImageResidencyContext.Provider>
  );
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
