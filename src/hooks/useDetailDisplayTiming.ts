import { useCallback, useEffect, useRef, useState } from "react";

interface DetailDisplayTiming {
  detailDisplayDurationMs: number | null;
  startDetailTransition: (startedAt?: number) => void;
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function requestPaint(callback: FrameRequestCallback): number {
  if (typeof window !== "undefined" && window.requestAnimationFrame) {
    return window.requestAnimationFrame(callback);
  }
  return window.setTimeout(() => callback(now()), 0);
}

function cancelPaint(id: number) {
  if (typeof window !== "undefined" && window.cancelAnimationFrame) {
    window.cancelAnimationFrame(id);
    return;
  }
  window.clearTimeout(id);
}

export function useDetailDisplayTiming(
  activeDetailKey: string | null,
  detailReady: boolean
): DetailDisplayTiming {
  const [detailDisplayDurationMs, setDetailDisplayDurationMs] =
    useState<number | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const activeDetailKeyRef = useRef(activeDetailKey);
  const detailReadyRef = useRef(detailReady);

  const clearScheduledFrame = useCallback(() => {
    if (frameRef.current === null) {
      return;
    }
    cancelPaint(frameRef.current);
    frameRef.current = null;
  }, []);

  useEffect(() => {
    activeDetailKeyRef.current = activeDetailKey;
    detailReadyRef.current = detailReady;
  }, [activeDetailKey, detailReady]);

  const schedulePaintMeasurement = useCallback(() => {
    if (
      !activeDetailKeyRef.current ||
      !detailReadyRef.current ||
      startedAtRef.current === null
    ) {
      return;
    }
    clearScheduledFrame();
    frameRef.current = requestPaint(() => {
      const startedAt = startedAtRef.current;
      frameRef.current = null;
      if (startedAt === null) {
        return;
      }
      setDetailDisplayDurationMs(now() - startedAt);
      startedAtRef.current = null;
    });
  }, [clearScheduledFrame]);

  const startDetailTransition = useCallback(
    (startedAt = now()) => {
      clearScheduledFrame();
      startedAtRef.current = startedAt;
      setDetailDisplayDurationMs(null);
      schedulePaintMeasurement();
    },
    [clearScheduledFrame, schedulePaintMeasurement]
  );

  useEffect(() => {
    clearScheduledFrame();
    if (!activeDetailKey) {
      startedAtRef.current = null;
      setDetailDisplayDurationMs(null);
      return;
    }
    if (startedAtRef.current === null) {
      startedAtRef.current = now();
    }
    setDetailDisplayDurationMs(null);
    schedulePaintMeasurement();
  }, [activeDetailKey, clearScheduledFrame, schedulePaintMeasurement]);

  useEffect(() => {
    schedulePaintMeasurement();
    return clearScheduledFrame;
  }, [activeDetailKey, clearScheduledFrame, detailReady, schedulePaintMeasurement]);

  useEffect(() => clearScheduledFrame, [clearScheduledFrame]);

  return { detailDisplayDurationMs, startDetailTransition };
}
