import { describe, expect, it } from "vitest";

import { projectOutlinePrefix } from "./outlinePrefix";

describe("projectOutlinePrefix", () => {
  it("bounds the mounted prefix from viewport height and quantized scroll", () => {
    expect(projectOutlinePrefix(5_001, 685, 0)).toEqual({
      limit: 25,
      tailHeight: 139_328,
    });
    expect(projectOutlinePrefix(5_001, 685, 1_000).limit).toBe(65);
    expect(projectOutlinePrefix(101, 280, 1_400).limit).toBe(66);
    expect(projectOutlinePrefix(101, 280, 700).limit).toBe(42);
    expect(projectOutlinePrefix(101, 280, -40).limit).toBe(10);
  });

  it("keeps a forced target mounted and caps the prefix at the row count", () => {
    expect(projectOutlinePrefix(101, 280, 0, 71).limit).toBe(71);
    expect(projectOutlinePrefix(10, 685, 99_999)).toEqual({
      limit: 10,
      tailHeight: 0,
    });
  });
});
