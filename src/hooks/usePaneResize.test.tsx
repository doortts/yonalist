import { act, renderHook } from "@testing-library/react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultPaneWidths,
  paneWidthLimits,
  usePaneResize
} from "./usePaneResize";

describe("usePaneResize", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("uses the unified navigation default and limits", () => {
    expect(defaultPaneWidths.sidebar).toBe(336);
    expect(paneWidthLimits.sidebar).toEqual({ min: 320, max: 480 });
  });

  it("clamps a stored legacy sidebar width under the existing storage key", () => {
    window.localStorage.setItem(
      "yonalist.paneWidths.v1",
      JSON.stringify({ sidebar: 240, list: 500 })
    );

    const { result } = renderHook(() => usePaneResize());

    expect(result.current.paneWidths).toEqual({ sidebar: 320, list: 500 });
  });

  it("restores a visible Settings list from unsupported persisted collapse", () => {
    window.localStorage.setItem(
      "yonalist.paneCollapsed.v1",
      JSON.stringify({ sidebar: false, list: true })
    );

    const { result } = renderHook(() => usePaneResize());

    expect(result.current.paneCollapsed).toEqual({
      sidebar: false,
      list: false
    });
    expect(window.localStorage.getItem("yonalist.paneCollapsed.v1")).toBe(
      JSON.stringify({ sidebar: false, list: false })
    );
  });

  it("keeps keyboard resizing inside the unified navigation limits", () => {
    const { result } = renderHook(() => usePaneResize());
    const preventDefault = vi.fn();

    act(() => {
      result.current.resizeWithKeyboard(
        "sidebar",
        {
          key: "ArrowRight",
          shiftKey: true,
          preventDefault
        } as unknown as ReactKeyboardEvent<HTMLDivElement>
      );
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(result.current.paneWidths.sidebar).toBe(384);
  });
});
