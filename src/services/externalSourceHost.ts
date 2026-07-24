import {
  serializeExternalBulletKey,
  type ExternalBulletKey,
  type ExternalSourceProvider
} from "../domain/externalSources";
import {
  loadExternalSourceSnapshot,
  persistExternalSourceSnapshot
} from "./externalSourceSnapshotStore";

export const EXTERNAL_SOURCE_REFRESH_ERROR =
  "Unable to refresh external source.";
export const EXTERNAL_SOURCE_COMPLETION_ERROR =
  "Unable to complete external item.";

export interface ExternalSourceState<T> {
  readonly items: readonly T[];
  readonly loaded: boolean;
  /** Whether `items` is a full source snapshot rather than a paging partial. */
  readonly isComplete: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly syncedAt: string | null;
  /** Advances after each successful remote completion, including a live partial row. */
  readonly completionVersion: number;
  readonly completingKeys: ReadonlySet<string>;
  readonly completionErrors: Readonly<Record<string, string>>;
}

export interface ExternalSourceHandle<T> {
  getState(): ExternalSourceState<T>;
  subscribe(listener: () => void): () => void;
  acquire(): () => void;
  refresh(): Promise<void>;
  complete(key: ExternalBulletKey): Promise<void>;
  dispose(): void;
}

export function toExternalSourcePublicError(
  kind: "refresh" | "completion",
  cause: unknown
): string | null {
  try {
    if (
      cause !== null &&
      typeof cause === "object" &&
      "name" in cause &&
      cause.name === "AbortError"
    ) {
      return null;
    }
  } catch {
    // Untrusted errors may expose throwing properties; public errors stay fixed.
  }
  return kind === "refresh"
    ? EXTERNAL_SOURCE_REFRESH_ERROR
    : EXTERNAL_SOURCE_COMPLETION_ERROR;
}

interface ExternalSourceHostOptions {
  readonly pollIntervalMs?: number;
  readonly now?: () => Date;
}

