import { type RefObject, useEffect } from "react";
import {
  captureDetailRenderSnapshotHtml,
  setDetailRenderSnapshot
} from "../services/detailRenderCache";

const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 150;

interface UseDetailRenderSnapshotCaptureOptions {
  rootRef: RefObject<HTMLDivElement | null>;
  detailKey: string | null;
  enabled: boolean;
  debounceMs?: number;
}

/**
 * Captures a serialized HTML snapshot of the detail pane so the next visit to
 * the same key can paint a placeholder instantly. A single capture is a deep
 * `cloneNode` + whitespace strip + `innerHTML` serialize of the whole pane, so
 * a burst of DOM mutations (e.g. authenticated image `src` swaps) is coalesced
 * behind a trailing debounce rather than serializing on every callback.
 */
export function useDetailRenderSnapshotCapture({
  rootRef,
  detailKey,
  enabled,
  debounceMs = DEFAULT_SNAPSHOT_DEBOUNCE_MS
}: UseDetailRenderSnapshotCaptureOptions): void {
  useEffect(() => {
    if (!detailKey || !enabled) {
      return;
    }
    const root = rootRef.current;
    if (!root) {
      return;
    }

    let timer: number | undefined;

    const capture = () => {
      const html = captureDetailRenderSnapshotHtml(root);
      if (html) {
        setDetailRenderSnapshot(detailKey, {
          html,
          capturedAt: new Date().toISOString()
        });
      }
    };

    const scheduleCapture = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(capture, debounceMs);
    };

    // Arm the initial capture on the trailing edge too. Snapshots are only read
    // on the NEXT visit to this key, so landing at `debounceMs` instead of 0 is
    // immaterial while still coalescing the render's own mutation burst.
    scheduleCapture();

    const observer =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(scheduleCapture);
    observer?.observe(root, {
      attributeFilter: ["src"],
      attributes: true,
      childList: true,
      subtree: true
    });

    return () => {
      // Only cancel here — do NOT flush the pending capture. Cleanup runs after
      // the NEXT render commits, so the pane may already display a different
      // detail; flushing would store that content under this (old) key. Losing
      // the final <debounceMs of mutations costs at most one image in what is
      // itself a transient placeholder snapshot.
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      observer?.disconnect();
    };
  }, [detailKey, enabled, debounceMs, rootRef]);
}
