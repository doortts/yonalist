import { useCallback, useEffect, useRef } from "react";

interface ScheduledFrame {
  readonly handle: number;
  readonly kind: "animation" | "timeout";
}

export function useNotesFrameReconciler<T>(
  reconcile: (pending: T) => void,
): {
  readonly enqueue: (pending: T) => void;
  readonly cancel: () => void;
} {
  const pendingRef = useRef<T | null>(null);
  const scheduledRef = useRef<ScheduledFrame | null>(null);
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;

  const cancel = useCallback((): void => {
    pendingRef.current = null;
    const scheduled = scheduledRef.current;
    scheduledRef.current = null;
    if (!scheduled) return;
    if (
      scheduled.kind === "animation" &&
      typeof cancelAnimationFrame === "function"
    ) {
      cancelAnimationFrame(scheduled.handle);
      return;
    }
    if (scheduled.kind === "timeout") {
      clearTimeout(scheduled.handle);
    }
  }, []);

  const enqueue = useCallback((pending: T): void => {
    pendingRef.current = pending;
    if (scheduledRef.current !== null) return;

    const flush = () => {
      scheduledRef.current = null;
      const latest = pendingRef.current;
      pendingRef.current = null;
      if (latest !== null) {
        reconcileRef.current(latest);
      }
    };
    if (typeof requestAnimationFrame === "function") {
      scheduledRef.current = {
        handle: requestAnimationFrame(flush),
        kind: "animation",
      };
    } else {
      scheduledRef.current = {
        handle: setTimeout(flush, 0) as unknown as number,
        kind: "timeout",
      };
    }
  }, []);

  useEffect(
    () => () => {
      cancel();
    },
    [cancel],
  );

  return { enqueue, cancel };
}
