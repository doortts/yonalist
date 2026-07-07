import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";

// vitest's jsdom environment ships without a usable localStorage; install a
// functional in-memory implementation shared by all test files.
function createLocalStorageMock(): Storage {
  let store: Record<string, string> = {};
  return {
    get length() {
      return Object.keys(store).length;
    },
    clear() {
      store = {};
    },
    getItem(key: string) {
      return key in store ? store[key] : null;
    },
    key(index: number) {
      return Object.keys(store)[index] ?? null;
    },
    removeItem(key: string) {
      delete store[key];
    },
    setItem(key: string, value: string) {
      store[key] = String(value);
    }
  } as Storage;
}

if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: createLocalStorageMock()
  });
}

beforeEach(() => {
  window.localStorage.clear?.();
});

// Base UI's Avatar resolves image load state with a detached `new Image()`
// whose `onload`/`onerror` jsdom never fires (and `complete` stays false), so
// the component would never mount its <img>. Install a minimal Image that
// synchronously reports a successful load — setting `complete`/`naturalWidth`
// so Base UI's fast path (`if (image.complete) …`) picks it up during its
// layout effect, keeping avatar images observable in the same tick as render
// (as they were before the migration). Tests that need the error branch stub
// their own Image (see Avatar.test.tsx).
if (typeof window !== "undefined") {
  class LoadingImageMock {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    complete = false;
    naturalWidth = 0;
    crossOrigin: string | null = null;
    referrerPolicy = "";
    sizes = "";
    srcset = "";
    private currentSrc = "";

    set src(value: string) {
      this.currentSrc = value;
      if (value) {
        this.complete = true;
        this.naturalWidth = 1;
        this.onload?.();
      }
    }

    get src() {
      return this.currentSrc;
    }
  }

  Object.defineProperty(window, "Image", {
    configurable: true,
    writable: true,
    value: LoadingImageMock
  });
}

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
