import { describe, expect, it } from "vitest";
import { dragPreviewOffset } from "./dragPreviewOffset";

describe("dragPreviewOffset", () => {
  it("sets the ghost down and right of a pointer, which hides nothing", () => {
    expect(dragPreviewOffset("mouse")).toEqual({ x: 12, y: 12 });
  });

  it("lifts it clear of the finger, which covers what is under it", () => {
    expect(dragPreviewOffset("touch").y).toBeLessThan(0);
  });

  it("keeps it beside the finger too, so the row is not read through it", () => {
    expect(dragPreviewOffset("touch").x).toBeGreaterThan(0);
  });

  it("treats an unnamed pointer as the precise kind", () => {
    expect(dragPreviewOffset(undefined)).toEqual({ x: 12, y: 12 });
  });
});
