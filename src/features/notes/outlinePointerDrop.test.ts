import { describe, expect, it } from "vitest";
import { resolveOutlinePointerBoundary } from "./outlinePointerDrop";

const rows = [
  { id: "a", top: 0, bottom: 28 },
  { id: "c", top: 56, bottom: 84 },
  { id: "d", top: 84, bottom: 112 }
] as const;

describe("resolveOutlinePointerBoundary", () => {
  it.each([
    [-10, { beforeId: "a", overId: "a" }],
    [10, { beforeId: "a", overId: "a" }],
    [42, { beforeId: "c", overId: "c" }],
    [70, { beforeId: "d", overId: "d" }],
    [120, { beforeId: null, overId: "d" }]
  ] as const)("resolves pointer y %s", (pointerY, expected) => {
    expect(resolveOutlinePointerBoundary(pointerY, rows)).toEqual(expected);
  });

  it("returns the sole tail slot when every row is dragged", () => {
    expect(resolveOutlinePointerBoundary(20, [])).toEqual({
      beforeId: null,
      overId: null
    });
  });
});
