import type { PointerEvent } from "react";
import { startNativeWindowDrag } from "../windowDrag";

/**
 * Full-width strip covering the macOS traffic lights plus 10px below them.
 * It drags the window, and every pane reserves the same height outside its
 * scroll container so content never slides underneath.
 */
export function TitleBar() {
  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    void startNativeWindowDrag();
  }

  return (
    <div
      className="app-titlebar"
      data-tauri-drag-region
      aria-label="Window drag region"
      onPointerDown={handlePointerDown}
    />
  );
}
