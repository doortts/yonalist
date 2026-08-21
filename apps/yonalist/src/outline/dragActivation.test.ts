import { describe, expect, it } from "vitest";
import { activationDistance } from "./dragActivation";

describe("activationDistance", () => {
  it("keeps a pointer's own precision, which is a pixel or two", () => {
    expect(activationDistance("mouse")).toBe(4);
    expect(activationDistance("pen")).toBe(4);
  });

  it("asks a finger to travel further, because a finger wobbles while it taps", () => {
    expect(activationDistance("touch")).toBeGreaterThan(activationDistance("mouse"));
  });

  it("stays under what a person means by a swipe, so a drag still starts early", () => {
    expect(activationDistance("touch")).toBeLessThanOrEqual(12);
  });

  it("treats an unnamed pointer as the precise kind, which is what it was before", () => {
    expect(activationDistance("")).toBe(4);
    expect(activationDistance(undefined)).toBe(4);
  });
});
