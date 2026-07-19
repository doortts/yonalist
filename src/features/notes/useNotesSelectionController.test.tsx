import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useNotesSelectionState } from "./useNotesSelectionController";

describe("useNotesSelectionState", () => {
  it("lets an event handler anchor and extend synchronously", () => {
    const { result } = renderHook(() => useNotesSelectionState());

    act(() => {
      result.current.setSelectionAnchor("a");
      result.current.extendSelectionTo("c");
    });

    expect(result.current.selection).toEqual({ anchorId: "a", headId: "c" });
    expect(result.current.getSelectionSnapshot()).toEqual({
      selection: { anchorId: "a", headId: "c" },
      revision: 2
    });
  });

  it("rejects a stale expected revision without changing selection", () => {
    const { result } = renderHook(() => useNotesSelectionState());

    act(() => result.current.setSelectionAnchor("a"));
    let replaced = true;
    act(() => {
      replaced = result.current.replaceSelection(
        { anchorId: "b", headId: "b" },
        0
      );
    });

    expect(replaced).toBe(false);
    expect(result.current.getSelectionSnapshot()).toEqual({
      selection: { anchorId: "a", headId: "a" },
      revision: 1
    });
  });
});
