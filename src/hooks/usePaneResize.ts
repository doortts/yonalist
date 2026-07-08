import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";

export type ResizablePane = "sidebar" | "list";

export interface PaneWidths {
  sidebar: number;
  list: number;
}

export const defaultPaneWidths: PaneWidths = {
  sidebar: 280,
  list: 420
};

export const paneWidthLimits: Record<ResizablePane, { min: number; max: number }> = {
  sidebar: { min: 220, max: 420 },
  list: { min: 320, max: 640 }
};

export interface PaneCollapsed {
  sidebar: boolean;
  list: boolean;
}

const defaultPaneCollapsed: PaneCollapsed = {
  sidebar: false,
  list: false
};

const paneWidthStorageKey = "yonalist.paneWidths.v1";
const paneCollapsedStorageKey = "yonalist.paneCollapsed.v1";

function clampPaneWidth(pane: ResizablePane, width: number): number {
  const limits = paneWidthLimits[pane];
  return Math.min(limits.max, Math.max(limits.min, Math.round(width)));
}

function sanitizePaneWidths(widths: Partial<PaneWidths>): PaneWidths {
  return {
    sidebar: clampPaneWidth("sidebar", widths.sidebar ?? defaultPaneWidths.sidebar),
    list: clampPaneWidth("list", widths.list ?? defaultPaneWidths.list)
  };
}

function loadPaneWidths(): PaneWidths {
  try {
    const stored = window.localStorage.getItem(paneWidthStorageKey);
    if (!stored) {
      return defaultPaneWidths;
    }

    return sanitizePaneWidths(JSON.parse(stored) as Partial<PaneWidths>);
  } catch {
    return defaultPaneWidths;
  }
}

function persistPaneWidths(widths: PaneWidths) {
  try {
    window.localStorage.setItem(paneWidthStorageKey, JSON.stringify(widths));
  } catch {
    // Resizing remains available even when stored preferences are unavailable.
  }
}

function loadPaneCollapsed(): PaneCollapsed {
  try {
    const stored = window.localStorage.getItem(paneCollapsedStorageKey);
    if (!stored) {
      return defaultPaneCollapsed;
    }

    const parsed = JSON.parse(stored) as Partial<PaneCollapsed>;
    return {
      sidebar: parsed.sidebar === true,
      list: parsed.list === true
    };
  } catch {
    return defaultPaneCollapsed;
  }
}

function persistPaneCollapsed(collapsed: PaneCollapsed) {
  try {
    window.localStorage.setItem(paneCollapsedStorageKey, JSON.stringify(collapsed));
  } catch {
    // Collapsing remains available even when stored preferences are unavailable.
  }
}

export function usePaneResize() {
  const [paneWidths, setPaneWidths] = useState<PaneWidths>(() => loadPaneWidths());
  const [paneCollapsed, setPaneCollapsed] = useState<PaneCollapsed>(() =>
    loadPaneCollapsed()
  );
  const paneWidthsRef = useRef(paneWidths);
  paneWidthsRef.current = paneWidths;
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  useEffect(() => {
    persistPaneCollapsed(paneCollapsed);
  }, [paneCollapsed]);

  const togglePaneCollapsed = useCallback((pane: ResizablePane) => {
    setPaneCollapsed((current) => ({
      ...current,
      [pane]: !current[pane]
    }));
  }, []);

  const updatePaneWidth = useCallback((pane: ResizablePane, width: number) => {
    setPaneWidths((current) => {
      const next = {
        ...current,
        [pane]: clampPaneWidth(pane, width)
      };
      return next;
    });
  }, []);

  useEffect(() => {
    persistPaneWidths(paneWidths);
  }, [paneWidths]);

  const startResize = useCallback(
    (pane: ResizablePane, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      cleanupRef.current?.();

      const startX = event.clientX;
      const startWidth = paneWidthsRef.current[pane];
      document.body.classList.add("is-resizing-pane");

      function handlePointerMove(moveEvent: globalThis.PointerEvent) {
        updatePaneWidth(pane, startWidth + moveEvent.clientX - startX);
      }

      function stopResize() {
        document.body.classList.remove("is-resizing-pane");
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", stopResize);
        window.removeEventListener("pointercancel", stopResize);
        cleanupRef.current = null;
      }

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopResize);
      window.addEventListener("pointercancel", stopResize);
      cleanupRef.current = stopResize;
    },
    [updatePaneWidth]
  );

  const resizeWithKeyboard = useCallback(
    (pane: ResizablePane, event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }

      event.preventDefault();
      const step = event.shiftKey ? 48 : 16;
      const direction = event.key === "ArrowRight" ? 1 : -1;
      setPaneWidths((current) => ({
        ...current,
        [pane]: clampPaneWidth(pane, current[pane] + step * direction)
      }));
    },
    []
  );

  return {
    paneWidths,
    paneCollapsed,
    togglePaneCollapsed,
    startResize,
    resizeWithKeyboard
  };
}