interface ActiveRequest {
  readonly generation: number;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

interface ActiveCompletion {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

const emptyCompletingKeys: ReadonlySet<string> = new Set();
const emptyCompletionErrors: Readonly<Record<string, string>> = Object.freeze({});

export function createExternalSourceHost<T>(
  provider: ExternalSourceProvider<T>,
  connectionId: string,
  options: ExternalSourceHostOptions = {}
): ExternalSourceHandle<T> {
  const cached = loadExternalSourceSnapshot(
    provider.id,
    connectionId,
    provider.decodeItem
  );
  provider.seed?.(cached?.items ?? []);
  const listeners = new Set<() => void>();
  const pollIntervalMs = options.pollIntervalMs ?? 60_000;
  const now = options.now ?? (() => new Date());
  let lastCompleteItems = cached?.items ?? [];
  let state: ExternalSourceState<T> = {
    items: lastCompleteItems,
    loaded: cached !== null,
    isComplete: true,
    loading: false,
    error: null,
    syncedAt: cached?.syncedAt ?? null,
    completionVersion: 0,
    completingKeys: emptyCompletingKeys,
    completionErrors: emptyCompletionErrors
  };
  let leases = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let generation = 0;
  let activeRequest: ActiveRequest | null = null;
  const completionInflight = new Map<string, ActiveCompletion>();
  let queuedRefresh: Promise<void> | null = null;
  let disposed = false;

  function update(next: Partial<ExternalSourceState<T>>): void {
    if (disposed) {
      return;
    }
    const candidate = { ...state, ...next };
    if (
      (Object.keys(next) as (keyof ExternalSourceState<T>)[]).every(
        (key) => Object.is(candidate[key], state[key])
      )
    ) {
      return;
    }
    state = candidate;
    listeners.forEach((listener) => listener());
  }

  function cancelRequest(keepState: boolean): void {
    if (activeRequest) {
      generation += 1;
      activeRequest.controller.abort();
      activeRequest = null;
    }
    if (!keepState) {
      update({ items: lastCompleteItems, isComplete: true, loading: false });
    }
  }

  function refresh(): Promise<void> {
    if (disposed) {
      return Promise.resolve();
    }
    if (activeRequest) {
      return activeRequest.promise;
    }
    if (completionInflight.size > 0) {
      if (queuedRefresh) {
        return queuedRefresh;
      }
      queuedRefresh = Promise.allSettled(
        [...completionInflight.values()].map(({ promise }) => promise)
      ).then(() => {
        queuedRefresh = null;
        return refresh();
      });
      return queuedRefresh;
    }

    const requestGeneration = ++generation;
    const controller = new AbortController();
    let resolveRequest!: () => void;
    let rejectRequest!: (reason: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    activeRequest = { generation: requestGeneration, controller, promise };
    update({ loading: true, error: null });
    if (
      disposed ||
      generation !== requestGeneration ||
      controller.signal.aborted
    ) {
      resolveRequest();
      return promise;
    }

    let load: Promise<readonly T[]>;
    try {
      load = provider.load({
        signal: controller.signal,
        publishPartial(items) {
          if (
            !disposed &&
            generation === requestGeneration &&
            !controller.signal.aborted
          ) {
            update({ items, isComplete: false, loading: true });
          }
        }
      });
    } catch (cause) {
      load = Promise.reject(cause);
    }

    void load
      .then(
        (items) => {
          if (
            disposed ||
            generation !== requestGeneration ||
            controller.signal.aborted
          ) {
            return;
          }
          const completedAt = now();
          lastCompleteItems = items;
          persistExternalSourceSnapshot(
            provider.id,
            connectionId,
            lastCompleteItems,
            completedAt
          );
          update({
            items: lastCompleteItems,
            loaded: true,
            isComplete: true,
            loading: false,
            error: null,
            syncedAt: completedAt.toISOString()
          });
        },
        (cause) => {
          if (
            disposed ||
            generation !== requestGeneration ||
            controller.signal.aborted
          ) {
            return;
          }
          const publicError = toExternalSourcePublicError("refresh", cause);
          if (publicError === null) {
            update({ items: lastCompleteItems, isComplete: true, loading: false });
            return;
          }
          update({
            items: lastCompleteItems,
            isComplete: true,
            loading: false,
            error: publicError
          });
          throw new Error(publicError);
        }
      )
      .then(
        () => {
          if (activeRequest?.generation === requestGeneration) {
            activeRequest = null;
          }
          resolveRequest();
        },
        (reason) => {
          if (activeRequest?.generation === requestGeneration) {
            activeRequest = null;
          }
          rejectRequest(reason);
        }
      );
    return promise;
  }

  function withoutCompletionError(
    serialized: string
  ): Readonly<Record<string, string>> {
    if (!(serialized in state.completionErrors)) {
      return state.completionErrors;
    }
    const next = { ...state.completionErrors };
    delete next[serialized];
    return next;
  }

  function withoutCompletingKey(serialized: string): ReadonlySet<string> {
    if (!state.completingKeys.has(serialized)) {
      return state.completingKeys;
    }
    const next = new Set(state.completingKeys);
    next.delete(serialized);
    return next;
  }

  function replaceItem(
    items: readonly T[],
    serialized: string,
    replacement: T
  ): { readonly items: readonly T[]; readonly replaced: boolean } {
    let replaced = false;
    const next = items.map((item) => {
      if (
        serializeExternalBulletKey(provider.keyOf(item, connectionId)) ===
        serialized
      ) {
        replaced = true;
        return replacement;
      }
      return item;
    });
    return { items: replaced ? next : items, replaced };
  }

  async function completeOnce(
    key: ExternalBulletKey,
    serialized: string,
    controller: AbortController
  ): Promise<void> {
    let restoreCompleteItemsOnFailure = false;
    try {
      const item = state.items.find(
        (candidate) =>
          serializeExternalBulletKey(provider.keyOf(candidate, connectionId)) ===
          serialized
      );
      if (!item || !provider.markComplete || !provider.canComplete(item)) {
        throw new Error(EXTERNAL_SOURCE_COMPLETION_ERROR);
      }

      restoreCompleteItemsOnFailure = activeRequest !== null;
      cancelRequest(true);
      if (disposed || controller.signal.aborted) {
        return;
      }
      update({
        loading: false,
        completingKeys: new Set(state.completingKeys).add(serialized),
        completionErrors: withoutCompletionError(serialized)
      });
      if (disposed || controller.signal.aborted) {
        return;
      }

      const raw = await provider.markComplete({
        key,
        item,
        signal: controller.signal
      });
      if (disposed || controller.signal.aborted) {
        return;
      }
      const decoded = provider.decodeItem(raw);
      if (
        decoded === null ||
        serializeExternalBulletKey(provider.keyOf(decoded, connectionId)) !==
          serialized
      ) {
        throw new Error(EXTERNAL_SOURCE_COMPLETION_ERROR);
      }

      const displayed = replaceItem(state.items, serialized, decoded);
      const cachedItems = replaceItem(lastCompleteItems, serialized, decoded);
      let syncedAt = state.syncedAt;
      if (cachedItems.replaced) {
        const completedAt = now();
        lastCompleteItems = cachedItems.items;
        persistExternalSourceSnapshot(
          provider.id,
          connectionId,
          lastCompleteItems,
          completedAt
        );
        syncedAt = completedAt.toISOString();
      }
      update({
        items: displayed.items,
        isComplete: cachedItems.replaced,
        syncedAt,
        completionVersion: state.completionVersion + 1,
        completingKeys: withoutCompletingKey(serialized),
        completionErrors: withoutCompletionError(serialized)
      });
    } catch (cause) {
      if (disposed) {
        return;
      }
      const publicError = toExternalSourcePublicError("completion", cause);
      if (publicError === null) {
        update({
          items: restoreCompleteItemsOnFailure ? lastCompleteItems : state.items,
          isComplete: restoreCompleteItemsOnFailure || state.isComplete,
          completingKeys: withoutCompletingKey(serialized),
          completionErrors: withoutCompletionError(serialized)
        });
        return;
      }
      update({
          items: restoreCompleteItemsOnFailure ? lastCompleteItems : state.items,
          isComplete: restoreCompleteItemsOnFailure || state.isComplete,
        completingKeys: withoutCompletingKey(serialized),
        completionErrors: {
          ...state.completionErrors,
          [serialized]: publicError
        }
      });
      throw new Error(publicError);
    }
  }

  function complete(key: ExternalBulletKey): Promise<void> {
    if (disposed) {
      return Promise.resolve();
    }

    let serialized: string;
    try {
      serialized = serializeExternalBulletKey(key);
    } catch {
      return Promise.reject(new Error(EXTERNAL_SOURCE_COMPLETION_ERROR));
    }
    const running = completionInflight.get(serialized);
    if (running) {
      return running.promise;
    }

    const controller = new AbortController();
    let resolveRequest!: () => void;
    let rejectRequest!: (reason: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const completion = { controller, promise };
    completionInflight.set(serialized, completion);
    void completeOnce(key, serialized, controller).then(
      () => {
        completionInflight.delete(serialized);
        resolveRequest();
      },
      (reason) => {
        completionInflight.delete(serialized);
        rejectRequest(reason);
      }
    );
    return promise;
  }

  function acquire(): () => void {
    if (disposed) {
      return () => undefined;
    }
    leases += 1;
    if (leases === 1) {
      void refresh().catch(() => undefined);
      if (!disposed) {
        timer = setInterval(() => {
          void refresh().catch(() => undefined);
        }, pollIntervalMs);
      }
    }

    let released = false;
    return () => {
      if (released || disposed) {
        return;
      }
      released = true;
      leases -= 1;
      if (leases === 0) {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
        cancelRequest(false);
      }
    };
  }

  return {
    getState: () => state,
    subscribe(listener) {
      if (disposed) {
        return () => undefined;
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    acquire,
    refresh,
    complete,
    dispose() {
      if (disposed) {
        return;
      }
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      cancelRequest(true);
      disposed = true;
      completionInflight.forEach(({ controller }) => controller.abort());
      listeners.clear();
      leases = 0;
    }
  };
}
