import { useCallback, useEffect, useSyncExternalStore } from "react";
import type {
  ExternalSourceHandle,
  ExternalSourceState
} from "../services/externalSourceHost";

const emptyState: ExternalSourceState<never> = {
  items: [],
  loaded: false,
  isComplete: true,
  loading: false,
  error: null,
  syncedAt: null,
  completionVersion: 0,
  completingKeys: new Set(),
  completionErrors: Object.freeze({})
};

export function useExternalSource<T>(
  handle: ExternalSourceHandle<T> | null,
  enabled: boolean
): ExternalSourceState<T> {
  const subscribe = useCallback(
    (listener: () => void) => handle?.subscribe(listener) ?? (() => undefined),
    [handle]
  );
  const getSnapshot = useCallback(
    () => handle?.getState() ?? (emptyState as ExternalSourceState<T>),
    [handle]
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (handle && enabled) {
      return handle.acquire();
    }
  }, [enabled, handle]);

  return state;
}
