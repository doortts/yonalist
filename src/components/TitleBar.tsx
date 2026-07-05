import type { PointerEvent } from "react";
import { startNativeWindowDrag } from "../windowDrag";

/**
 * The sidebar keeps enough drag room for the macOS traffic lights. Content
 * panes get only a slim drag strip so their headers can sit near the top.
 */
export function TitleBar() {
  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    void startNativeWindowDrag();
  }

  return (
    <>
      <div
        className="app-titlebar"
        data-tauri-drag-region
        aria-label="Window drag region"
        onPointerDown={handlePointerDown}
      />
      <div
        className="app-content-drag-strip"
        data-tauri-drag-region
        aria-label="Window drag strip"
        onPointerDown={handlePointerDown}
      />
    </>
  );
}
