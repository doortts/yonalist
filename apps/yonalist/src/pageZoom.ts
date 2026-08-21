import { useSyncExternalStore } from "react";
import { outlinePlatform } from "./outline/outlineSupport";

// A press moves 5%, small enough that the reader can stop where the text feels
// right instead of picking between two sizes that both miss.
export const STEP = 5;
// Half size to triple: past either end the window's own chrome stops fitting
// what it holds, and there is nothing further to read.
export const MIN_ZOOM_PERCENT = 50;
export const MAX_ZOOM_PERCENT = 300;
const storageKey = "yonalist.pageZoom.v1";

/**
 * Which way a press moves the page, or 0 for a key that is not ours. Shift is
 * allowed through because "+" is Shift+= on most layouts and reads as the same
 * chord; the other primary modifier is somebody else's, the way the rest of the
 * window's shortcuts read it.
 */
export function pageZoomStep(event: KeyboardEvent): number {
  const onMac = outlinePlatform() === "mac";
  const modifier = onMac ? event.metaKey : event.ctrlKey;
  const otherModifier = onMac ? event.ctrlKey : event.metaKey;
  if (!modifier || otherModifier || event.altKey || event.isComposing) return 0;
  if (event.key === "=" || event.key === "+") return STEP;
  if (event.key === "-" || event.key === "_") return -STEP;
  return 0;
}

function loadPercent(): number {
  try {
    const stored = Number(window.localStorage.getItem(storageKey));
    return Number.isInteger(stored) && stored >= MIN_ZOOM_PERCENT && stored <= MAX_ZOOM_PERCENT
      ? stored
      : 100;
  } catch {
    return 100;
  }
}

let percent = loadPercent();
const listeners = new Set<(percent: number) => void>();

function notifyListeners(): void {
  for (const listener of listeners) {
    listener(percent);
  }
}

export function getPageZoom(): number {
  return percent;
}

export function subscribePageZoom(listener: (percent: number) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePageZoom(): number {
  return useSyncExternalStore(subscribePageZoom, getPageZoom);
}

/**
 * Page zoom is scoped to the notes outline / page view area via React state and CSS,
 * so the webview itself remains at 1.0 to keep the sidebar, header, and status bar
 * at standard 100% scale.
 */
async function applyPercent(): Promise<void> {
  // The browser preview has the browser's own zoom, so there is nothing to do.
  if (!("__TAURI_INTERNALS__" in window)) return;
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  await getCurrentWebview().setZoom(1.0);
}

/** Page zoom is restored at startup. */
export function restorePageZoom(): Promise<void> {
  return applyPercent();
}

/** Resets page zoom to 100%. */
export async function resetPageZoom(): Promise<number> {
  if (percent === 100) return percent;
  percent = 100;
  try {
    window.localStorage.setItem(storageKey, String(percent));
  } catch {
    // The size still holds for the session without persistence.
  }
  notifyListeners();
  await applyPercent();
  return percent;
}

/** Answers the size it settled on, which at either end is the one it had. */
export async function nudgePageZoom(step: number): Promise<number> {
  const next = Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, percent + step));
  if (next === percent) return percent;
  percent = next;
  try {
    window.localStorage.setItem(storageKey, String(percent));
  } catch {
    // The size still holds for the session without persistence.
  }
  notifyListeners();
  await applyPercent();
  return percent;
}
