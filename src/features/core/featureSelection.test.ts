import { beforeEach, describe, expect, it } from "vitest";
import {
  activeFeatureStorageKey,
  isFeatureId,
  loadActiveFeature,
  persistActiveFeature
} from "./featureSelection";

describe("feature selection", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it.each([null, "inbox", "remote-plugin"])(
    "loads Yonalist for an absent or invalid saved feature: %s",
    (stored) => {
      if (stored !== null) {
        window.localStorage.setItem(activeFeatureStorageKey, stored);
      }

      expect(loadActiveFeature()).toBe("notes");
    }
  );

  it("persists and reloads a valid feature selection", () => {
    persistActiveFeature("notes");

    expect(window.localStorage.getItem(activeFeatureStorageKey)).toBe("notes");
    expect(loadActiveFeature()).toBe("notes");
  });

  it("recognizes only the compiled feature identifiers", () => {
    expect(isFeatureId("notes")).toBe(true);
    expect(isFeatureId("settings")).toBe(true);
    expect(isFeatureId("inbox")).toBe(false);
    expect(isFeatureId("remote-plugin")).toBe(false);
  });
});
