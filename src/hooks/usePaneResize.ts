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
  sidebar: 336,
  list: 340
};

export const paneWidthLimits: Record<ResizablePane, { min: number; max: number }> = {
  sidebar: { min: 320, max: 480 },
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
      list: false
    };
  } catch {
    return defaultPaneCollapsed;
  }
}

function persistPaneCollapsed(collapsed: PaneCollapsed) {
  try {
    window.localStorage.setItem(
      paneCollapsedStorageKey,
      JSON.stringify({ ...collapsed, list: false })
    );
  } catch {
    // Collapsing remains available even when stored preferences are unavailable.
  }
}

export function usePaneResize() {
  const [paneWidths, setPaneWidths] = useState<PaneWidths>(() => loadPaneWidths());
  const [paneCollapsed, setPaneCollapsed] = useState<PaneCollapsed>(() =>
    loadPaneCollapsed()
  );
  // Whether the detail pane is maximized (both siblings hidden). Memory-only:
  // the collapse booleans themselves persist under their own key, so a reload
  // lands on the collapsed layout without carrying this transient flag.
  const [detailMaximized, setDetailMaximized] = useState(false);
  const paneWidthsRef = useRef(paneWidths);
  paneWidthsRef.current = paneWidths;
  const paneCollapsedRef = useRef(paneCollapsed);
  paneCollapsedRef.current = paneCollapsed;
  const detailMaximizedRef = useRef(detailMaximized);
  detailMaximizedRef.current = detailMaximized;
  // Collapse layout captured when entering the maximized view and replayed on
  // exit, so un-maximizing returns to exactly what the user had before.
  const maximizeSnapshotRef = useRef<PaneCollapsed | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  useEffect(() => {
    persistPaneCollapsed(paneCollapsed);
  }, [paneCollapsed]);

  const togglePaneCollapsed = useCallback((pane: ResizablePane) => {
    // A manual pane toggle takes over from the maximized view: drop the flag
    // and its snapshot so the layout reflects exactly what the user set.
    maximizeSnapshotRef.current = null;
    setDetailMaximized(false);
    setPaneCollapsed((current) => ({
      ...current,
      [pane]: !current[pane],
      list: false
    }));
  }, []);

  const toggleDetailMaximized = useCallback(() => {
    if (detailMaximizedRef.current) {
      // Exit: restore whatever was collapsed before maximizing.
      setPaneCollapsed(maximizeSnapshotRef.current ?? defaultPaneCollapsed);
      maximizeSnapshotRef.current = null;
      setDetailMaximized(false);
    } else {
      // Enter: remember the current collapse layout, then hide both siblings.
      maximizeSnapshotRef.current = paneCollapsedRef.current;
      setPaneCollapsed({ sidebar: true, list: true });
      setDetailMaximized(true);
    }
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
    detailMaximized,
    togglePaneCollapsed,
    toggleDetailMaximized,
    startResize,
    resizeWithKeyboard
  };
}
