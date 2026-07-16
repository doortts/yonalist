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
  sidebar: 240,
  list: 340
};

export const paneWidthLimits: Record<ResizablePane, { min: number; max: number }> = {
  sidebar: { min: 220, max: 420 },
  list: { min: 320, max: 640 }
};

export interface PaneCollapsed {
  sidebar: boolean;
  list: boolean;
}

export interface EffectivePaneGeometry {
  widths: PaneWidths;
  maxWidths: PaneWidths;
}

const defaultPaneCollapsed: PaneCollapsed = {
  sidebar: false,
  list: false
};

const paneWidthStorageKey = "yonalist.paneWidths.v1";
const paneCollapsedStorageKey = "yonalist.paneCollapsed.v1";
const desktopPaneBreakpoint = 981;
const shellHorizontalInsets = 16;
const paneSeparatorWidth = 1;
const detailMinimumWidth = 320;

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

export function getEffectivePaneGeometry(
  requested: PaneWidths,
  viewportWidth: number,
  collapsed: PaneCollapsed
): EffectivePaneGeometry {
  const unconstrained = {
    widths: {
      sidebar: collapsed.sidebar ? 0 : requested.sidebar,
      list: collapsed.list ? 0 : requested.list
    },
    maxWidths: {
      sidebar: collapsed.sidebar ? 0 : paneWidthLimits.sidebar.max,
      list: collapsed.list ? 0 : paneWidthLimits.list.max
    }
  };

  if (viewportWidth < desktopPaneBreakpoint) {
    return unconstrained;
  }

  const visiblePaneCount = Number(!collapsed.sidebar) + Number(!collapsed.list);
  const availableWidth = Math.max(
    0,
    viewportWidth -
      shellHorizontalInsets -
      visiblePaneCount * paneSeparatorWidth -
      detailMinimumWidth
  );

  if (collapsed.sidebar && collapsed.list) {
    return unconstrained;
  }
  if (collapsed.sidebar) {
    const listMax = Math.min(paneWidthLimits.list.max, availableWidth);
    return {
      widths: { sidebar: 0, list: Math.min(requested.list, listMax) },
      maxWidths: { sidebar: 0, list: listMax }
    };
  }
  if (collapsed.list) {
    const sidebarMax = Math.min(paneWidthLimits.sidebar.max, availableWidth);
    return {
      widths: {
        sidebar: Math.min(requested.sidebar, sidebarMax),
        list: 0
      },
      maxWidths: { sidebar: sidebarMax, list: 0 }
    };
  }

  const sidebarMax = Math.max(
    0,
    Math.min(
      paneWidthLimits.sidebar.max,
      availableWidth - paneWidthLimits.list.min
    )
  );
  const sidebar = Math.min(requested.sidebar, sidebarMax);
  const listMax = Math.max(
    0,
    Math.min(paneWidthLimits.list.max, availableWidth - sidebar)
  );
  const list = Math.min(requested.list, Math.max(0, availableWidth - sidebar));

  return {
    widths: { sidebar, list },
    maxWidths: { sidebar: sidebarMax, list: listMax }
  };
}

export function usePaneResize() {
  const [requestedPaneWidths, setRequestedPaneWidths] = useState<PaneWidths>(() =>
    loadPaneWidths()
  );
  const [paneCollapsed, setPaneCollapsed] = useState<PaneCollapsed>(() =>
    loadPaneCollapsed()
  );
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  // Whether the detail pane is maximized (both siblings hidden). Memory-only:
  // the collapse booleans themselves persist under their own key, so a reload
  // lands on the collapsed layout without carrying this transient flag.
  const [detailMaximized, setDetailMaximized] = useState(false);
  const paneCollapsedRef = useRef(paneCollapsed);
  paneCollapsedRef.current = paneCollapsed;
  const viewportWidthRef = useRef(viewportWidth);
  viewportWidthRef.current = viewportWidth;
  const paneGeometry = getEffectivePaneGeometry(
    requestedPaneWidths,
    viewportWidth,
    paneCollapsed
  );
  const paneWidthsRef = useRef(paneGeometry.widths);
  paneWidthsRef.current = paneGeometry.widths;
  const detailMaximizedRef = useRef(detailMaximized);
  detailMaximizedRef.current = detailMaximized;
  // Collapse layout captured when entering the maximized view and replayed on
  // exit, so un-maximizing returns to exactly what the user had before.
  const maximizeSnapshotRef = useRef<PaneCollapsed | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  useEffect(() => {
    function handleResize() {
      setViewportWidth(window.innerWidth);
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

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
      [pane]: !current[pane]
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
    setRequestedPaneWidths((current) => {
      const next = {
        ...current,
        [pane]: clampPaneWidth(pane, width)
      };
      return next;
    });
  }, []);

  useEffect(() => {
    persistPaneWidths(requestedPaneWidths);
  }, [requestedPaneWidths]);

  const startResize = useCallback(
    (pane: ResizablePane, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      if (paneCollapsedRef.current[pane]) {
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
      setRequestedPaneWidths((current) => {
        if (paneCollapsedRef.current[pane]) {
          return current;
        }
        const effectiveWidth = getEffectivePaneGeometry(
          current,
          viewportWidthRef.current,
          paneCollapsedRef.current
        ).widths[pane];
        return {
          ...current,
          [pane]: clampPaneWidth(pane, effectiveWidth + step * direction)
        };
      });
    },
    []
  );

  return {
    paneWidths: paneGeometry.widths,
    paneWidthMax: paneGeometry.maxWidths,
    paneCollapsed,
    detailMaximized,
    togglePaneCollapsed,
    toggleDetailMaximized,
    startResize,
    resizeWithKeyboard
  };
}
