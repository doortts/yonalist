import type { ExternalSourceProvider } from "../domain/externalSources";
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
  readonly loading: boolean;
  readonly error: string | null;
  readonly syncedAt: string | null;
  readonly completingKeys: ReadonlySet<string>;
  readonly completionErrors: Readonly<Record<string, string>>;
}

export interface ExternalSourceHandle<T> {
  getState(): ExternalSourceState<T>;
  subscribe(listener: () => void): () => void;
  acquire(): () => void;
  refresh(): Promise<void>;
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
  const listeners = new Set<() => void>();
  const pollIntervalMs = options.pollIntervalMs ?? 60_000;
  const now = options.now ?? (() => new Date());
  let lastCompleteItems = cached?.items ?? [];
  let state: ExternalSourceState<T> = {
    items: lastCompleteItems,
    loaded: cached !== null,
    loading: false,
    error: null,
    syncedAt: cached?.syncedAt ?? null,
    completingKeys: emptyCompletingKeys,
    completionErrors: emptyCompletionErrors
  };
  let leases = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let generation = 0;
  let activeRequest: ActiveRequest | null = null;
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
    if (!activeRequest) {
      return;
    }
    generation += 1;
    activeRequest.controller.abort();
    activeRequest = null;
    if (!keepState) {
      update({ loading: false });
    }
  }

  function refresh(): Promise<void> {
    if (disposed) {
      return Promise.resolve();
    }
    if (activeRequest) {
      return activeRequest.promise;
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
            update({ items, loading: true });
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
            update({ loading: false });
            return;
          }
          update({ loading: false, error: publicError });
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
      listeners.clear();
      leases = 0;
    }
  };
}
