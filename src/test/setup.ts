import "@testing-library/jest-dom/vitest";

// jsdom does not implement PointerEvent; the pane resizer relies on it.
if (typeof window !== "undefined" && !window.PointerEvent) {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
      this.isPrimary = init.isPrimary ?? true;
    }
  }

  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}
