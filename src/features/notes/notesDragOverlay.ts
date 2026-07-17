import type { Modifier, Modifiers } from "@dnd-kit/core";

export const NOTES_DRAG_OVERLAY_POINTER_GAP_PX = 16;

function pointerCoordinates(
  event: Event | null
): { readonly x: number; readonly y: number } | null {
  if (
    event === null ||
    !("clientX" in event) ||
    !("clientY" in event) ||
    typeof event.clientX !== "number" ||
    typeof event.clientY !== "number"
  ) {
    return null;
  }
  return { x: event.clientX, y: event.clientY };
}

export const offsetNotesDragOverlayFromPointer: Modifier = ({
  activatorEvent,
  activeNodeRect,
  transform
}) => {
  const activation = pointerCoordinates(activatorEvent);
  if (activation === null || activeNodeRect === null) {
    return transform;
  }
  return {
    ...transform,
    x:
      transform.x +
      activation.x -
      activeNodeRect.left +
      NOTES_DRAG_OVERLAY_POINTER_GAP_PX,
    y:
      transform.y +
      activation.y -
      activeNodeRect.top +
      NOTES_DRAG_OVERLAY_POINTER_GAP_PX
  };
};

export const NOTES_DRAG_OVERLAY_MODIFIERS: Modifiers = [
  offsetNotesDragOverlayFromPointer
];
