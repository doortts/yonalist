import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  defaultPaneWidths,
  paneWidthLimits,
  usePaneResize
} from "./usePaneResize";

describe("usePaneResize", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("uses the unified navigation width contract and clamps persisted widths", () => {
    window.localStorage.setItem(
      "yonalist.paneWidths.v1",
      JSON.stringify({ sidebar: 9_999, list: 1 })
    );

    const { result } = renderHook(() => usePaneResize());

    expect(defaultPaneWidths.sidebar).toBe(336);
    expect(paneWidthLimits.sidebar).toEqual({ min: 320, max: 480 });
    expect(result.current.paneWidths).toEqual({ sidebar: 480, list: 320 });
  });
});
