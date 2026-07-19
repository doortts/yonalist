import { describe, expect, it, vi } from "vitest";
import {
  beginFeatureActivation,
  finishFeatureActivation
} from "./featureActivationTiming";

describe("feature activation timing", () => {
  it("records start and visible with the same activation id", () => {
    const record = vi.fn();
    const sample = beginFeatureActivation(4, "notes", 120, record);

    finishFeatureActivation(sample, 205, record);

    expect(record).toHaveBeenCalledWith("feature_activation_start", {
      activationId: 4,
      featureId: "notes"
    });
    expect(record).toHaveBeenCalledWith("feature_activation_visible", {
      activationId: 4,
      featureId: "notes",
      durationMs: 85
    });
  });
});
