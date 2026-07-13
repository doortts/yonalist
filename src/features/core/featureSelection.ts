import type { FeatureId } from "./featureTypes";

export const activeFeatureStorageKey = "yonalist.activeFeature.v1";

export function isFeatureId(value: unknown): value is FeatureId {
  return value === "inbox" || value === "notes" || value === "settings";
}

export function loadActiveFeature(): FeatureId {
  try {
    const stored = window.localStorage.getItem(activeFeatureStorageKey);
    return isFeatureId(stored) ? stored : "inbox";
  } catch {
    return "inbox";
  }
}

export function persistActiveFeature(featureId: FeatureId) {
  try {
    window.localStorage.setItem(activeFeatureStorageKey, featureId);
  } catch {
    // Feature selection remains usable when browser storage is unavailable.
  }
}
