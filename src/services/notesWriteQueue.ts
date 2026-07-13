export interface NotesWriteQueue {
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  enqueueDebounced<T>(
    key: string,
    operation: () => Promise<T>,
    delayMs?: number
  ): Promise<T>;
  hasPending(key: string): boolean;
  flush(key?: string): Promise<void>;
}

interface QueueItem<T = unknown> {
  operation: () => Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
}

interface DebouncedWaiter {
  resolve(value: unknown): void;
  reject(cause: unknown): void;
}

interface DebouncedEntry {
  timer: ReturnType<typeof setTimeout> | null;
  operation: () => Promise<unknown>;
  waiters: DebouncedWaiter[];
}

const DEFAULT_DEBOUNCE_MS = 300;

export function createNotesWriteQueue(): NotesWriteQueue {
  const queued: QueueItem[] = [];
  const debounced = new Map<string, DebouncedEntry>();
  const idleWaiters = new Set<() => void>();
  let running = false;

  const resolveIdle = (): void => {
    if (running || queued.length > 0) {
      return;
    }
    for (const resolve of idleWaiters) {
      resolve();
    }
    idleWaiters.clear();
  };

  const pump = (): void => {
    if (running) {
      return;
    }
    const item = queued.shift();
    if (!item) {
      resolveIdle();
      return;
    }

    running = true;
    let operation: Promise<unknown>;
    try {
      operation = item.operation();
    } catch (cause) {
      running = false;
      item.reject(cause);
      pump();
      return;
    }

    void Promise.resolve(operation).then(
      (value) => {
        running = false;
        item.resolve(value);
        pump();
      },
      (cause) => {
        running = false;
        item.reject(cause);
        pump();
      }
    );
  };

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queued.push({ operation, resolve, reject } as QueueItem);
      pump();
    });

  const startDebounced = (
    key: string,
    entry: DebouncedEntry
  ): Promise<unknown> => {
    if (debounced.get(key) !== entry) {
      return Promise.resolve();
    }
    debounced.delete(key);
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    const completion = enqueue(entry.operation);
    void completion.then(
      (value) => {
        for (const waiter of entry.waiters) {
          waiter.resolve(value);
        }
      },
      (cause) => {
        for (const waiter of entry.waiters) {
          waiter.reject(cause);
        }
      }
    );
    return completion;
  };

  const enqueueDebounced = <T>(
    key: string,
    operation: () => Promise<T>,
    delayMs = DEFAULT_DEBOUNCE_MS
  ): Promise<T> => {
    const existing = debounced.get(key);
    if (existing) {
      if (existing.timer !== null) {
        clearTimeout(existing.timer);
      }
      existing.operation = operation;
      existing.timer = setTimeout(
        () => void startDebounced(key, existing),
        delayMs
      );
      return new Promise<T>((resolve, reject) => {
        existing.waiters.push({ resolve, reject });
      });
    }

    const entry: DebouncedEntry = {
      operation,
      waiters: [],
      timer: null
    };
    entry.timer = setTimeout(() => void startDebounced(key, entry), delayMs);
    debounced.set(key, entry);
    return new Promise<T>((resolve, reject) => {
      entry.waiters.push({ resolve, reject });
    });
  };

  const waitForIdle = (): Promise<void> => {
    if (!running && queued.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      idleWaiters.add(resolve);
    });
  };

  const flush = async (key?: string): Promise<void> => {
    const starts: Promise<unknown>[] = [];
    if (key === undefined) {
      for (const [pendingKey, entry] of [...debounced]) {
        starts.push(startDebounced(pendingKey, entry));
      }
    } else {
      const entry = debounced.get(key);
      if (entry) {
        starts.push(startDebounced(key, entry));
      }
    }
    await Promise.allSettled(starts);
    await waitForIdle();
  };

  return {
    enqueue,
    enqueueDebounced,
    hasPending: (key) => debounced.has(key),
    flush
  };
}
