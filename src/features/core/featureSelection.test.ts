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

  it("falls back to Inbox when the saved feature is invalid", () => {
    window.localStorage.setItem(activeFeatureStorageKey, "remote-plugin");

    expect(loadActiveFeature()).toBe("inbox");
  });

  it("falls back to Inbox when no feature has been saved", () => {
    expect(loadActiveFeature()).toBe("inbox");
  });

  it("persists and reloads a valid feature selection", () => {
    persistActiveFeature("notes");

    expect(window.localStorage.getItem(activeFeatureStorageKey)).toBe("notes");
    expect(loadActiveFeature()).toBe("notes");
  });

  it("recognizes only the compiled feature identifiers", () => {
    expect(isFeatureId("inbox")).toBe(true);
    expect(isFeatureId("notes")).toBe(true);
    expect(isFeatureId("settings")).toBe(true);
    expect(isFeatureId("remote-plugin")).toBe(false);
  });
});
