import type { Modifier } from "@dnd-kit/core";
import { describe, expect, it } from "vitest";
import { offsetNotesDragOverlayFromPointer } from "./notesDragOverlay";

function modifierArgs(activatorEvent: Event | null): Parameters<Modifier>[0] {
  return {
    activatorEvent,
    active: null,
    activeNodeRect: {
      width: 200,
      height: 28,
      top: 40,
      left: 120,
      right: 320,
      bottom: 68
    },
    draggingNodeRect: null,
    containerNodeRect: null,
    over: null,
    overlayNodeRect: null,
    scrollableAncestors: [],
    scrollableAncestorRects: [],
    transform: { x: 45, y: 30, scaleX: 1, scaleY: 1 },
    windowRect: null
  };
}

describe("offsetNotesDragOverlayFromPointer", () => {
  it("places the overlay top-left 16 px below-right of the current pointer", () => {
    const activation = new MouseEvent("pointerdown", {
      clientX: 130,
      clientY: 50
    });

    expect(offsetNotesDragOverlayFromPointer(modifierArgs(activation))).toEqual({
      x: 71,
      y: 56,
      scaleX: 1,
      scaleY: 1
    });
  });

  it("keeps keyboard overlay positioning unchanged", () => {
    expect(
      offsetNotesDragOverlayFromPointer(
        modifierArgs(new KeyboardEvent("keydown", { key: " " }))
      )
    ).toEqual({ x: 45, y: 30, scaleX: 1, scaleY: 1 });
  });
});
